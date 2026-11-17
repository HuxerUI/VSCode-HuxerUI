import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { installManagedSdk, isSupportedSdkVersion, managedSdkFolders } from './sdkArchive';
import { buildSourceCli, executableName, isSourceCheckout, sourceCheckouts, sourceCliCandidates } from './sourceSdk';

const execFileAsync = promisify(execFile);

export interface Sdk {
  root: string;
  cli: string;
  type: 'installed' | 'source';
  version: string;
}

// Reuse the inherited spelling to avoid adding a second PATH key on Windows.
const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';

export function sdkEnvironment(sdk: Sdk): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HUXERUI_HOME: sdk.root,
    [pathKey]: [path.dirname(sdk.cli), process.env[pathKey]].filter(Boolean).join(path.delimiter),
  };
}

export async function sdkCommand(sdk: Sdk, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(sdk.cli, args, {
    cwd, env: sdkEnvironment(sdk), timeout: 15_000, windowsHide: true,
  });
  return stdout;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function hasInstalledLayout(root: string): Promise<boolean> {
  const configPath = path.join('cmake', 'HuxerUI', 'HuxerUIConfig.cmake');
  const lib = path.join(root, 'lib');
  const subdirs = await fs.readdir(lib, { withFileTypes: true }).catch(() => []);
  const prefixes = [lib, path.join(root, 'lib64'), path.join(root, 'share'),
    ...subdirs.filter(entry => entry.isDirectory()).map(entry => path.join(lib, entry.name))];
  const share = path.join(root, 'share', 'huxerui');
  return await fileExists(path.join(root, 'include', 'huxerui', 'huxerui.h')) &&
    await fileExists(path.join(share, 'resources', 'huxerui', 'resources.bin')) &&
    await directoryExists(path.join(share, 'tools')) &&
    await directoryExists(path.join(share, 'skills', 'huxerui-app-development')) &&
    (await Promise.all(prefixes.map(prefix => fileExists(path.join(prefix, configPath))))).some(Boolean);
}

export async function inspectSdk(directory: string, sourceCli?: string): Promise<Sdk | undefined> {
  if (!path.isAbsolute(directory) || (sourceCli && !path.isAbsolute(sourceCli))) {
    return undefined;
  }
  try {
    const root = await fs.realpath(directory);
    const type = sourceCli ? 'source' : 'installed';
    const cli = await fs.realpath(sourceCli ?? path.join(root, 'bin', executableName));
    if (type === 'source') {
      if (!await isSourceCheckout(root)) {
        return undefined;
      }
    } else if (!await hasInstalledLayout(root)) {
      return undefined;
    }

    await fs.access(cli, constants.X_OK);
    const sdk: Sdk = { root, cli, type, version: '' };
    const version = /^huxerui\s+(\d+\.\d+\.\d+)\s*$/.exec(await sdkCommand(sdk, ['--version'], root))?.[1];
    // Apply the version floor to published SDKs. A source build can still report the previous release number.
    if (!version || (type === 'installed' && !isSupportedSdkVersion(version))) {
      return undefined;
    }
    sdk.version = version;
    return sdk;
  } catch {
    return undefined;
  }
}

function defaultSdkDirectory(): string | undefined {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Developer', 'HuxerUI');
    case 'linux':
      return path.join(os.homedir(), '.local', 'share', 'HuxerUI');
    case 'win32':
      return process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'HuxerUI');
    default:
      return undefined;
  }
}

function checkTrust(): void {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust this workspace before selecting or executing an SDK.');
  }
}

function configFor(uri?: vscode.Uri): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('huxerui', uri);
}

function projectKey(root?: vscode.Uri): string {
  return 'sdk:' + (root?.toString() ?? 'default');
}

function matchVersion(sdk: Sdk, required: string): boolean {
  // A project version pin refers to the published SDK, even if a checkout reports the same version.
  return !required || (sdk.type === 'installed' && sdk.version === required);
}

interface SourceCandidate {
  root: string;
  configured: boolean;
  sdk?: Sdk;
}

interface SdkCandidates {
  installed: Sdk[];
  sources: SourceCandidate[];
}

export class SdkSelection implements vscode.Disposable {
  private readonly selectionChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeSelection = this.selectionChanged.event;

