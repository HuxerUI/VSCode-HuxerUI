import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { readAbis } from './abi';
import { isMobile } from './devices';
import { mobileDebugProjects, prepareMobileDebug } from './mobileDebug';
import { canBuild, hostTarget, inspectProjects, isTarget, Project, selectProject, Target } from './projects';
import { sdkEnvironment, SdkSelection } from './sdk';
import { HuxerTasks } from './tasks';
import { prepareToolchain } from './toolchain';

const debuggers = {
  macos: { extension: 'vadimcn.vscode-lldb', name: 'CodeLLDB', type: 'lldb', platform: 'macOS' },
  windows: { extension: 'ms-vscode.cpptools', name: 'Microsoft C/C++', type: 'cppvsdbg', platform: 'Windows' },
  linux: { extension: 'ms-vscode.cpptools', name: 'Microsoft C/C++', type: 'cppdbg', platform: 'Linux' },
};
type DebugTarget = keyof typeof debuggers;
type DeviceOptions = { device?: string; abis?: string[] };

const debugType = 'huxerui';
const targetLabels: Record<Target, string> = {
  windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android', ios: 'iOS Simulator', web: 'Web',
};

const starting = new Set<string>();

export function debugTargets(project: Project): Target[] {
  return project.buildSystem === 'cmake' ? project.platforms.filter(target =>
    target === hostTarget || (isMobile(target) && canBuild(target))) : [];
}

function cacheValue(cache: string, key: string): string | undefined {
  return new RegExp('^' + key + ':[^=]+=(.*)$', 'm').exec(cache)?.[1];
}

async function findGdb(): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)) {
    const program = path.join(directory, 'gdb');
    try {
      if ((await fs.stat(program)).isFile()) {
        await fs.access(program, constants.X_OK);
        return program;
      }
    } catch {
      // A later PATH entry may contain an executable GDB.
    }
  }
  return undefined;
}

async function findDebugApp(projectRoot: string, sdkRoot: string, target: DebugTarget): Promise<{
  program: string;
  name: string;
  sourceDirectory: string;
  realProjectRoot: string;
}> {
  const [realProjectRoot, realSdkRoot] = await Promise.all([fs.realpath(projectRoot), fs.realpath(sdkRoot)]);
  const buildRoot = path.join(projectRoot, '.huxerui', 'build');
  const builds = await fs.readdir(buildRoot, { withFileTypes: true }).catch(() => []);
  const matching: { directory: string; sourceDirectory: string }[] = [];

  // CMake records the SDK and source directory, so the extension need not reproduce the CLI's directory hash.
  for (const entry of builds.filter(entry => entry.isDirectory() && entry.name.startsWith('home-'))) {
    const directory = path.join(buildRoot, entry.name, target, 'debug');
    const cache = await fs.readFile(path.join(directory, 'CMakeCache.txt'), 'utf8').catch(() => '');
    const sourceDirectory = cacheValue(cache, 'CMAKE_HOME_DIRECTORY');
    const sdkDirectory = cacheValue(cache, 'HUXERUI_HOME');
    if (sourceDirectory && sdkDirectory && cacheValue(cache, 'CMAKE_BUILD_TYPE') === 'Debug') {
      const [source, sdk] = await Promise.all([
        fs.realpath(sourceDirectory).catch(() => undefined),
        fs.realpath(sdkDirectory).catch(() => undefined),
      ]);
      if (source === realProjectRoot && sdk === realSdkRoot) {
        matching.push({ directory, sourceDirectory });
      }
    }
  }
  if (matching.length !== 1) {
    throw new Error(matching.length
      ? 'Multiple Debug build directories match this project and SDK. Keep one matching build directory.'
      : 'Could not find a Debug build directory for the selected project and SDK.');
  }

  const { directory, sourceDirectory } = matching[0];
  const integration = path.join(directory, 'huxerui-integration');
  const entries = await fs.readdir(integration, { withFileTypes: true }).catch(() => []);
  const plans = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const plan = path.join(integration, entry.name, 'Debug', 'app.json');
    return fs.readFile(plan, 'utf8').catch(() => undefined);
  }));
  const available = plans.filter(plan => plan !== undefined);
  if (available.length !== 1) {
    throw new Error(available.length
      ? 'The Debug build produced more than one HuxerUI application plan.'
      : 'The Debug build did not produce a HuxerUI application plan.');
  }

  const plan = JSON.parse(available[0]);
  if (plan?.schema !== 1 || typeof plan.artifact !== 'string' || !path.isAbsolute(plan.artifact)) {
    throw new Error('The HuxerUI application plan does not identify a Debug executable.');
  }
  const program: string = plan.artifact;
  try {
    if (!(await fs.stat(program)).isFile()) {
      throw new Error('Expected a file');
    }
    await fs.access(program, constants.X_OK);
  } catch {
    throw new Error('The HuxerUI Debug executable is missing or cannot be run at ' + program + '.');
  }
  const name = typeof plan.name === 'string' && plan.name ? plan.name : path.basename(program);
  return { program, name, sourceDirectory, realProjectRoot };
}

