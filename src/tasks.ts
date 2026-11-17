import { ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Diagnostics } from './diagnostics';
import { canBuild, hostTarget, inspectProjects, isTarget, Project, Target } from './projects';
import { Sdk, sdkEnvironment, SdkSelection } from './sdk';

export const actions = ['doctor', 'build', 'run', 'watch', 'package'] as const;
export type Action = typeof actions[number];
export type Configuration = 'debug' | 'release';

const labels: Record<Action, string> = {
  doctor: 'Diagnose Environment',
  build: 'Build',
  run: 'Run',
  watch: 'Run with Watch',
  package: 'Package',
};

export interface RunOptions {
  action: Action;
  target?: Target;
  configuration?: Configuration;
  device?: string;
}

export interface Invocation {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  notice?: string;
}

export function defaultTarget(project: Project): Target | undefined {
  const available = project.platforms.filter(canBuild);
  return available.find(target => target === hostTarget) ?? (available.length === 1 ? available[0] : undefined);
}

function isAction(action: unknown): action is Action {
  return typeof action === 'string' && (actions as readonly string[]).includes(action);
}

export function canRun(project: Project, action: Action): boolean {
  if (action === 'doctor') {
    return true;
  }
  if (project.buildSystem === 'mcpp') {
    return action === 'build' || (action === 'run' && project.runnable);
  }
  return project.platforms.some(canBuild);
}

interface Definition extends vscode.TaskDefinition, RunOptions {
  type: 'huxerui';
  project: string;
  buildSystem: Project['buildSystem'];
}

interface TaskOverrides {
  sdk?: Sdk;
  definition?: vscode.TaskDefinition;
  name?: string;
  completed?: (code: number) => void;
}

export function invocationFor(project: Project, options: RunOptions, sdk?: Sdk): Invocation {
  const { action, target, device } = options;
  const configuration = options.configuration ?? (action === 'package' ? 'release' : 'debug');
  const cwd = project.root.fsPath;
  if (!canRun(project, action)) {
    throw new Error('This action is unavailable for the selected project. Check its enabled targets and build system.');
  }
  if (project.buildSystem === 'mcpp') {
    // mcpp resolves the framework dependency through the project's manifest and lockfile.
    const args = action === 'doctor' ? ['--version'] : [action];
    if (action !== 'doctor' && configuration === 'release') {
      args.push('--release');
    }
    return { executable: 'mcpp', args, cwd, env: process.env };
  }
  if (!sdk) {
    throw new Error('Choose an SDK before running a CMake project.');
  }
  const executable = sdk.cli;
  const env = sdkEnvironment(sdk);
  if (action === 'doctor') {
    const args = target ? ['doctor', target] : ['doctor'];
    const notice = sdk.type === 'source'
      ? 'The selected source checkout is used for builds. Doctor expects an installed SDK and may flag HUXERUI_HOME.'
      : undefined;
    return { executable, args, cwd, env, notice };
  }
  if (!target || !canBuild(target) || !project.platforms.includes(target)) {
    throw new Error('Select a project target supported by this execution host.');
  }
  if (device && target !== 'android' && target !== 'ios') {
    throw new Error('Device selection is available for Android and iOS targets.');
  }
  const args = [action === 'watch' ? 'run' : action, target, '--config', configuration, '--sdk', sdk.root];
  if (action === 'watch') {
    args.push('--watch');
  }
  if (device) {
    args.push('--device', device);
  }
  return { executable, args, cwd, env };
}

class CommandTerminal implements vscode.Pseudoterminal {
  private readonly writes = new vscode.EventEmitter<string>();
  private readonly closes = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.writes.event;
  readonly onDidClose = this.closes.event;

