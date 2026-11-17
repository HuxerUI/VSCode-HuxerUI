import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { hostTarget, selectProject } from './projects';
import { sdkEnvironment, SdkSelection } from './sdk';
import { HuxerTasks } from './tasks';

const debuggers = {
  macos: { extension: 'vadimcn.vscode-lldb', name: 'CodeLLDB', type: 'lldb', platform: 'macOS' },
  windows: { extension: 'ms-vscode.cpptools', name: 'Microsoft C/C++', type: 'cppvsdbg', platform: 'Windows' },
  linux: { extension: 'ms-vscode.cpptools', name: 'Microsoft C/C++', type: 'cppdbg', platform: 'Linux' },
};
type DebugTarget = keyof typeof debuggers;

const starting = new Set<string>();

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

export async function debugProject(sdkSelection: SdkSelection, tasks: HuxerTasks): Promise<void> {
  const target = hostTarget;
  if (target !== 'macos' && target !== 'windows' && target !== 'linux') {
    throw new Error('HuxerUI desktop debugging is currently available on macOS, Windows, and Linux.');
  }
  const project = await selectProject();
  if (!project) {
    return;
  }
  const adapter = debuggers[target];
  if (project.buildSystem !== 'cmake' || !project.platforms.includes(target)) {
    throw new Error('Choose a HuxerUI CMake application or Library Preview with ' + adapter.platform + ' enabled.');
  }
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
  if (starting.has(key)) {
    throw new Error('A HuxerUI debug launch is already starting for this project.');
  }
  starting.add(key);
  try {
    const sdk = await sdkSelection.resolve(project.root);
    if (!sdk) {
      return;
    }
    const code = await tasks.buildForDebug(project, sdk, target);
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
    };
    const configuration = target === 'macos' ? {
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
    const launched = await vscode.debug.startDebugging(project.folder, configuration);
    if (!launched) {
      throw new Error(adapter.name + ' could not start the HuxerUI application.');
    }
  } finally {
    starting.delete(key);
  }
}
