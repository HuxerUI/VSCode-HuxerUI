import * as vscode from 'vscode';
import { pathInProject } from './projects';

const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const compiler = /^(.+?):(\d+)(?::(\d+))?:\s*(fatal error|error|warning|note):\s*(.+)$/;
const msvc = /^(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(fatal error|error|warning|note)(?:\s+(\w+))?\s*:\s*(.+)$/;
const cmake = /^CMake (Error|Warning)(?: \([^)]+\))? at (.+?):(\d+)(?: \(([^)]+)\))?:\s*(.*)$/;

function parse(line: string): { file: string; row: number; column: number; severity: vscode.DiagnosticSeverity; message: string } | undefined {
  const text = line.replace(ansi, '').trim();
  const clang = compiler.exec(text);
  const visualCpp = !clang && msvc.exec(text);
  const config = !clang && !visualCpp && cmake.exec(text);
  const diagnostic = clang
    ? { file: clang[1], row: clang[2], column: clang[3], kind: clang[4], message: clang[5] }
    : visualCpp
      ? { file: visualCpp[1], row: visualCpp[2], column: visualCpp[3], kind: visualCpp[4],
        message: [visualCpp[5], visualCpp[6]].filter(Boolean).join(' ') }
      : config
        ? { file: config[2], row: config[3], column: undefined, kind: config[1],
          message: config[5] || [config[4], 'See the task terminal for details.'].filter(Boolean).join(' ') }
        : undefined;
  if (!diagnostic || Number(diagnostic.row) < 1) {
    return undefined;
  }
  const severity = {
    warning: vscode.DiagnosticSeverity.Warning,
    note: vscode.DiagnosticSeverity.Information,
  }[diagnostic.kind.toLowerCase()] ?? vscode.DiagnosticSeverity.Error;
  return {
    file: diagnostic.file, row: Number(diagnostic.row) - 1,
    column: Math.max(0, Number(diagnostic.column ?? 1) - 1),
    severity, message: diagnostic.message,
  };
}

export class Diagnostics implements vscode.Disposable {
  private readonly projects = new Map<string, vscode.DiagnosticCollection>();

  clear(root: vscode.Uri): void {
    this.projects.get(root.toString())?.clear();
  }

  add(root: vscode.Uri, line: string): void {
    const parsed = parse(line);
    if (!parsed) {
      return;
    }
    const { row, column, severity, message } = parsed;
    let collection = this.projects.get(root.toString());
    if (!collection) {
      collection = vscode.languages.createDiagnosticCollection('huxerui');
      this.projects.set(root.toString(), collection);
    }
    const file = pathInProject(root, parsed.file);
    const range = new vscode.Range(row, column, row, column + 1);
    const existing = collection.get(file) ?? [];
    if (!existing.some(item => item.range.isEqual(range) && item.severity === severity && item.message === message)) {
      const diagnostic = new vscode.Diagnostic(range, message, severity);
      diagnostic.source = 'HuxerUI';
      collection.set(file, [...existing, diagnostic]);
    }
  }

  dispose(): void {
    this.projects.forEach(collection => collection.dispose());
    this.projects.clear();
  }
}