  private child?: ChildProcess;
  private stopped = false;
  private finished = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly claim: () => boolean,
    private readonly prepare: () => Promise<Invocation>,
    private readonly outputLine: (line: string) => void,
    private readonly completed: (code: number) => void,
  ) {}

  open(): void {
    if (!vscode.workspace.isTrusted) {
      this.fail('Trust this workspace before running HuxerUI tasks.');
      return;
    }
    if (!this.claim()) {
      this.fail('A HuxerUI task is already running for this project. Stop it before starting another.');
      return;
    }
    void this.prepare().then(invocation => {
      if (!this.finished) {
        this.start(invocation);
      }
    }).catch(error => this.fail(error instanceof Error ? error.message : String(error)));
  }

  private start({ executable, args, cwd, env, notice }: Invocation): void {
    this.write('Working directory: ' + cwd + '\n');
    this.write('> ' + [executable, ...args].map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ') + '\n');
    if (notice) {
      this.write(notice + '\n');
    }
    // A separate POSIX process group lets Stop signal the CLI and its build tools together.
    const child = spawn(executable, args, {
      cwd, env, detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    // Buffer each stream separately so a diagnostic split across chunks is parsed as one line.
    const flush = [child.stdout, child.stderr].map(stream => {
      let pending = '';
      stream.setEncoding('utf8').on('data', (chunk: string) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          this.write(line + '\n');
          this.outputLine(line);
        }
      });
      return () => {
        if (pending) {
          this.write(pending + '\n');
          this.outputLine(pending);
        }
      };
    });
    child.once('error', error => this.fail(error.message));
    child.once('close', (code, signal) => {
      flush.forEach(writePending => writePending());
      this.finish(code ?? (signal ? 130 : 1));
    });
  }

  handleInput(data: string): void {
    if (data === '\x03') {
      this.close();
    }
  }

  close(): void {
    if (this.stopped || this.finished) {
      return;
    }
    this.stopped = true;
    const child = this.child;
    const pid = child?.pid;
    if (!child || !pid) {
      this.finish(130);
      return;
    }

    this.write('Stopping HuxerUI task…\n');
    if (process.platform === 'win32') {
      const taskkill = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true, stdio: 'ignore',
      });
      taskkill.once('error', () => child.kill());
      taskkill.once('close', code => {
        if (code !== 0 && !this.finished) {
          child.kill();
        }
      });
      return;
    }
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    // Let the watch CLI stop its app and remove its staging directory before escalating.
    signalGroup('SIGINT');
    this.timers = [
      setTimeout(() => signalGroup('SIGTERM'), 2_000),
      setTimeout(() => signalGroup('SIGKILL'), 5_000),
    ];
  }

  private write(text: string): void {
    this.writes.fire(text.replace(/\r?\n/g, '\r\n'));
  }

  private fail(message: string): void {
    this.write('HuxerUI: ' + message + '\n');
    this.finish(1);
  }

  private finish(code: number): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.timers.forEach(timer => clearTimeout(timer));
    this.completed(code);
    this.closes.fire(code);
    this.writes.dispose();
    this.closes.dispose();
  }
}

export class HuxerTasks implements vscode.TaskProvider, vscode.Disposable {
  private readonly active = new Map<string, CommandTerminal>();
  private readonly diagnostics = new Diagnostics();

  constructor(private readonly sdkSelection: SdkSelection) {}

  async provideTasks(): Promise<vscode.Task[]> {
    if (!vscode.workspace.isTrusted) {
      return [];
    }
    const projects = (await Promise.all((vscode.workspace.workspaceFolders ?? [])
      .map(folder => inspectProjects(folder)))).flat();
    return projects.flatMap(project => actions.filter(action => canRun(project, action)).flatMap(action => {
      const target = defaultTarget(project);
      if (project.buildSystem === 'cmake' && action !== 'doctor' && !target) {
        return [];
      }
      return [this.makeTask(project, { action, target })];
    }));
  }

  async resolveTask(task: vscode.Task): Promise<vscode.Task | undefined> {
    const folder = task.scope;
    const value = task.definition as Partial<Definition>;
    if (!vscode.workspace.isTrusted || !folder || typeof folder === 'number' || !isAction(value.action)) {
      return undefined;
    }
    const projectPath = value.project ?? '.';
    if (typeof projectPath !== 'string' || path.isAbsolute(projectPath) ||
        projectPath.split(/[\\/]/).includes('..')) {
      return undefined;
    }
    const root = vscode.Uri.joinPath(folder.uri, projectPath);
    const projects = await inspectProjects(folder, root);
    const project = projects.find(project => !value.buildSystem || project.buildSystem === value.buildSystem);
    if (!project || (value.target && !isTarget(value.target)) ||
        (value.configuration && value.configuration !== 'debug' && value.configuration !== 'release')) {
      return undefined;
    }
    return this.makeTask(project, {
      action: value.action,
      target: value.target ?? defaultTarget(project),
      configuration: value.configuration,
      device: typeof value.device === 'string' ? value.device : undefined,
    }, { definition: task.definition, name: task.name });
  }

