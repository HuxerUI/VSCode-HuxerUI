import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { targetAbis } from './abi';
import { Project } from './projects';
import { Sdk, sdkCommand, sdkEnvironment } from './sdk';

const execFileAsync = promisify(execFile);

export type MobileTarget = 'android' | 'ios';

export interface Device {
  id: string;
  label: string;
  abis?: string[];
  kind?: 'physical' | 'simulator';
}

export function isMobile(target: unknown): target is MobileTarget {
  return target === 'android' || target === 'ios';
}

export async function readyDevices(sdk: Sdk, project: Project, target: MobileTarget): Promise<Device[]> {
  const output = await sdkCommand(sdk, ['devices', target], project.root.fsPath);
  const ready: Device[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*\[ready\]\s+(\S+)(?:\s+\((.+)\))?\s*$/.exec(line);
    if (match) {
      ready.push({ id: match[1], label: match[2] ?? match[1] });
    }
  }
  if (!ready.length) {
    return ready;
  }
  if (target === 'ios') {
    const simulators = await execFileAsync('xcrun', ['simctl', 'list', 'devices', '--json'], {
      cwd: project.root.fsPath, env: sdkEnvironment(sdk), timeout: 5_000,
    }).then(result => {
      const output = JSON.parse(result.stdout) as { devices: Record<string, { udid: string }[]> };
      return new Set(Object.values(output.devices).flat().map(device => device.udid.toLowerCase()));
    }).catch(() => undefined);
    return simulators ? ready.map(device => ({
      ...device, kind: simulators.has(device.id.toLowerCase()) ? 'simulator' : 'physical',
    })) : ready;
  }
  // Use the ADB selected by this SDK for the project, including any local.properties override.
  const adbPath = await sdkCommand(sdk,
    ['doctor', 'android', '--operation', 'devices', '--sdk', sdk.root, '--json'], project.root.fsPath)
    .then(output => {
      const plan = JSON.parse(output) as { schema: number; checks: { id: string; status: string; path?: string }[] };
      return plan.schema === 1 ? plan.checks.find(check => check.id === 'android.platform_tools' &&
        check.status === 'ready')?.path : undefined;
    }).catch(() => undefined);
  if (typeof adbPath !== 'string' || !path.isAbsolute(adbPath)) {
    return ready;
  }
  return Promise.all(ready.map(async device => {
    for (const property of ['ro.product.cpu.abilist', 'ro.product.cpu.abi']) {
      const result = await execFileAsync(adbPath, ['-s', device.id, 'shell', 'getprop', property], {
        cwd: project.root.fsPath, windowsHide: true, timeout: 3_000,
      }).catch(() => undefined);
      const abis = result?.stdout.trim().split(',').map(abi => abi.trim()).filter(Boolean);
      if (abis?.length && abis.every(abi => /^[a-z0-9_-]+$/.test(abi))) {
        return { ...device, abis };
      }
    }
    return device;
  }));
}

export function androidDeviceAbis(device: Device, selected?: string[], required = false): string[] | undefined {
  if (!device.abis?.length) {
    if (required) {
      throw new Error('Could not read the ABI of ' + device.label + '. Refresh devices or choose an ABI manually.');
    }
    return selected;
  }
  const compatible = device.abis.find(abi => (selected ?? targetAbis.android).includes(abi));
  if (!compatible) {
    throw new Error('No compatible Android ABI for ' + device.label + ' (device: ' + device.abis.join(', ') + ').');
  }
  return selected ?? [compatible];
}

export function deviceHelp(target: MobileTarget): string {
  return target === 'android'
    ? 'Start an emulator or connect and authorize an ADB device.'
    : 'Start an Xcode simulator or connect and pair an iOS device.';
}