function launchConfiguration(target: Target): vscode.DebugConfiguration {
  return { type: debugType, request: 'launch', name: 'HuxerUI: ' + targetLabels[target], target };
}

export async function debugProject(selected?: Project, options: DeviceOptions & { target?: Target } = {}): Promise<void> {
  const project = selected ?? await selectProject();
  if (!project) {
    return;
  }
  const targets = debugTargets(project);
  if (!targets.length || (options.target && !targets.includes(options.target))) {
    throw new Error('Choose a HuxerUI CMake application or Library Preview with a debug target supported on this host.');
  }
  const order = hostTarget && targets.includes(hostTarget) ? [hostTarget, ...targets.filter(item => item !== hostTarget)] : targets;
  const target = options.target ?? (order.length > 1 ? (await vscode.window.showQuickPick(order.map(item => ({ label: targetLabels[item], target: item })), {
    placeHolder: 'Choose a HuxerUI debug target',
  }))?.target : order[0]);
  if (target) {
    await vscode.debug.startDebugging(project.folder, { ...launchConfiguration(target),
      project: path.relative(project.folder.uri.fsPath, project.root.fsPath).split(path.sep).join('/'),
      device: options.device, abis: options.abis,
    });
  }
}

async function prepareDebug(sdkSelection: SdkSelection, tasks: HuxerTasks, project: Project,
                            target: Exclude<Target, 'web'>, options: DeviceOptions & { args?: string[] },
                            token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | undefined> {
  const adapter = isMobile(target) ? debuggers.macos : debuggers[target];
  if (!vscode.extensions.getExtension(adapter.extension)) {
    const action = await vscode.window.showErrorMessage(
      'Install and enable ' + adapter.name + ' on the workspace host to debug HuxerUI.', 'Open Extension');
    if (action) {
      await vscode.env.openExternal(vscode.Uri.parse(
        'https://marketplace.visualstudio.com/items?itemName=' + adapter.extension));
    }
    return;
  }
  const gdb = target === 'linux' ? await findGdb() : undefined;
  if (target === 'linux' && !gdb) {
    throw new Error('Install GDB on the Linux workspace host and make sure gdb is on PATH.');
  }

  const key = project.root.toString();
  if (starting.has(key) || mobileDebugProjects().includes(key)) {
    throw new Error('Stop the active HuxerUI debug launch for this project first.');
  }
  starting.add(key);
  try {
    const sdk = await sdkSelection.resolve(project.root);
    if (!sdk || token?.isCancellationRequested) {
      return;
    }
    if (isMobile(target)) {
      return await prepareMobileDebug(project, sdk, tasks, target, options, token);
    }
    if (!await prepareToolchain(tasks, project, sdk, { target, operation: 'build' }) || token?.isCancellationRequested) {
      return;
    }
    const controller = new AbortController();
    const cancellation = token?.onCancellationRequested(() => controller.abort());
    const code = await tasks.buildForDebug(project, sdk, target, {}, controller.signal).finally(() => cancellation?.dispose());
    if (token?.isCancellationRequested) {
      return;
    }
    if (code !== 0) {
      throw new Error('The HuxerUI Debug build did not complete. See the task terminal for details.');
    }
    const projectDirectory = (project.preview ?? project.root).fsPath;
    const app = await findDebugApp(projectDirectory, sdk.root, target);
    // The compiler and VS Code can spell the same workspace differently when its path contains a symlink.
    const sourceMap = Object.fromEntries([app.sourceDirectory, app.realProjectRoot]
      .filter(directory => directory !== projectDirectory).map(directory => [directory, projectDirectory]));
    const environment = Object.entries(sdkEnvironment(sdk)).flatMap(([name, value]) =>
      value !== undefined && (name === 'HUXERUI_HOME' || name.toUpperCase() === 'PATH') ? [{ name, value }] : []);
    const base = {
      name: 'HuxerUI: ' + app.name,
      type: adapter.type,
      request: 'launch',
      program: app.program,
      args: options.args,
    };
    return target === 'macos' ? {
      ...base,
      cwd: projectDirectory,
      env: Object.fromEntries(environment.map(({ name, value }) => [name, value])),
      sourceMap,
    } : {
      ...base,
      // Match the CLI's working directory so the app can find its adjacent files.
      cwd: path.dirname(app.program),
      environment,
      sourceFileMap: sourceMap,
      ...(gdb ? { MIMode: 'gdb', miDebuggerPath: gdb, externalConsole: false } : {}),
    };
  } finally {
    starting.delete(key);
  }
}

export function registerDebugConfigurations(context: vscode.ExtensionContext, sdkSelection: SdkSelection, tasks: HuxerTasks,
                                            preferences: (project: Project, target: Target) => DeviceOptions): void {
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(debugType, {
    async provideDebugConfigurations(folder, token) {
      if (!folder || !vscode.workspace.isTrusted || token?.isCancellationRequested) {
        return [];
      }
      const project = (await inspectProjects(folder)).find(project => project.buildSystem === 'cmake');
      return project ? debugTargets(project).map(launchConfiguration) : [];
    },
    async resolveDebugConfiguration(folder, config, token) {
      try {
        if (!vscode.workspace.isTrusted) {
          throw new Error('Trust this workspace before debugging a HuxerUI project.');
        }
        if (!folder) {
          throw new Error('Open a HuxerUI project folder to start debugging.');
        }
        const relative = config.project ?? '';
        if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
          throw new Error('The HuxerUI debug project must be relative to its workspace folder.');
        }
        const root = vscode.Uri.joinPath(folder.uri, relative);
        const project = (await inspectProjects(folder, root)).find(project => project.buildSystem === 'cmake');
        const available = project ? debugTargets(project) : [];
        const target = config.target ?? available.find(item => item === hostTarget) ??
          (available.length === 1 ? available[0] : undefined);
        if (!project || !isTarget(target) || target === 'web' || !available.includes(target)) {
          throw new Error('Choose a HuxerUI CMake application or Library Preview with a debug target supported on this host.');
        }
        if (config.noDebug) {
          throw new Error('Use HuxerUI: Run to launch without the debugger.');
        }
        if (config.args !== undefined && (isMobile(target) || !Array.isArray(config.args) ||
            config.args.some((arg: unknown) => typeof arg !== 'string'))) {
          throw new Error('HuxerUI debug launch arguments must be an array of strings for a desktop target.');
        }
        const abis = readAbis(target, config.abis);
        if (config.abis !== undefined && (!abis || !isMobile(target))) {
          throw new Error('Choose valid ABIs for the HuxerUI mobile debug target.');
        }
        const defaults = preferences(project, target);
        const prepared = await prepareDebug(sdkSelection, tasks, project, target, {
          device: config.device ?? defaults.device, abis: abis ?? defaults.abis, args: config.args,
        }, token);
        return prepared ? { ...prepared, name: config.name } : undefined;
      } catch (error) {
        if (!token?.isCancellationRequested) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
        return undefined;
      }
    },
  }, vscode.DebugConfigurationProviderTriggerKind.Dynamic));
}
