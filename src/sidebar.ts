import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { defaultAppPlatforms, ExistingProjectDirectory, generateProject, ProjectInput, projectDestination } from './create';
import { debugProject } from './debug';
import { deviceHelp, isMobile, readyDevices } from './devices';
import { canBuild, hostTarget, inspectProjects, isTarget, Project, targets } from './projects';
import { Sdk, SdkChoice, SdkSelection } from './sdk';
import { actions, canRun, defaultTarget, HuxerTasks, isLto, isOptimization, RunOptions } from './tasks';

const viewId = 'huxerui.projects';
type Message = Record<string, unknown>;
type Preferences = Omit<RunOptions, 'action' | 'device'> & { devices?: Partial<Record<'android' | 'ios', string>> };

function projectId(project: Project): string {
  return project.buildSystem + ':' + project.root.toString();
}

function preferences(message: Message, project: Project, previous: Preferences): Preferences {
  const target = isTarget(message.target) && project.platforms.includes(message.target) && canBuild(message.target)
    ? message.target : defaultTarget(project);
  const devices = { ...previous.devices };
  if (isMobile(target) && typeof message.device === 'string') {
    devices[target] = message.device;
  }
  return {
    target,
    configuration: message.configuration === 'debug' || message.configuration === 'release' ? message.configuration : undefined,
    optimization: isOptimization(message.optimization) ? message.optimization : undefined,
    lto: isLto(message.lto) ? message.lto : undefined,
    devices,
  };
}

