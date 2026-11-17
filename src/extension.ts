import * as path from 'node:path';
import * as vscode from 'vscode';
import { debugProject } from './debug';
import { registerIntelliSense } from './intellisense';
import { canBuild, hostTarget, isDirectory, isTarget, Project, selectProject, Target, targets } from './projects';
import { Sdk, sdkCommand, sdkEnvironment, SdkSelection } from './sdk';
import { Action, actions, canRun, Configuration, defaultTarget, HuxerTasks } from './tasks';

function requireTrust(): void {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust this workspace before running a HuxerUI command.');
  }
}

async function chooseTarget(project: Project, forDoctor = false): Promise<Target | undefined> {
  const supported = project.platforms.filter(canBuild);
  if (!supported.length && forDoctor) {
    return hostTarget;
  }
  if (supported.length <= 1) {
    return supported[0];
  }
  const preferred = defaultTarget(project);
  const selected = await vscode.window.showQuickPick(
    preferred ? [preferred, ...supported.filter(target => target !== preferred)] : supported,
    { placeHolder: 'Choose a target for ' + path.basename(project.root.fsPath) },
  );
  return isTarget(selected) ? selected : undefined;
}

interface DeviceChoice extends vscode.QuickPickItem {
  id: string;
}

async function chooseDevice(sdk: Sdk, project: Project, target: 'android' | 'ios'): Promise<string | undefined> {
  const output = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Finding ' + target + ' devices…',
  }, () => sdkCommand(sdk, ['devices', target], project.root.fsPath));
  const ready: DeviceChoice[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*\[ready\]\s+(\S+)(?:\s+\((.+)\))?\s*$/.exec(line);
    if (match) {
      ready.push({ id: match[1], label: match[2] ?? match[1], description: match[1] });
    }
  }
  if (!ready.length) {
    const suggestion = target === 'android'
      ? 'Start an emulator or connect and authorize an ADB device.'
      : 'Start an Xcode simulator or connect and pair an iOS device.';
    throw new Error('No ready ' + target + ' device. ' + suggestion);
  }
  if (ready.length === 1) {
    return ready[0].id;
  }
  return (await vscode.window.showQuickPick(ready, { placeHolder: 'Choose a device' }))?.id;
}

async function chooseConfiguration(action: Action): Promise<Configuration | undefined> {
  const choices: Configuration[] = action === 'package' ? ['release', 'debug'] : ['debug', 'release'];
  const selected = await vscode.window.showQuickPick(choices, { placeHolder: 'Choose a build configuration' });
  return selected === 'debug' || selected === 'release' ? selected : undefined;
}

async function runAction(action: Action, projects: SdkSelection, tasks: HuxerTasks): Promise<void> {
  const project = await selectProject();
  if (!project) {
    return;
  }
  if (!canRun(project, action)) {
    throw new Error('This action is unavailable for the selected project. Check its enabled targets and build system.');
  }
  const target = project.buildSystem === 'cmake'
    ? await chooseTarget(project, action === 'doctor')
    : undefined;
  if (project.buildSystem === 'cmake' && !target &&
      (action !== 'doctor' || project.platforms.some(canBuild))) {
    return;
  }
  const sdk = project.buildSystem === 'cmake' ? await projects.resolve(project.root) : undefined;
  if (project.buildSystem === 'cmake' && !sdk) {
    return;
  }
  const configuration = action === 'doctor' ? undefined : await chooseConfiguration(action);
  if (action !== 'doctor' && !configuration) {
    return;
  }
  const needsDevice = sdk && (target === 'android' || target === 'ios') &&
    (action === 'run' || action === 'watch');
  const device = needsDevice ? await chooseDevice(sdk, project, target) : undefined;
  if (needsDevice && !device) {
    return;
  }
  await vscode.tasks.executeTask(tasks.makeTask(project, { action, target, configuration, device }, { sdk }));
}

