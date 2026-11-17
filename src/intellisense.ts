import * as path from 'node:path';
import * as vscode from 'vscode';
import { inspectProjects } from './projects';
import { SdkSelection } from './sdk';

// The SDK writes generated sources under hcg/<target>/<16-character source hash>.
const generatedComposables = '**/hcg/*/????????????????/**';

async function configureFolder(
  folder: vscode.WorkspaceFolder,
  sdkSelection: SdkSelection,
  state: vscode.Memento,
): Promise<void> {
  const projects = await inspectProjects(folder);
  if (!projects.some(project => project.buildSystem === 'cmake')) {
    return;
  }

  const sdk = await sdkSelection.resolve(folder.uri, false).catch(() => undefined);
  const include = sdk && path.join(sdk.root, 'include');
  const stateKey = 'intelliSense.include:' + folder.uri.toString();
  const previous = state.get<string>(stateKey);
  if (!include && !previous) {
    return;
  }

  // CMake Tools supplies full flags for target sources. The SDK include path
  // is the fallback for handwritten files that CMake replaces with hcg output.
  const config = vscode.workspace.getConfiguration('C_Cpp', folder.uri);
  const target = vscode.ConfigurationTarget.WorkspaceFolder;
  const paths = config.get<string[]>('default.includePath') ?? [];
  const next = [...paths];
  const previousIndex = previous ? next.indexOf(previous) : -1;
  if (previousIndex >= 0) {
    next.splice(previousIndex, 1);
  }
  const added = include && !next.includes(include) ? include : undefined;
  if (added) {
    if (!paths.length) {
      next.push('${workspaceFolder}/**');
    }
    next.splice(previousIndex >= 0 ? previousIndex : next.length, 0, added);
  }
  if (next.length !== paths.length || next.some((entry, index) => entry !== paths[index])) {
    await config.update('default.includePath', next, target);
  }
  if (added !== previous) {
    await state.update(stateKey, added);
  }
  if (!include) {
    return;
  }
  if (!config.get<string>('default.cppStandard')) {
    await config.update('default.cppStandard', 'c++20', target);
  }
  if (config.get<Record<string, boolean>>('files.exclude')?.[generatedComposables] === undefined) {
    const local = config.inspect<Record<string, boolean>>('files.exclude')?.workspaceFolderValue;
    await config.update('files.exclude', { ...local, [generatedComposables]: true }, target);
  }
}

export function registerIntelliSense(context: vscode.ExtensionContext, sdkSelection: SdkSelection): void {
  let pending = Promise.resolve();
  function refresh(): void {
    if (!vscode.workspace.isTrusted || !vscode.extensions.getExtension('ms-vscode.cpptools')) {
      return;
    }
    pending = pending.then(async () => {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        await configureFolder(folder, sdkSelection, context.globalState).catch(error => {
          console.warn('Could not configure HuxerUI IntelliSense for ' + folder.name, error);
        });
      }
    });
  }
  context.subscriptions.push(
    sdkSelection.onDidChangeSelection(refresh),
    vscode.workspace.onDidGrantWorkspaceTrust(refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('huxerui')) {
        refresh();
      }
    }),
  );
  refresh();
}