class Sidebar implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private projects: Project[] = [];
  private parent?: vscode.Uri;
  private creationSdk?: Sdk;
  private existing?: vscode.Uri;
  private readonly sdkChoices = new Map<string, SdkChoice[]>();
  private refreshId = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sdks: SdkSelection,
    private readonly tasks: HuxerTasks,
    private readonly openArtifacts: (project: Project) => Promise<void>,
  ) {}

  async refresh(): Promise<void> {
    const refresh = ++this.refreshId;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const projects = (await Promise.all(folders.map(folder => inspectProjects(folder)))).flat();
    if (refresh !== this.refreshId) {
      return;
    }
    this.projects = projects;
    await vscode.commands.executeCommand('setContext', 'huxerui.hasProject', projects.length > 0);
    await this.sendState();
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const resource = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const messages = view.webview.onDidReceiveMessage(message => {
      if (typeof message === 'object' && message !== null) {
        void this.handle(message).catch(error => {
          void this.post({ type: 'error', area: message.area, message: error instanceof Error ? error.message : String(error),
            existing: error instanceof ExistingProjectDirectory });
        });
      }
    });
    view.onDidDispose(() => {
      messages.dispose();
      if (this.view === view) {
        this.view = undefined;
      }
    });
    const page = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(media, 'sidebar.html'))).toString('utf8');
    view.webview.html = page
      .replaceAll('{{nonce}}', randomBytes(16).toString('hex'))
      .replaceAll('{{cspSource}}', view.webview.cspSource)
      .replaceAll('{{style}}', resource('sidebar.css'))
      .replaceAll('{{script}}', resource('sidebar.js'));
  }

  private post(message: Message): Thenable<boolean> | undefined {
    return this.view?.webview.postMessage(message);
  }

  private options(project: Project): Preferences {
    return this.context.globalState.get<Preferences>('sidebar.options:' + projectId(project), {});
  }

  private async sendState(): Promise<void> {
    if (!this.view) {
      return;
    }
    const active = this.context.workspaceState.get<string>('sidebar.project');
    await this.post({
      type: 'state',
      project: this.projects.find(project => projectId(project) === active) ? active : this.projects[0] && projectId(this.projects[0]),
      projects: this.projects.map(project => ({
        id: projectId(project),
        name: path.basename(project.root.fsPath),
        detail: project.root.fsPath,
        buildSystem: project.buildSystem,
        targets: project.platforms.filter(canBuild),
        settings: { ...this.options(project), target: this.options(project).target ?? defaultTarget(project) },
        actions: actions.filter(action => canRun(project, action)),
        debug: project.buildSystem === 'cmake' && !!hostTarget && project.platforms.includes(hostTarget),
      })),
      host: hostTarget,
      platforms: targets,
      defaultAppPlatforms,
      parent: this.parent?.fsPath,
      trusted: vscode.workspace.isTrusted,
    });
  }

  private async handle(message: Message): Promise<void> {
    if (message.type === 'ready') {
      await this.sendState();
      return;
    }
    if (!vscode.workspace.isTrusted) {
      if (message.type !== 'sdkList' && message.type !== 'devices') {
        throw new Error('Trust this workspace before running a HuxerUI command.');
      }
      return;
    }
    const project = this.projects.find(project => projectId(project) === message.project);
    if (message.type === 'browseParent') {
      const [parent] = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, openLabel: 'Choose Parent Folder',
        defaultUri: this.parent ?? project?.root,
      }) ?? [];
      if (parent) {
        this.parent = parent;
        this.creationSdk = undefined;
        this.sdkChoices.delete('create');
        await this.post({ type: 'parent', value: parent.fsPath });
      }
      return;
    }
    if (message.type === 'create') {
      await this.create(message);
      return;
    }
    if (message.type === 'openExisting' && this.existing) {
      await vscode.commands.executeCommand('vscode.openFolder', this.existing);
      return;
    }
    if (message.type === 'sdkList' || message.type === 'sdkSelect') {
      if (message.area === 'create' || project) {
        await this.sdk(message, project);
      }
      return;
    }
    if (!project) {
      return;
    }
    const key = projectId(project);
    if (message.type === 'selectProject') {
      await this.context.workspaceState.update('sidebar.project', key);
    } else if (message.type === 'preferences') {
      await this.context.globalState.update('sidebar.options:' + key, preferences(message, project, this.options(project)));
    } else if (message.type === 'devices') {
      const target = preferences(message, project, this.options(project)).target;
      if (isMobile(target)) {
        const sdk = await this.sdks.resolve(project.root, false).catch(() => undefined);
        const devices = sdk ? await readyDevices(sdk, project, target) : [];
        await this.post({ type: 'devices', project: key, target, devices,
          help: sdk ? deviceHelp(target) : 'Select an SDK to list devices.' });
      }
    } else if (message.type === 'action') {
      await this.run(project, message);
    }
  }

  private async sdk(message: Message, project?: Project): Promise<void> {
    const creating = message.area === 'create';
    if (!creating && !project) {
      return;
    }
    const root = creating ? this.parent : project?.root;
    const key = creating || !project ? 'create' : projectId(project);
    if (message.type === 'sdkSelect') {
      const choice = typeof message.index === 'number' && this.sdkChoices.get(key)?.[message.index];
      if (!choice) {
        return;
      }
      const sdk = await this.sdks.useChoice(root, choice, !creating);
      if (creating && sdk && root?.toString() === this.parent?.toString()) {
        this.creationSdk = sdk;
      }
    }
    const current = (creating && this.creationSdk) || await this.sdks.resolve(root, false).catch(() => undefined);
    const choices = await this.sdks.choices(root);
    if (creating && root?.toString() !== this.parent?.toString()) {
      return;
    }
    this.sdkChoices.set(key, choices);
    await this.post({
      type: 'sdk', area: creating ? 'create' : 'project', project: key, current: current?.root,
      choices: choices.map(choice => ({ label: choice.label, detail: choice.detail, root: choice.sdk?.root })),
      source: current?.type === 'source',
    });
  }

  private async create(message: Message): Promise<void> {
    this.existing = undefined;
    if (!this.parent || typeof message.name !== 'string') {
      throw new Error('Enter a name and choose a parent folder.');
    }
    const input: ProjectInput = {
      name: message.name.trim(),
      projectId: typeof message.projectId === 'string' ? message.projectId.trim() : '',
      parent: this.parent,
      kind: message.kind === 'library' ? 'library' : 'app',
      buildSystem: message.buildSystem === 'mcpp' ? 'mcpp' : 'cmake',
      platforms: Array.isArray(message.platforms) ? [...new Set(message.platforms.filter(isTarget))] : [],
      template: message.template === 'navigation' ? 'navigation' : 'app',
    };
    let root: vscode.Uri;
    try {
      root = await projectDestination(input);
    } catch (error) {
      if (error instanceof ExistingProjectDirectory) {
        this.existing = error.root;
      }
      throw error;
    }
    const sdk = this.creationSdk ?? await this.sdks.resolve(input.parent, false);
    if (!sdk) {
      throw new Error('Select an SDK for the new project.');
    }
    await generateProject(input, root, sdk, this.sdks, this.tasks);
    const count = vscode.workspace.workspaceFolders?.length ?? 0;
    if (count) {
      await this.context.workspaceState.update('sidebar.project', input.buildSystem + ':' + root.toString());
      if (!vscode.workspace.updateWorkspaceFolders(count, 0, { uri: root })) {
        await vscode.commands.executeCommand('vscode.openFolder', root, true);
      }
      await this.post({ type: 'created' });
    } else {
      await vscode.commands.executeCommand('vscode.openFolder', root);
      await this.post({ type: 'created' });
    }
  }

  private async run(project: Project, message: Message): Promise<void> {
    const action = message.action;
    if (action === 'debug') {
      if (message.target !== hostTarget) {
        throw new Error('Choose the desktop target to debug this project.');
      }
      await debugProject(this.sdks, this.tasks, project);
      return;
    }
    if (action === 'artifacts') {
      await this.openArtifacts(project);
      return;
    }
    if (action === 'stop') {
      if (!this.tasks.runningProjects().includes(project.root.toString())) {
        throw new Error('There is no active task for this project.');
      }
      this.tasks.stop(project.root.toString());
      return;
    }
    const taskAction = actions.find(value => value === action);
    if (!taskAction) {
      return;
    }
    const options = preferences(message, project, this.options(project));
    const target = options.target;
    const sdk = project.buildSystem === 'cmake' ? await this.sdks.resolve(project.root, false) : undefined;
    let device: string | undefined;
    const needsDevice = taskAction === 'run' || taskAction === 'watch';
    if (sdk && isMobile(target) && (needsDevice || (taskAction !== 'doctor' && options.devices?.[target]))) {
      const devices = await readyDevices(sdk, project, target);
      const selected = options.devices?.[target];
      device = devices.find(item => item.id === selected)?.id ?? (!selected && devices.length === 1 ? devices[0].id : undefined);
      if (!device) {
        await this.post({ type: 'devices', project: projectId(project), target, devices, help: deviceHelp(target) });
        throw new Error(devices.length ? 'Choose an available device.' : deviceHelp(target));
      }
    }
    await vscode.tasks.executeTask(this.tasks.makeTask(project, { ...options, action: taskAction, device }, { sdk }));
    await this.post({ type: 'started' });
  }
}

export function registerSidebar(
  context: vscode.ExtensionContext,
  sdks: SdkSelection,
  tasks: HuxerTasks,
  openArtifacts: (project: Project) => Promise<void>,
): void {
  const sidebar = new Sidebar(context, sdks, tasks, openArtifacts);
  const watcher = vscode.workspace.createFileSystemWatcher('**/{HuxerUIProject.cmake,CMakeLists.txt,mcpp.toml,build.mcpp}');
  const refresh = () => void sidebar.refresh().catch(error => console.warn('Could not refresh HuxerUI projects', error));
  const refreshRoot = (uri: vscode.Uri) => {
    if (vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === vscode.Uri.joinPath(uri, '..').toString()) {
      refresh();
    }
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(viewId, sidebar),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidGrantWorkspaceTrust(refresh),
    watcher, watcher.onDidCreate(refreshRoot), watcher.onDidChange(refreshRoot), watcher.onDidDelete(refreshRoot),
  );
  refresh();
}
