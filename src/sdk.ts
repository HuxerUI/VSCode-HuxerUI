import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);
const executableName = process.platform === 'win32' ? 'huxerui.exe' : 'huxerui';

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
      if (!await fileExists(path.join(root, 'cmake', 'HuxerUIApp.cmake')) ||
          !await fileExists(path.join(root, 'include', 'huxerui', 'huxerui.h')) ||
          !await directoryExists(path.join(root, 'tools', 'prebuilt'))) {
        return undefined;
      }
    } else if (!await hasInstalledLayout(root)) {
      return undefined;
    }

    await fs.access(cli, constants.X_OK);
    const sdk: Sdk = { root, cli, type, version: '' };
    const version = /^huxerui\s+((\d+)\.(\d+)\.\d+)\s*$/.exec(await sdkCommand(sdk, ['--version'], root));
    // Apply the version floor to published SDKs. A source build can still report the previous release number.
    if (!version || (type === 'installed' && Number(version[2]) === 0 && Number(version[3]) < 5)) {
      return undefined;
    }
    sdk.version = version[1];
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

export class SdkSelection {
  constructor(private readonly state: vscode.Memento) {}

  private async discover(root?: vscode.Uri): Promise<Sdk[]> {
    checkTrust();
    const config = configFor(root);
    const installed = new Set(config.get<string[]>('sdkPaths', []).filter(entry => typeof entry === 'string'));
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

    const checkout = config.get<string>('sourceCheckout', '');
    const checkoutCli = config.get<string>('sourceCli', '');
    const candidates = await Promise.all([
      ...Array.from(installed, root => inspectSdk(root)),
      checkout && checkoutCli ? inspectSdk(checkout, checkoutCli) : undefined,
    ]);
    return Array.from(new Map(candidates.filter(sdk => sdk !== undefined)
      .map(sdk => [sdk.root + '\0' + sdk.cli, sdk])).values());
  }

  async resolve(root?: vscode.Uri, prompt = true): Promise<Sdk | undefined> {
    checkTrust();
    const required = configFor(root).get<string>('sdkVersion', '').trim();
    const saved = this.state.get<Sdk>(projectKey(root));
    if (saved) {
      const sdk = await inspectSdk(saved.root, saved.type === 'source' ? saved.cli : undefined);
      if (sdk && matchVersion(sdk, required)) {
        return sdk;
      }
    }
    const candidates = (await this.discover(root)).filter(sdk => matchVersion(sdk, required));
    if (candidates.length === 1) {
      return candidates[0];
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
    return this.pickFrom((await this.discover(root)).filter(sdk => matchVersion(sdk, required)), root, required);
  }

  async save(root: vscode.Uri | undefined, sdk: Sdk): Promise<void> {
    await this.state.update(projectKey(root), sdk);
  }

  private async pickFrom(candidates: Sdk[], root: vscode.Uri | undefined, required: string): Promise<Sdk | undefined> {
    interface Choice extends vscode.QuickPickItem {
      sdk?: Sdk;
      browse?: 'installed' | 'source';
      releases?: boolean;
    }
    const items: Choice[] = candidates.map(sdk => ({
      label: sdk.type === 'source' ? 'HuxerUI source checkout' : 'HuxerUI ' + sdk.version,
      description: sdk.type,
      detail: sdk.root,
      sdk,
    }));
    items.push({ label: 'Browse for Installed SDK…', browse: 'installed' });
    if (!required) {
      items.push({ label: 'Browse for Source Checkout…', browse: 'source' });
    }
    items.push({ label: 'Open HuxerUI Releases…', releases: true });
    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: required ? 'Choose HuxerUI ' + required : 'Choose a HuxerUI 0.5 SDK or current source checkout',
      matchOnDetail: true,
    });
    if (!selection) {
      return undefined;
    }
    if (selection.releases) {
      await vscode.env.openExternal(vscode.Uri.parse('https://github.com/HuxerUI/HuxerUI/releases'));
      return undefined;
    }
    let sdk = selection.sdk;
    if (selection.browse) {
      const source = selection.browse === 'source';
      const [directory] = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, openLabel: source ? 'Select Source Checkout' : 'Select SDK',
      }) ?? [];
      if (!directory) {
        return undefined;
      }
      let cli: vscode.Uri | undefined;
      if (source) {
        [cli] = await vscode.window.showOpenDialog({
          canSelectFiles: true, canSelectFolders: false, openLabel: 'Select CLI Built from This Checkout',
          defaultUri: directory,
        }) ?? [];
        if (!cli) {
          return undefined;
        }
      }
      sdk = await inspectSdk(directory.fsPath, cli?.fsPath);
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