  makeTask(project: Project, options: RunOptions,
           { sdk, definition, name, completed }: TaskOverrides = {}): vscode.Task {
    const taskDefinition: Definition = {
      type: 'huxerui',
      action: options.action,
      project: path.relative(project.folder.uri.fsPath, project.root.fsPath).split(path.sep).join('/') || '.',
      buildSystem: project.buildSystem,
    };
    if (options.target) {
      taskDefinition.target = options.target;
    }
    if (options.configuration) {
      taskDefinition.configuration = options.configuration;
    }
    if (options.device) {
      taskDefinition.device = options.device;
    }
    const label = labels[options.action] + (project.preview && options.action !== 'doctor' ? ' Preview' : '');
    const targetLabel = options.target ? ' (' + options.target + ')' : '';
    const task = new vscode.Task(definition ?? taskDefinition, project.folder,
      name ?? label + targetLabel, 'HuxerUI', new vscode.CustomExecution(async () =>
        this.terminal(project.root, async () => {
          // Tasks discovered by VS Code resolve the project's current SDK when they start.
          const selected = project.buildSystem === 'cmake'
            ? sdk ?? await this.sdkSelection.resolve(project.root, false)
            : undefined;
          return invocationFor(project, options, selected);
        }, options.action, completed)));
    if (options.action === 'build') {
      task.group = vscode.TaskGroup.Build;
    }
    return task;
  }

  async create(folder: vscode.WorkspaceFolder | undefined, root: vscode.Uri,
               invocation: Invocation): Promise<number> {
    return this.executeAndWait(completed => new vscode.Task({ type: 'huxerui-create', path: root.toString() },
      folder ?? vscode.TaskScope.Global, 'Create Project', 'HuxerUI',
      new vscode.CustomExecution(async () => this.terminal(root, async () => invocation, undefined, completed))));
  }

  async buildForDebug(project: Project, sdk: Sdk, target: Target): Promise<number> {
    return this.executeAndWait(completed => this.makeTask(
      project, { action: 'build', target, configuration: 'debug' }, {
        sdk,
        definition: { type: 'huxerui-debug-build', project: project.root.toString() },
        name: 'Build for Debugging (' + target + ')',
        completed,
      },
    ));
  }

  private async executeAndWait(makeTask: (completed: (code: number) => void) => vscode.Task): Promise<number> {
    let completed: (code: number) => void = () => {};
    const result = new Promise<number>(resolve => { completed = resolve; });
    await vscode.tasks.executeTask(makeTask(completed));
    return result;
  }

  runningProjects(): string[] {
    return Array.from(this.active.keys());
  }

  stop(project: string): void {
    this.active.get(project)?.close();
  }

  private terminal(root: vscode.Uri, prepare: () => Promise<Invocation>, action?: Action,
                   callback?: (code: number) => void): CommandTerminal {
    const id = root.toString();
    const hasBuildOutput = action !== undefined && action !== 'doctor';
    const terminal = new CommandTerminal(
      () => {
        if (this.active.has(id)) {
          return false;
        }
        this.active.set(id, terminal);
        if (hasBuildOutput) {
          this.diagnostics.clear(root);
        }
        return true;
      },
      prepare,
      line => {
        // A watch session keeps its terminal open between builds. Clear stale Problems on each new build.
        if (action === 'watch' && /^Building \S+ \((debug|release)\)/.test(line)) {
          this.diagnostics.clear(root);
        }
        if (hasBuildOutput) {
          this.diagnostics.add(root, line);
        }
      },
      code => {
        if (this.active.get(id) === terminal) {
          this.active.delete(id);
        }
        callback?.(code);
      },
    );
    return terminal;
  }

  dispose(): void {
    for (const task of this.active.values()) {
      task.close();
    }
    this.diagnostics.dispose();
  }
}
