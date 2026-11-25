import * as path from 'node:path';
import * as vscode from 'vscode';
import { canBuild, chooseProject, Project, projectsForFile, selectProject } from './projects';
import { Sdk, SdkSelection } from './sdk';
import { HuxerTasks } from './tasks';
import { prepareWebPreviewToolchain, WebPreviewToolchain } from './toolchain';
import { PreviewBuild, PreviewSite } from './webPreviewBuild';

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function renderPage(webview: vscode.Webview, site: vscode.Uri, html: string): string {
  const head = /<head\b[^>]*>/i;
  if (!head.test(html)) {
    throw new Error('The generated Web entry page is missing a head element.');
  }
  const source = webview.cspSource;
  const base = webview.asWebviewUri(site.with({ path: site.path + '/' })).toString();
  // The SDK's trusted shell boots the Emscripten ES module from an inline module script.
  const policy = [
    "default-src 'none'", 'base-uri ' + source,
    "script-src " + source + " 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src " + source + " 'unsafe-inline'",
    'connect-src ' + source + ' https: http: wss: ws:', 'img-src ' + source + ' data: blob: https:',
    'font-src ' + source + ' data: https:', 'media-src ' + source + ' blob: https:', 'worker-src ' + source + ' blob:',
  ].join('; ');
  return html.replace(head, tag => tag + '<meta http-equiv="Content-Security-Policy" content="' +
    escapeHtml(policy) + '"><base href="' + escapeHtml(base) + '">');
}

class PreviewSession {
  private readonly controller = new AbortController();
  private readonly subscriptions: vscode.Disposable[];
  private requested = 0;
  private attempted = 0;
  private running?: Promise<void>;
  private published?: PreviewSite;
  private closing?: Promise<void>;

  constructor(
    private readonly project: Project,
    private readonly sdk: Sdk,
    private readonly tools: WebPreviewToolchain,
    private readonly tasks: HuxerTasks,
    private readonly log: vscode.OutputChannel,
    private readonly build: PreviewBuild,
    private readonly panel: vscode.WebviewPanel,
    onClose: () => void,
  ) {
    const resources = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(project.root,
      '{resources/**,platform/web/**,examples/preview/resources/**,examples/preview/platform/web/**}'));
    const changed = (uri: vscode.Uri) => {
      void this.saved(uri).catch(error => {
        if (!this.controller.signal.aborted) {
          void vscode.window.showErrorMessage(String(error));
        }
      });
    };
    this.subscriptions = [
      resources, resources.onDidChange(changed), resources.onDidCreate(changed), resources.onDidDelete(changed),
      panel.onDidDispose(onClose),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (!vscode.workspace.getWorkspaceFolder(project.root)) {
          panel.dispose();
        }
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        // Resource directories also contain binary files saved by external editors.
        // Use only the filesystem notification there so a text save is not counted twice.
        const relative = path.relative(project.root.fsPath, document.uri.fsPath).split(path.sep).join('/');
        if (!/^(?:examples\/preview\/)?(?:resources|platform\/web)\//.test(relative)) {
          changed(document.uri);
        }
      }),
    ];
    this.requestBuild();
  }

  private async saved(file: vscode.Uri): Promise<void> {
    const root = this.project.root;
    if (root.scheme !== file.scheme || root.authority !== file.authority) {
      return;
    }
    const relative = path.relative(root.fsPath, file.fsPath);
    const parts = relative.split(path.sep);
    if (path.isAbsolute(relative) || ['..', '.git', '.huxerui', 'dist'].includes(parts[0]) ||
        (parts[0] === 'build' && parts[1] === 'live-preview')) {
      return;
    }
    const owners = await projectsForFile(file);
    if (owners.some(owner => owner.root.toString() === root.toString())) {
      this.requestBuild();
    }
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.requestBuild();
  }

  private status(title: string, message: string): void {
    const name = path.basename(this.project.root.fsPath) + ' Preview';
    this.panel.title = title ? name + ' (' + title + ')' : name;
    if (!this.published) {
      this.panel.webview.html = '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body><p>' +
        escapeHtml(message) + '</p></body></html>';
    }
  }

  private requestBuild(): void {
    if (!this.controller.signal.aborted) {
      ++this.requested;
      this.schedule();
    }
  }

  private schedule(): void {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
      if (!this.controller.signal.aborted && this.attempted < this.requested) {
        this.schedule();
      }
    });
  }

  private async run(): Promise<void> {
    const { signal } = this.controller;
    while (!signal.aborted && this.attempted < this.requested) {
      const attempted = this.attempted = this.requested;
      const started = Date.now();
      let candidate: PreviewSite | undefined;
      try {
        this.status('Building', 'Building Web preview…');
        const app = await this.build.compile(this.project, this.sdk, this.tools, this.tasks, signal);
        const compiled = Date.now();
        if (signal.aborted || attempted !== this.requested) {
          continue;
        }
        candidate = await this.build.stage(app, attempted);
        if (signal.aborted || attempted !== this.requested) {
          continue;
        }
        const uri = vscode.Uri.joinPath(this.project.root, 'build', 'live-preview', '.preview-sites',
          path.basename(this.build.siteDirectory), path.basename(candidate.directory));
        const webview = this.panel.webview;
        const html = renderPage(webview, uri, candidate.html);
        webview.options = { ...webview.options, localResourceRoots: [uri] };
        webview.html = html;
        const previous = this.published;
        this.published = candidate;
        this.status('', '');
        this.log.appendLine(app.target + ' #' + attempted + ' built in ' + (compiled - started) +
          ' ms, staged and published in ' + (Date.now() - compiled) + ' ms.');
        if (previous) {
          await this.build.discard(previous).catch(error => this.log.appendLine('Previous preview cleanup: ' + error));
        }
      } catch (error) {
        if (!signal.aborted && attempted === this.requested) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.appendLine('Build #' + attempted + ' failed: ' + message);
          this.status('Build Failed', message);
          void vscode.window.showErrorMessage(message);
        }
      } finally {
        if (candidate && candidate !== this.published) {
          await this.build.discard(candidate).catch(error => console.error(error));
        }
      }
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.controller.abort();
      this.subscriptions.forEach(subscription => subscription.dispose());
      this.panel.dispose();
      this.closing = (this.running ?? Promise.resolve()).finally(() => this.build.close());
    }
    return this.closing;
  }
}