  constructor(private readonly state: vscode.Memento, private readonly storage: string) {}

  dispose(): void {
    this.selectionChanged.dispose();
  }

  private async discover(root: vscode.Uri | undefined, required: string): Promise<SdkCandidates> {
    checkTrust();
    const config = configFor(root);
    const installed = new Set(config.get<string[]>('sdkPaths', []).filter(entry => typeof entry === 'string'));
    for (const directory of await managedSdkFolders(this.storage)) {
      installed.add(directory);
    }
    if (process.env.HUXERUI_HOME) {
      installed.add(process.env.HUXERUI_HOME);
    }
    for (const directory of (process.env[pathKey] ?? '').split(path.delimiter).filter(path.isAbsolute)) {
      const cli = await fs.realpath(path.join(directory, executableName)).catch(() => undefined);
      if (cli && path.basename(path.dirname(cli)).toLowerCase() === 'bin') {
        installed.add(path.dirname(path.dirname(cli)));
      }
    }

    const standard = defaultSdkDirectory();
    if (standard) {
      installed.add(standard);
      const versionsDirectory = standard + '-versions';
      const versions = await fs.readdir(versionsDirectory, { withFileTypes: true }).catch(() => []);
      for (const version of versions.filter(entry => entry.isDirectory())) {
        installed.add(path.join(versionsDirectory, version.name));
      }
    }

    const candidates = await Promise.all(Array.from(installed, directory => inspectSdk(directory)));
    const matching = candidates.filter((sdk): sdk is Sdk => sdk !== undefined && matchVersion(sdk, required));
    const distinct = Array.from(new Map(matching.map(sdk => [sdk.root, sdk])).values());
    if (required) {
      return { installed: distinct, sources: [] };
    }

    const setting = config.get<string>('sourceCheckout', '');
    const configured = path.isAbsolute(setting) ? await fs.realpath(setting).catch(() => '') : '';
    const cli = config.get<string>('sourceCli', '');
    const roots = await sourceCheckouts(configured, root?.fsPath);
    const sources = await Promise.all(roots.map(async directory => ({
      root: directory,
      configured: directory === configured,
      sdk: await this.findSource(directory, directory === configured ? cli : undefined),
    })));
    return { installed: distinct, sources };
  }

  private async findSource(root: string, explicit?: string): Promise<Sdk | undefined> {
    for (const cli of await sourceCliCandidates(root, this.storage, explicit)) {
      const sdk = await inspectSdk(root, cli);
      if (sdk) {
        return sdk;
      }
    }
    return undefined;
  }

