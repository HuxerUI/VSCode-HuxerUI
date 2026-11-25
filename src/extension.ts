import * as path from 'node:path';
import * as vscode from 'vscode';
import { defaultAppPlatforms, ExistingProjectDirectory, generateProject, isProjectName, ProjectInput, projectDestination, projectIdError } from './create';
import { debugProject, registerDebugConfigurations } from './debug';
import { androidDeviceAbis, Device, deviceHelp, MobileTarget, readyDevices } from './devices';
import { registerEditorFeatures } from './editor';
import { registerIntelliSense } from './intellisense';
import { disposeMobileDebug, mobileDebugProjects, registerMobileDebug, stopMobileDebug } from './mobileDebug';
import { BuildSystem, canBuild, hostTarget, isDirectory, isTarget, Project, selectProject, Target, targets } from './projects';
import { Sdk, SdkSelection } from './sdk';
import { registerSidebar, sidebarDebugOptions } from './sidebar';
import { Action, actions, canRun, Configuration, defaultTarget, HuxerTasks } from './tasks';
import { prepareToolchain, toolchainOperation } from './toolchain';
import { WebPreviews } from './webPreview';

let previews: WebPreviews | undefined;

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

async function chooseDevice(sdk: Sdk, project: Project, target: MobileTarget):
  Promise<{ device: Device; automatic?: true } | undefined> {
  const find = () => vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification, title: 'Finding ' + target + ' devices…',
  }, () => readyDevices(sdk, project, target));
  let ready = await find();
  while (!ready.length) {
    const refresh = await vscode.window.showWarningMessage(
      'No ready ' + target + ' device. ' + deviceHelp(target), { modal: true }, 'Refresh Devices');
    if (!refresh) {
      return undefined;
    }
    ready = await find();
  }
  if (ready.length === 1) {
    return { device: ready[0], automatic: true };
  }
  return vscode.window.showQuickPick(ready.map(device => ({
    label: device.label, description: device.abis?.[0] ?? device.id, device,
  })), { placeHolder: 'Choose a device' });
}

async function chooseConfiguration(action: Action): Promise<Configuration | undefined> {
  const choices: Configuration[] = action === 'package' ? ['release', 'debug'] : ['debug', 'release'];
  const selected = await vscode.window.showQuickPick(choices, { placeHolder: 'Choose a build configuration' });
  return selected === 'debug' || selected === 'release' ? selected : undefined;
}

async function runAction(action: Action | 'setup', projects: SdkSelection, tasks: HuxerTasks): Promise<void> {
  const project = await selectProject();
  if (!project) {
    return;
  }
  if ((action === 'setup' && project.buildSystem !== 'cmake') || !canRun(project, action === 'setup' ? 'build' : action)) {
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
  if (action === 'setup') {
    if (sdk && target && await prepareToolchain(tasks, project, sdk, { target, operation: 'run' }, true)) {
      void vscode.window.showInformationMessage('The HuxerUI ' + target + ' toolchain is ready.');
    }
    return;
  }
  const configuration = action === 'doctor' ? undefined : await chooseConfiguration(action);
  if (action !== 'doctor' && !configuration) {
    return;
  }
  if (sdk && target && action !== 'doctor' &&
      !await prepareToolchain(tasks, project, sdk, { target, operation: toolchainOperation(action) })) {
    return;
  }
  const needsDevice = sdk && (target === 'android' || target === 'ios') &&
    (action === 'run' || action === 'watch');
  const selected = needsDevice ? await chooseDevice(sdk, project, target) : undefined;
  if (needsDevice && !selected) {
    return;
  }
  const device = target === 'ios' && selected?.automatic ? undefined : selected?.device.id;
  const abis = selected && target === 'android' ? androidDeviceAbis(selected.device) : undefined;
  if (device && sdk && target &&
      !await prepareToolchain(tasks, project, sdk, { target, operation: 'run', device, abis })) {
    return;
  }
  await vscode.tasks.executeTask(tasks.makeTask(project, { action, target, configuration, device, abis }, { sdk }));
}

async function createProject(sdkSelection: SdkSelection, tasks: HuxerTasks): Promise<void> {
  const kind = await vscode.window.showQuickPick(['app', 'library'] as const, {
    placeHolder: 'Choose a project type',
  });
  if (kind !== 'app' && kind !== 'library') {
    return;
  }
  const build = await vscode.window.showQuickPick<vscode.QuickPickItem & { value: BuildSystem }>([
    { label: 'CMake', value: 'cmake' },
    { label: 'mcpp', value: 'mcpp', description: 'Desktop C++ modules preview' },
  ], { placeHolder: 'Choose a build system' });
  if (!build) {
    return;
  }
  let platforms: Target[] = [];
  let template: ProjectInput['template'];
  if (build.value === 'cmake') {
    const app = kind === 'app';
    const selected = await vscode.window.showQuickPick(targets.map(target => ({
      label: target,
      description: app && !canBuild(target) ? 'Requires a different build host' : undefined,
      picked: app && defaultAppPlatforms.includes(target),
      target,
    })), { canPickMany: true, placeHolder: app ? 'Select application platforms' : 'Select platform integrations (optional)' });
    if (!selected) {
      return;
    }
    if (app && !selected.length) {
      throw new Error('Select at least one application platform.');
    }
    platforms = selected.map(item => item.target);
  }
  if (build.value === 'mcpp' && kind === 'app') {
    const selected = await vscode.window.showQuickPick(['app', 'navigation'], { placeHolder: 'Choose an mcpp template' });
    if (selected !== 'app' && selected !== 'navigation') {
      return;
    }
    template = selected;
  }
  const [parent] = await vscode.window.showOpenDialog({
    canSelectFiles: false, canSelectFolders: true, openLabel: 'Choose Parent Folder',
  }) ?? [];
  if (!parent) {
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: 'Enter the project name',
    validateInput: value => isProjectName(value)
      ? undefined
      : 'Start with a letter and use only letters, digits, underscores, or hyphens.',
  });
  if (!name) {
    return;
  }
  let projectId = '';
  if (build.value === 'cmake') {
    const id = await vscode.window.showInputBox({
      prompt: 'Enter the project ID',
      placeHolder: kind === 'app' ? 'com.example.myapp' : 'com.example.mylibrary',
      validateInput: value => projectIdError(value.trim()),
    });
    if (id === undefined) {
      return;
    }
    projectId = id.trim();
  }
  const input: ProjectInput = { kind, name, projectId, parent, buildSystem: build.value, platforms, template };
  let root: vscode.Uri;
  try {
    root = await projectDestination(input);
  } catch (error) {
    if (!(error instanceof ExistingProjectDirectory)) {
      throw error;
    }
    const open = await vscode.window.showWarningMessage('The project directory already exists.', 'Open Folder');
    if (open) {
      await vscode.commands.executeCommand('vscode.openFolder', error.root);
    }
    return;
  }
  const sdk = await sdkSelection.resolve(parent);
  if (!sdk) {
    return;
  }
  if (build.value === 'mcpp' && sdk.type === 'source') {
    const create = await vscode.window.showWarningMessage(
      'The mcpp manifest will reference this source checkout by absolute path.', 'Create Project');
    if (!create) {
      return;
    }
  }
  await generateProject(input, root, sdk, sdkSelection, tasks);
  const open = await vscode.window.showInformationMessage(
    'Created HuxerUI project ' + name, 'Open Folder', 'Add to Workspace');
  if (open === 'Open Folder') {
    await vscode.commands.executeCommand('vscode.openFolder', root);
  } else if (open === 'Add to Workspace') {
    vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: root });
  }
}