export class WebPreviews implements vscode.Disposable {
  private readonly log = vscode.window.createOutputChannel('HuxerUI Web Preview');
  private readonly sessions = new Map<string, PreviewSession>();
  private readonly opening = new Map<string, Promise<void>>();
  private readonly closing = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(private readonly sdks: SdkSelection, private readonly tasks: HuxerTasks) {}

  async open(): Promise<void> {
    const project = await selectProject(candidates => {
      const available = candidates.filter(p => p.buildSystem === 'cmake' && canBuild('web'));
      if (!available.length) {
        throw new Error('Open a HuxerUI CMake application or a library with examples/preview on a supported host.');
      }
      return chooseProject(available);
    });
    if (!project || this.disposed) {
      return;
    }
    const key = project.root.toString();
    const session = this.sessions.get(key);
    if (session) {
      session.reveal();
      return;
    }
    const pending = this.opening.get(key);
    if (pending) {
      return pending;
    }
    const opening = this.start(project, key).finally(() => this.opening.delete(key));
    this.opening.set(key, opening);
    await opening;
  }

  private async start(project: Project, key: string): Promise<void> {
    await this.closing.get(key);
    const sdk = await this.sdks.resolve(project.root);
    const tools = sdk && await prepareWebPreviewToolchain(this.tasks, project, sdk);
    if (!sdk || !tools || this.disposed || !vscode.workspace.getWorkspaceFolder(project.root)) {
      return;
    }
    const build = await PreviewBuild.open(project);
    if (this.disposed || !vscode.workspace.getWorkspaceFolder(project.root)) {
      await build.close();
      return;
    }
    let panel: vscode.WebviewPanel | undefined;
    try {
      panel = vscode.window.createWebviewPanel('huxerui.preview', 'HuxerUI Preview',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
      const session = new PreviewSession(project, sdk, tools, this.tasks, this.log, build, panel, () => this.close(key));
      this.sessions.set(key, session);
    } catch (error) {
      panel?.dispose();
      await build.close();
      throw error;
    }
  }

  private close(key: string): void {
    const session = this.sessions.get(key);
    if (session) {
      this.sessions.delete(key);
      const cleanup = session.close().catch(error => console.error(error)).finally(() => this.closing.delete(key));
      this.closing.set(key, cleanup);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const key of this.sessions.keys()) {
      this.close(key);
    }
    await Promise.allSettled([...this.opening.values(), ...this.closing.values()]);
    this.log.dispose();
  }
}