  private async buildSource(root: string): Promise<Sdk> {
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Building the HuxerUI CLI from source',
    }, async () => {
      const cli = await buildSourceCli(root, this.storage);
      const sdk = await inspectSdk(root, cli);
      if (!sdk) {
        throw new Error('The CLI built from ' + root + ' could not be run on this host.');
      }
      return sdk;
    });
  }

  private async download(required: string): Promise<Sdk | undefined> {
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Installing the HuxerUI SDK',
      cancellable: true,
    }, async (progress, token) => {
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      try {
        if (token.isCancellationRequested) {
          return undefined;
        }
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
        return await installManagedSdk(this.storage, required, async (directory, version) => {
          const sdk = await inspectSdk(directory);
          return sdk?.version === version ? sdk : undefined;
        }, signal, message => progress.report({ message }));
      } catch (error) {
        if (!token.isCancellationRequested) {
          throw error;
        }
        return undefined;
      } finally {
        cancellation.dispose();
      }
    });
  }

  async resolve(root?: vscode.Uri, prompt = true): Promise<Sdk | undefined> {
    checkTrust();
    const config = configFor(root);
    const required = config.get<string>('sdkVersion', '').trim();
    const configuredSource = config.get<string>('sourceCheckout', '');
    const saved = this.state.get<Sdk>(projectKey(root)) ??
      (required || configuredSource ? undefined : this.state.get<Sdk>(projectKey()));
    if (saved) {
      const sdk = await inspectSdk(saved.root, saved.type === 'source' ? saved.cli : undefined);
      if (sdk && matchVersion(sdk, required)) {
        return sdk;
      }
    }
    const candidates = await this.discover(root, required);
    const configured = candidates.sources.find(source => source.configured);
    if (configured) {
      if (configured.sdk) {
        return configured.sdk;
      }
      if (prompt) {
        return this.buildSource(configured.root);
      }
      throw new Error('The configured HuxerUI checkout needs a CLI. Run HuxerUI: Select SDK to build it.');
    }
    if (candidates.installed.length === 1) {
      return candidates.installed[0];
    }
    if (!candidates.installed.length) {
      const built = candidates.sources.filter(source => source.sdk);
      if (built.length === 1) {
        return built[0].sdk;
      }
    }
    if (prompt) {
      return this.pickFrom(candidates, root, required);
    }
    throw new Error(required
      ? 'Select a HuxerUI ' + required + ' SDK for this project first.'
      : 'Select a HuxerUI SDK for this project first.');
  }

  async select(root?: vscode.Uri): Promise<Sdk | undefined> {
    const required = configFor(root).get<string>('sdkVersion', '').trim();
    return this.pickFrom(await this.discover(root, required), root, required);
  }

  async save(root: vscode.Uri | undefined, sdk: Sdk): Promise<void> {
    await this.state.update(projectKey(root), sdk);
    this.selectionChanged.fire();
  }

  private async pickFrom(candidates: SdkCandidates, root: vscode.Uri | undefined, required: string): Promise<Sdk | undefined> {
    interface Choice extends vscode.QuickPickItem {
      sdk?: Sdk;
      checkout?: string;
      browse?: 'installed' | 'source';
      download?: boolean;
    }
    const items: Choice[] = [
      ...candidates.installed.map(sdk => ({ label: 'HuxerUI ' + sdk.version, detail: sdk.root, sdk })),
      ...candidates.sources.map(source => ({
        label: source.sdk ? 'Use HuxerUI Source Checkout' : 'Build CLI and Use Source Checkout',
        detail: source.root, sdk: source.sdk, checkout: source.root,
      })),
      { label: required ? 'Download HuxerUI ' + required + ' SDK' : 'Download Latest HuxerUI SDK', download: true },
    ];
    items.push({ label: 'Browse for Installed SDK…', browse: 'installed' });
    if (!required) {
      items.push({ label: 'Browse for Source Checkout…', browse: 'source' });
    }
    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: required ? 'Choose HuxerUI ' + required : 'Choose a HuxerUI 0.5 SDK or current source checkout',
      matchOnDetail: true,
    });
    if (!selection) {
      return undefined;
    }
    let sdk = selection.sdk;
    if (selection.download) {
      sdk = await this.download(required);
      if (!sdk) {
        return undefined;
      }
    } else if (selection.checkout && !sdk) {
      sdk = await this.buildSource(selection.checkout);
    }
    if (selection.browse) {
      const source = selection.browse === 'source';
      const [directory] = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, openLabel: source ? 'Select Source Checkout' : 'Select SDK',
      }) ?? [];
      if (!directory) {
        return undefined;
      }
      if (source) {
        if (!await isSourceCheckout(directory.fsPath)) {
          throw new Error('Choose the root of a HuxerUI source checkout.');
        }
        const checkout = await fs.realpath(directory.fsPath);
        sdk = await this.findSource(checkout);
        if (!sdk) {
          const action = await vscode.window.showInformationMessage(
            'No built HuxerUI CLI was found in this checkout.', 'Build CLI', 'Choose Existing CLI…');
          if (action === 'Build CLI') {
            sdk = await this.buildSource(checkout);
          } else if (action === 'Choose Existing CLI…') {
            const [cli] = await vscode.window.showOpenDialog({
              canSelectFiles: true, canSelectFolders: false, openLabel: 'Select CLI Built from This Checkout',
              defaultUri: directory,
            }) ?? [];
            if (!cli) {
              return undefined;
            }
            sdk = await inspectSdk(checkout, cli.fsPath);
          } else {
            return undefined;
          }
        }
      } else {
        sdk = await inspectSdk(directory.fsPath);
      }
    }
    if (!sdk || !matchVersion(sdk, required)) {
      throw new Error(required
        ? 'Select a complete HuxerUI ' + required + ' SDK for this host.'
        : 'Select a complete HuxerUI 0.5 SDK for this host, or a checkout with its built CLI.');
    }
    await this.save(root, sdk);
    return sdk;
  }
}
