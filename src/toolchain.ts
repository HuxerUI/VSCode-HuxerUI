import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { isMobile } from './devices';
import { Project, Target } from './projects';
import { Sdk, sdkEnvironment } from './sdk';
import { Action, HuxerTasks } from './tasks';

const execFileAsync = promisify(execFile);
type Operation = 'build' | 'run' | 'package';

interface ToolchainRequest {
  target: Target;
  operation: Operation;
  device?: string;
  abis?: string[];
}

interface Check {
  id: string;
  status: string;
  label: string;
  detail?: string;
}

interface Plan {
  schema: 1;
  operation: Operation;
  targets: { platform: Target; ready: boolean; requires: string[] }[];
  checks: Check[];
  actions: { kind: 'automatic' | 'manual'; description: string }[];
  projectErrors: string[];
}

export function toolchainOperation(action: Action): Operation {
  return action === 'run' || action === 'watch' ? 'run' : action === 'package' ? 'package' : 'build';
}

function requireProject(project: Project): void {
  if (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(project.root)) {
    throw new Error('Open the project in a trusted workspace to prepare its toolchain.');
  }
}

async function diagnose(project: Project, sdk: Sdk, request: ToolchainRequest, flags: string[]): Promise<Plan> {
  requireProject(project);
  let output: string;
  try {
    ({ stdout: output } = await execFileAsync(sdk.cli, ['doctor', ...flags, '--json'], {
      cwd: project.root.fsPath, env: sdkEnvironment(sdk), windowsHide: true, timeout: 60_000,
    }));
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (failure.code !== 1 || !failure.stdout) {
      throw new Error('HuxerUI could not check the toolchain. ' + (failure.stderr?.trim() || String(error)));
    }
    // Missing tools and invalid projects still produce a complete plan.
    output = failure.stdout;
  }

  try {
    const plan = JSON.parse(output) as Plan;
    if (plan.schema === 1 && plan.operation === request.operation && Array.isArray(plan.targets) &&
        plan.targets.length === 1 && plan.targets[0].platform === request.target &&
        typeof plan.targets[0].ready === 'boolean' && Array.isArray(plan.targets[0].requires) &&
        Array.isArray(plan.checks) && Array.isArray(plan.actions) && Array.isArray(plan.projectErrors)) {
      return plan;
    }
  } catch {
    // An unexpected CLI response cannot authorize installing any tools.
  }
  throw new Error('The selected SDK CLI returned an invalid toolchain plan. Update the SDK or rebuild its source CLI.');
}

function outstanding(plan: Plan): Check[] {
  return plan.checks.filter(check => check.status !== 'ready' && plan.targets[0].requires.includes(check.id));
}

function toolsReady(plan: Plan, request: ToolchainRequest): boolean {
  if (plan.projectErrors.length) {
    throw new Error(plan.projectErrors.join('\n'));
  }
  if (plan.targets[0].ready) {
    return true;
  }
  const missing = outstanding(plan);
  // Device selection can finish after installation, even when setup reports an incomplete run environment.
  return request.operation === 'run' && isMobile(request.target) &&
    missing.length === 1 && missing[0].id === request.target + '.device';
}

function remediation(plan: Plan): string {
  const details = plan.actions.filter(action => action.kind === 'manual').map(action => action.description);
  return (details.length ? details : outstanding(plan).map(check =>
    check.label + (check.detail ? ': ' + check.detail : ''))).join('\n');
}

export async function prepareToolchain(
  tasks: HuxerTasks, project: Project, sdk: Sdk, request: ToolchainRequest, standalone = false,
): Promise<boolean> {
  const flags = [request.target, '--operation', request.operation, '--sdk', sdk.root];
  if (request.device) {
    flags.push('--device', request.device);
  }
  if (request.abis?.length) {
    flags.push('--abi', request.abis.join(','));
  }
  let plan = await diagnose(project, sdk, request, flags);
  if (toolsReady(plan, request)) {
    return true;
  }

  if (!plan.actions.some(action => action.kind === 'automatic')) {
    throw new Error(remediation(plan) || 'The selected toolchain is unavailable.');
  }
  const confirmLabel = standalone ? 'Install' : 'Install and Continue';
  const detail = plan.actions.map(action => action.description).join('\n');
  const code = await tasks.installToolchain(project, {
    executable: sdk.cli, args: ['setup', ...flags, '--yes'], cwd: project.root.fsPath, env: sdkEnvironment(sdk),
  }, request.target, async () => {
    const selected = await vscode.window.showInformationMessage(
      'Prepare the ' + request.target + ' toolchain for ' + path.basename(project.root.fsPath) + '?',
      { modal: true, detail }, confirmLabel);
    if (selected === confirmLabel) {
      requireProject(project);
      return true;
    }
    return false;
  });
  if (code === undefined || code === 3 || code === 130) {
    return false;
  }
  if (code === 4) {
    throw new Error('Restart this host to finish installing the HuxerUI toolchain, then try again.');
  }
  if (code !== 0 && code !== 1) {
    throw new Error('HuxerUI toolchain setup exited with code ' + code + '. See the task terminal.');
  }
  plan = await diagnose(project, sdk, request, flags);
  if (!toolsReady(plan, request)) {
    throw new Error([remediation(plan), 'See the toolchain task terminal for installation details.'].filter(Boolean).join('\n'));
  }
  return true;
}