async function openArtifacts(selected?: Project): Promise<void> {
  const project = selected ?? await selectProject();
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
  const running = [...new Set([...tasks.runningProjects(), ...mobileDebugProjects()])];
  if (!running.length) {
    void vscode.window.showInformationMessage('There are no active HuxerUI tasks or debug sessions.');
    return;
  }
  const selection = running.length === 1 ? running[0] : (await vscode.window.showQuickPick(running.map(id => ({
    label: path.basename(vscode.Uri.parse(id).fsPath),
    detail: vscode.Uri.parse(id).fsPath,
    id,
  })), { placeHolder: 'Choose the HuxerUI project to stop' }))?.id;
  if (selection) {
    tasks.stop(selection);
    await stopMobileDebug(selection);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const sdkSelection = new SdkSelection(context.globalState, context.globalStorageUri.fsPath);
  const tasks = new HuxerTasks(sdkSelection);
  const webPreviews = new WebPreviews(sdkSelection, tasks);
  previews = webPreviews;
  context.subscriptions.push(webPreviews);
  context.subscriptions.push(sdkSelection, tasks, vscode.tasks.registerTaskProvider('huxerui', tasks));
  registerIntelliSense(context, sdkSelection);
  registerEditorFeatures(context);
  registerMobileDebug(context);
  registerDebugConfigurations(context, sdkSelection, tasks, (project, target) =>
    sidebarDebugOptions(context.globalState, project, target));
  registerSidebar(context, sdkSelection, tasks, openArtifacts);

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
  command('setup', () => runAction('setup', sdkSelection, tasks));

  command('selectSdk', async () => {
    const project = vscode.workspace.workspaceFolders?.length ? await selectProject() : undefined;
    const sdk = await sdkSelection.select(project?.root);
    if (sdk) {
      void vscode.window.showInformationMessage('Selected HuxerUI SDK at ' + sdk.root);
    }
  });
  command('rebuildSourceCli', async () => {
    const project = await selectProject();
    if (project?.buildSystem === 'cmake') {
      const sdk = await sdkSelection.rebuildSourceCli(project.root);
      void vscode.window.showInformationMessage('Rebuilt the HuxerUI CLI from ' + sdk.root + '.');
    } else if (project) {
      throw new Error('Select a HuxerUI CMake project to rebuild its source CLI.');
    }
  });
  command('create', () => createProject(sdkSelection, tasks));
  command('debug', () => debugProject());
  command('preview', () => webPreviews.open());
  command('stop', () => stopTask(tasks));
  command('openArtifacts', openArtifacts);
}

export async function deactivate(): Promise<void> {
  await Promise.all([previews?.dispose(), disposeMobileDebug()]);
}
