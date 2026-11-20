import * as vscode from 'vscode';
import { Project } from './projects';

export type ResourceKind = 'images' | 'raw' | 'strings';

const cppKeywords = new Set((
  'alignas alignof and and_eq asm atomic_cancel atomic_commit atomic_noexcept auto bitand bitor bool break case catch ' +
  'char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await ' +
  'co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for ' +
  'friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected ' +
  'public reflexpr register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct ' +
  'switch synchronized template this thread_local throw true try typedef typeid typename union unsigned using virtual ' +
  'void volatile wchar_t while xor xor_eq'
).split(' '));

// Match the identifiers emitted by the SDK resource compiler.
function resourceIdentifier(key: string): string {
  const normalized = key.replace(/[^A-Za-z0-9]+/g, '_');
  const identifier = !normalized || /^\d/.test(normalized) ? '_' + normalized : normalized;
  return /^_[A-Z]/.test(identifier) || cppKeywords.has(identifier) ? 'resource_' + identifier : identifier;
}

async function stringLocation(root: vscode.Uri, identifier: string): Promise<vscode.Location | undefined> {
  try {
    const catalog = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'default.properties'));
    for (let line = 0; line < catalog.lineCount; line++) {
      const match = /^([ \t]*)([^#=\s][^=]*?)\s*=/.exec(catalog.lineAt(line).text);
      if (match && resourceIdentifier(match[2]) === identifier) {
        const start = match[1].length;
        return new vscode.Location(catalog.uri, new vscode.Range(line, start, line, start + match[2].length));
      }
    }
  } catch {
    // Standard projects can omit the default catalog when they have no strings.
  }
}

async function fileLocation(root: vscode.Uri, kind: 'images' | 'raw', identifier: string,
                            token?: vscode.CancellationToken): Promise<vscode.Location | undefined> {
  const dirs = [root];
  const matches: { uri: vscode.Uri; scale: number }[] = [];
  for (const directory of dirs) {
    if (token?.isCancellationRequested) {
      return;
    }
    const entries = await vscode.workspace.fs.readDirectory(directory).then(undefined, () => []);
    for (const [name, type] of entries) {
      const uri = vscode.Uri.joinPath(directory, name);
      if (type === vscode.FileType.Directory) {
        dirs.push(uri);
      } else if (type & vscode.FileType.File) {
        const relative = uri.path.slice(root.path.length + 1);
        const extension = kind === 'images' ? /\.(?:png|jpe?g|svg)$/i.exec(relative) : undefined;
        if (extension === null) {
          continue;
        }
        const stem = extension ? relative.slice(0, extension.index) : relative;
        const density = extension && /@(\d+)x$/.exec(stem);
        const key = density ? stem.slice(0, density.index) : stem;
        if (resourceIdentifier(key) === identifier) {
          matches.push({ uri, scale: density ? Number(density[1]) : 1 });
        }
      }
    }
  }
  matches.sort((a, b) => a.scale - b.scale || a.uri.path.localeCompare(b.uri.path));
  return matches.length ? new vscode.Location(matches[0].uri, new vscode.Position(0, 0)) : undefined;
}

async function hasNamespace(root: vscode.Uri, namespace: string): Promise<boolean> {
  try {
    const cmake = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'CMakeLists.txt'));
    const source = Buffer.from(cmake).toString('utf8').replace(/^\s*#.*$/gm, '');
    const pattern = /\bRESOURCE_NAMESPACE\s+(?:"([A-Za-z_]\w*)"|([A-Za-z_]\w*)(?=\s|\)))/g;
    return Array.from(source.matchAll(pattern)).some(match => (match[1] ?? match[2]) === namespace);
  } catch {
    return false;
  }
}

export async function findResource(project: Project, source: vscode.Uri, namespace: string, kind: ResourceKind,
                                   identifier: string, token?: vscode.CancellationToken): Promise<vscode.Location | undefined> {
  const roots = project.preview && source.path.startsWith(project.preview.path + '/')
    ? [project.preview, project.root] : [project.root];
  for (const root of roots) {
    if (token?.isCancellationRequested) {
      return;
    }
    if (namespace && !await hasNamespace(root, namespace)) {
      continue;
    }
    const directory = vscode.Uri.joinPath(root, 'resources', kind);
    const location = kind === 'strings' ? await stringLocation(directory, identifier)
      : await fileLocation(directory, kind, identifier, token);
    if (location) {
      return location;
    }
  }
}
