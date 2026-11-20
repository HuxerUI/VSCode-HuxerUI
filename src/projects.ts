import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

export const targets = ['windows', 'macos', 'linux', 'android', 'ios', 'web'] as const;
export type Target = typeof targets[number];
export type BuildSystem = 'cmake' | 'mcpp';

export interface Project {
  folder: vscode.WorkspaceFolder;
  root: vscode.Uri;
  buildSystem: BuildSystem;
  platforms: Target[];
  preview?: vscode.Uri;
  runnable: boolean;
}

const hostTargets: Partial<Record<NodeJS.Platform, Target>> = {
  win32: 'windows',
  darwin: 'macos',
  linux: 'linux',
};
export const hostTarget = hostTargets[process.platform];

export function canBuild(target: Target): boolean {
  return target === hostTarget ||
    (hostTarget !== undefined && (target === 'android' || target === 'web')) ||
    (hostTarget === 'macos' && target === 'ios');
}

export function isTarget(value: unknown): value is Target {
  return typeof value === 'string' && (targets as readonly string[]).includes(value);
}

export function pathInProject(root: vscode.Uri, file: string): vscode.Uri {
  if (!path.isAbsolute(file)) {
    return vscode.Uri.joinPath(root, file.replaceAll(path.sep, '/'));
  }
  // The compiler may report a different spelling of the workspace path through a symlink.
  // Compare the real paths, then use the workspace URI so Problems opens the same file as the editor.
  try {
    const relative = path.relative(realpathSync.native(root.fsPath), realpathSync.native(file));
    if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
      return vscode.Uri.joinPath(root, relative.replaceAll(path.sep, '/'));
    }
  } catch {
    // A generated or deleted file can still carry a useful diagnostic path.
  }
  // Preserve the workspace's scheme and authority for absolute paths on a remote host.
  return root.with({ path: vscode.Uri.file(file).path });
}

export async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    return Boolean((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory);
  } catch {
    return false;
  }
}

async function readText(root: vscode.Uri, name: string): Promise<string> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, name))).toString('utf8');
  } catch {
    return '';
  }
}

async function readPlatforms(root: vscode.Uri): Promise<Target[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, 'platform'));
    return entries.filter(([, type]) => type & (vscode.FileType.Directory | vscode.FileType.SymbolicLink))
      .map(([name]) => name).filter(isTarget).sort();
  } catch {
    return [];
  }
}

export async function inspectProjects(folder: vscode.WorkspaceFolder, root = folder.uri): Promise<Project[]> {
  const [cmake, cmakeProject, manifest, rules] = await Promise.all([
    readText(root, 'CMakeLists.txt'),
    readText(root, 'HuxerUIProject.cmake'),
    readText(root, 'mcpp.toml'),
    readText(root, 'build.mcpp'),
  ]);
  const projects: Project[] = [];
  if (cmake && (cmakeProject || /\b(?:huxerui_add_(?:app|library)|find_package\s*\(\s*HuxerUI|HuxerUI::)/i.test(cmake))) {
    const previewRoot = vscode.Uri.joinPath(root, 'examples', 'preview');
    const preview = await readText(previewRoot, 'CMakeLists.txt') ? previewRoot : undefined;
    const platforms = await readPlatforms(preview ?? root);
    projects.push({ folder, root, buildSystem: 'cmake', platforms, preview, runnable: platforms.length > 0 });
  }
  if (manifest && (/\bhuxerui\.huxerui\b/.test(manifest) ||
      /\bhuxerui\s*=\s*\{\s*path\s*=/.test(manifest) ||
      /\bimport\s+huxerui\.rules\s*;/.test(rules))) {
    const runnable = /^\s*(?:kind|type)\s*=\s*["'](?:app|bin|exe)["']/m.test(manifest);
    projects.push({ folder, root, buildSystem: 'mcpp', platforms: [], runnable });
  }
  return projects;
}

async function chooseProject(projects: Project[]): Promise<Project | undefined> {
  if (projects.length <= 1) {
    return projects[0];
  }
  return (await vscode.window.showQuickPick(projects.map(project => ({
    label: path.basename(project.root.fsPath),
    description: project.buildSystem,
    detail: project.root.fsPath,
    project,
  })), { placeHolder: 'Choose a HuxerUI project' }))?.project;
}

export async function projectsForFile(uri: vscode.Uri): Promise<Project[]> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder) {
    let directory = vscode.Uri.joinPath(uri, '..');
    while (true) {
      // A generated Preview uses the library's SDK selection and task scope.
      if (path.basename(directory.fsPath) === 'preview' &&
          path.basename(path.dirname(directory.fsPath)) === 'examples') {
        const library = vscode.Uri.joinPath(directory, '..', '..');
        if (vscode.workspace.getWorkspaceFolder(library)?.uri.toString() === folder.uri.toString()) {
          const project = (await inspectProjects(folder, library))
            .find(candidate => candidate.preview?.toString() === directory.toString());
          if (project) {
            return [project];
          }
        }
      }
      const projects = await inspectProjects(folder, directory);
      if (projects.length) {
        return projects;
      }
      if (directory.path === folder.uri.path) {
        break;
      }
      const parent = vscode.Uri.joinPath(directory, '..');
      if (parent.path === directory.path) {
        break;
      }
      directory = parent;
    }
  }
  return [];
}

export async function selectProject(): Promise<Project | undefined> {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const enclosing = uri ? await projectsForFile(uri) : [];
  if (enclosing.length) {
    return chooseProject(enclosing);
  }
  const roots = (await Promise.all((vscode.workspace.workspaceFolders ?? []).map(folder =>
    inspectProjects(folder)))).flat();
  if (roots.length) {
    return chooseProject(roots);
  }
  const [selected] = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    openLabel: 'Select HuxerUI Project',
  }) ?? [];
  if (!selected) {
    return undefined;
  }
  const owner = vscode.workspace.getWorkspaceFolder(selected);
  if (!owner) {
    const open = await vscode.window.showInformationMessage(
      'Open the project as a workspace folder to run HuxerUI tasks.', 'Open Folder');
    if (open) {
      await vscode.commands.executeCommand('vscode.openFolder', selected);
    }
    return undefined;
  }
  const projects = await inspectProjects(owner, selected);
  if (!projects.length) {
    throw new Error('The selected directory does not contain a recognized HuxerUI project.');
  }
  return chooseProject(projects);
}
