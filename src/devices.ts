import { Project } from './projects';
import { Sdk, sdkCommand } from './sdk';

export type MobileTarget = 'android' | 'ios';

export interface Device {
  id: string;
  label: string;
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
  return ready;
}

export function deviceHelp(target: MobileTarget): string {
  return target === 'android'
    ? 'Start an emulator or connect and authorize an ADB device.'
    : 'Start an Xcode simulator or connect and pair an iOS device.';
}