async function createProject(sdkSelection: SdkSelection, tasks: HuxerTasks): Promise<void> {
  const kind = await vscode.window.showQuickPick(['app', 'library'] as const, {
    placeHolder: 'Choose a project type',
  });
  if (!kind) {
    return;
  }
  const build = await vscode.window.showQuickPick([
    { label: 'CMake', value: 'cmake' },
    { label: 'mcpp', value: 'mcpp', description: 'Desktop C++ modules preview' },
  ], { placeHolder: 'Choose a build system' });
  if (!build) {
    return;
  }
  let platforms: Target[] = [];
  let template: string | undefined;
  if (build.value === 'cmake' && kind === 'app') {
    const selected = await vscode.window.showQuickPick(targets.map(target => ({
      label: target,
      description: canBuild(target) ? undefined : 'Requires a different build host',
      picked: target === hostTarget,
      target,
    })), { canPickMany: true, placeHolder: 'Select application platforms' });
    if (!selected) {
      return;
    }
    if (!selected.length) {
      throw new Error('Select at least one application platform.');
    }
    platforms = selected.map(item => item.target);
  }
  if (build.value === 'mcpp' && kind === 'app') {
    template = await vscode.window.showQuickPick(['app', 'navigation'], { placeHolder: 'Choose an mcpp template' });
    if (!template) {
      return;
    }
  }
  const [parent] = await vscode.window.showOpenDialog({
    canSelectFiles: false, canSelectFolders: true, openLabel: 'Choose Parent Folder',
  }) ?? [];
  if (!parent) {
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: 'Enter the project name',
    validateInput: value => /^[A-Za-z][A-Za-z0-9_-]*$/.test(value)
      ? undefined
      : 'Start with a letter and use only letters, digits, underscores, or hyphens.',
  });
  if (!name) {
    return;
  }
  const root = vscode.Uri.joinPath(parent, name);
  try {
    const existing = await vscode.workspace.fs.stat(root);
    if (existing.type & vscode.FileType.Directory) {
      const open = await vscode.window.showWarningMessage('The project directory already exists.', 'Open Folder');
      if (open) {
        await vscode.commands.executeCommand('vscode.openFolder', root);
      }
      return;
    }
    throw new Error('The project path is already in use.');
  } catch (error) {
    if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
      throw error;
    }
  }
  const sdk = await sdkSelection.resolve(parent);
  if (!sdk) {
    return;
  }
  const args = ['create', kind, name, '--build', build.value, '--agent', 'none'];
  if (platforms.length) {
    args.push('--platform', platforms.join(','));
  }
  if (template) {
    args.push('--template', template);
  }
  if (build.value === 'mcpp' && sdk.type === 'source') {
    const create = await vscode.window.showWarningMessage(
      'The mcpp manifest will reference this source checkout by absolute path.', 'Create Project');
    if (!create) {
      return;
    }
  }
  const code = await tasks.create(vscode.workspace.getWorkspaceFolder(parent), root, {
    executable: sdk.cli, args, cwd: parent.fsPath, env: sdkEnvironment(sdk),
  });
  if (code !== 0) {
    throw new Error('Project creation did not complete. See the task terminal for details.');
  }
  await sdkSelection.save(root, sdk);
  const open = await vscode.window.showInformationMessage(
    'Created HuxerUI project ' + name, 'Open Folder', 'Add to Workspace');
  if (open === 'Open Folder') {
    await vscode.commands.executeCommand('vscode.openFolder', root);
  } else if (open === 'Add to Workspace') {
    vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: root });
  }
}

async function openArtifacts(): Promise<void> {
  const project = await selectProject();
  if (!project) {
    return;
  }
  if (project.buildSystem !== 'cmake') {
    throw new Error('Use the output path from the mcpp build or package command.');
  }
  const root = project.preview ?? project.root;
  const dist = vscode.Uri.joinPath(root, 'dist');
  if (!await isDirectory(dist)) {
    throw new Error('No dist folder found. Run HuxerUI: Package first.');
  }
  await vscode.commands.executeCommand('revealInExplorer', dist);
}

async function stopTask(tasks: HuxerTasks): Promise<void> {
  const running = tasks.runningProjects();
  if (!running.length) {
    void vscode.window.showInformationMessage('There are no active HuxerUI tasks.');
    return;
  }
  const selection = running.length === 1 ? running[0] : (await vscode.window.showQuickPick(running.map(id => ({
    label: path.basename(vscode.Uri.parse(id).fsPath),
    detail: vscode.Uri.parse(id).fsPath,
    id,
  })), { placeHolder: 'Choose the HuxerUI task to stop' }))?.id;
  if (selection) {
    tasks.stop(selection);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const sdkSelection = new SdkSelection(context.globalState, context.globalStorageUri.fsPath);
  const tasks = new HuxerTasks(sdkSelection);
  context.subscriptions.push(sdkSelection, tasks, vscode.tasks.registerTaskProvider('huxerui', tasks));
  registerIntelliSense(context, sdkSelection);

  function command(id: string, handler: () => Promise<void>): void {
    context.subscriptions.push(vscode.commands.registerCommand('huxerui.' + id, async () => {
      try {
        requireTrust();
        await handler();
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }));
  }

  for (const action of actions) {
    command(action, () => runAction(action, sdkSelection, tasks));
  }

  command('selectSdk', async () => {
    const project = vscode.workspace.workspaceFolders?.length ? await selectProject() : undefined;
    const sdk = await sdkSelection.select(project?.root);
    if (sdk) {
      void vscode.window.showInformationMessage('Selected HuxerUI SDK at ' + sdk.root);
    }
  });
  command('create', () => createProject(sdkSelection, tasks));
  command('debug', () => debugProject(sdkSelection, tasks));
  command('stop', () => stopTask(tasks));
  command('openArtifacts', openArtifacts);
}
