import * as vscode from 'vscode';
import { projectsForFile } from './projects';
import { findResource, ResourceKind } from './resources';

const attribute = /\[\[\s*(?:(huxerui)\s*::\s*)?([A-Za-z_]\w*)?$/;
const resourceReference = /\b((?:[A-Za-z_]\w*\s*::\s*)*)(images|raw|strings)\s*::\s*([A-Za-z_]\w*)/gd;
const nonCode = /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|R"([^()\s\\]{0,16})\([\s\S]*?(?:\)\1"|$)|"(?:\\[\s\S]|[^"\\\r\n])*"?|\b\d[\w.']*|'(?:\\[\s\S]|[^'\\\r\n])*'?/g;
const resourceContext = 'huxerui.resourceReference';

function isCode(document: vscode.TextDocument, position: vscode.Position): boolean {
  const offset = document.offsetAt(position);
  for (const match of document.getText().matchAll(nonCode)) {
    if (match.index > offset) {
      break;
    }
    if (match.index + match[0].length > offset) {
      return false;
    }
  }
  return true;
}

async function provideCompletionItems(document: vscode.TextDocument, position: vscode.Position,
                                      token: vscode.CancellationToken): Promise<vscode.CompletionItem[] | undefined> {
  const line = document.lineAt(position).text;
  const match = attribute.exec(line.slice(0, position.character));
  if (!match) {
    return;
  }
  const typed = match[2] ?? '';
  const completion = match[1] ? 'composable' : 'huxerui::composable';
  const filter = completion.startsWith(typed) ? completion : 'composable';
  if (!filter.startsWith(typed) || !isCode(document, position.with(undefined, match.index)) ||
      !(await projectsForFile(document.uri)).length || token.isCancellationRequested) {
    return;
  }

  const suffix = line.slice(position.character);
  const replace = (match[1] ? /^\w*(?:\s*\]){0,2}/ : /^\w*(?:\s*::\s*\w*)?(?:\s*\]){0,2}/).exec(suffix)![0];
  const item = new vscode.CompletionItem('[[huxerui::composable]]', vscode.CompletionItemKind.Keyword);
  item.range = new vscode.Range(position.with(undefined, position.character - typed.length),
    position.with(undefined, position.character + replace.length));
  item.insertText = completion + ']]';
  item.filterText = filter;
  return [item];
}

function referenceAt(document: vscode.TextDocument, position: vscode.Position) {
  for (const reference of document.lineAt(position).text.matchAll(resourceReference)) {
    const [start, end] = reference.indices![3];
    if (position.character >= start && position.character <= end) {
      return {
        range: new vscode.Range(position.line, start, position.line, end),
        namespace: reference[1].replace(/\s/g, '').replace(/::$/, ''),
        kind: reference[2] as ResourceKind,
        identifier: reference[3],
      };
    }
  }
}

async function provideDefinition(document: vscode.TextDocument, position: vscode.Position,
                                 token?: vscode.CancellationToken): Promise<vscode.DefinitionLink[] | undefined> {
  const reference = referenceAt(document, position);
  if (!reference || !isCode(document, reference.range.start)) {
    return;
  }
  const project = (await projectsForFile(document.uri)).find(candidate => candidate.buildSystem === 'cmake');
  if (!project || token?.isCancellationRequested) {
    return;
  }
  const location = await findResource(project, document.uri, reference.namespace, reference.kind, reference.identifier, token);
  if (location && !token?.isCancellationRequested) {
    return [{ originSelectionRange: reference.range, targetUri: location.uri, targetRange: location.range }];
  }
}

// Prefer the source asset on F12 when another provider also finds a generated declaration.
async function goToResource(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.languageId === 'cpp') {
    const position = editor.selection.active;
    const [definition] = await provideDefinition(editor.document, position) ?? [];
    if (vscode.window.activeTextEditor !== editor || !editor.selection.active.isEqual(position)) {
      return;
    }
    if (definition) {
      await vscode.commands.executeCommand('vscode.open', definition.targetUri, { selection: definition.targetRange });
      return;
    }
  }
  await vscode.commands.executeCommand('editor.action.revealDefinition');
}

export function registerEditorFeatures(context: vscode.ExtensionContext): void {
  let resourceActive: boolean | undefined;
  const refreshResourceContext = () => {
    const editor = vscode.window.activeTextEditor;
    const active = Boolean(editor?.document.languageId === 'cpp' && vscode.workspace.getWorkspaceFolder(editor.document.uri) &&
      referenceAt(editor.document, editor.selection.active));
    if (active !== resourceActive) {
      resourceActive = active;
      void vscode.commands.executeCommand('setContext', resourceContext, active);
    }
  };
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider('cpp', { provideCompletionItems }, '[', ':'),
    vscode.languages.registerDefinitionProvider('cpp', { provideDefinition }),
    vscode.commands.registerCommand('huxerui.goToResource', goToResource),
    vscode.window.onDidChangeActiveTextEditor(refreshResourceContext),
    vscode.window.onDidChangeTextEditorSelection(refreshResourceContext),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshResourceContext),
  );
  refreshResourceContext();
}
