import * as vscode from 'vscode';
import { BuildSystem, isDirectory, Target, targets } from './projects';
import { Sdk, sdkEnvironment, SdkSelection } from './sdk';
import { HuxerTasks } from './tasks';

export const defaultAppPlatforms: readonly Target[] = targets.filter(target => target !== 'web');

export interface ProjectInput {
  kind: 'app' | 'library';
  name: string;
  projectId: string;
  parent: vscode.Uri;
  buildSystem: BuildSystem;
  platforms: Target[];
  template?: 'app' | 'navigation';
}

export function isProjectName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(name);
}

export function projectIdError(id: string): string | undefined {
  if (!id) {
    return 'Enter a project ID.';
  }
  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(id)) {
    return 'Use a lowercase reverse-domain project ID such as com.example.myapp. Start each segment with a letter.';
  }
  return undefined;
}

export class ExistingProjectDirectory extends Error {
  constructor(readonly root: vscode.Uri) {
    super('The project directory already exists.');
  }
}

export async function projectDestination(input: ProjectInput): Promise<vscode.Uri> {
  if (!isProjectName(input.name)) {
    throw new Error('Start the project name with a letter and use only letters, digits, underscores, or hyphens.');
  }
  const idError = input.buildSystem === 'cmake' && projectIdError(input.projectId);
  if (idError) {
    throw new Error(idError);
  }
  const root = vscode.Uri.joinPath(input.parent, input.name);
  try {
    const existing = await vscode.workspace.fs.stat(root);
    if (existing.type & vscode.FileType.Directory) {
      throw new ExistingProjectDirectory(root);
    }
    throw new Error('The project path is already in use.');
  } catch (error) {
    if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
      throw error;
    }
  }
  return root;
}

export async function generateProject(input: ProjectInput, root: vscode.Uri, sdk: Sdk,
                                      sdkSelection: SdkSelection, tasks: HuxerTasks): Promise<void> {
  const args = ['create', input.kind, input.name, '--build', input.buildSystem, '--agent', 'none'];
  if (input.buildSystem === 'cmake') {
    args.push('--id', input.projectId);
    if (input.kind === 'app' && !input.platforms.length) {
      throw new Error('Select at least one application platform.');
    }
    if (input.platforms.length) {
      args.push('--platform', input.platforms.join(','));
    }
  }
  if (input.kind === 'app' && input.buildSystem === 'mcpp' && input.template) {
    args.push('--template', input.template);
  }
  const code = await tasks.create(vscode.workspace.getWorkspaceFolder(input.parent), root, {
    executable: sdk.cli, args, cwd: input.parent.fsPath, env: sdkEnvironment(sdk),
  });
  if (code !== 0) {
    throw new Error('Project creation did not complete. See the task terminal for details.');
  }
  if (input.kind === 'library' && input.buildSystem === 'cmake' && input.platforms.includes('web')) {
    // The SDK creates a Web Preview but leaves the library's Web source folder to the caller.
    const webSources = vscode.Uri.joinPath(root, 'platform', 'web', 'src');
    if (!await isDirectory(webSources)) {
      await vscode.workspace.fs.createDirectory(webSources);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(webSources, '.gitkeep'), new Uint8Array());
    }
  }
  await sdkSelection.save(root, sdk);
}
