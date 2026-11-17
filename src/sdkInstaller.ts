import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const releases = 'https://github.com/HuxerUI/HuxerUI/releases';

export function isSupportedSdkVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(version);
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 5));
}

async function releaseVersion(pin: string, signal: AbortSignal): Promise<string> {
  if (pin) {
    if (!isSupportedSdkVersion(pin)) {
      throw new Error('Set huxerui.sdkVersion to an exact SDK version of 0.5.0 or later.');
    }
    return pin;
  }
  const response = await fetch(releases + '/latest', { redirect: 'manual', signal });
  await response.body?.cancel();
  if (response.status < 300 || response.status >= 400) {
    throw new Error('Could not find the latest HuxerUI release (HTTP ' + response.status + ').');
  }
  const location = response.headers.get('location') ?? '';
  const version = /^\/HuxerUI\/HuxerUI\/releases\/tag\/v(\d+\.\d+\.\d+)$/.exec(new URL(location, releases).pathname)?.[1];
  if (!version || !isSupportedSdkVersion(version)) {
    throw new Error('A HuxerUI 0.5.0 or newer SDK is not published yet. Use a current source checkout in the meantime.');
  }
  return version;
}

export async function runSdkInstaller(
  pin: string,
  prefix: string,
  hasStandardSdk: boolean,
  signal: AbortSignal,
  report: (message: string) => void,
): Promise<string> {
  report('Checking the HuxerUI release');
  const version = await releaseVersion(pin, signal);
  const versionedPrefix = path.join(prefix + '-versions', version);
  const installPrefix = hasStandardSdk ? prefix : versionedPrefix;
  const canSelect = hasStandardSdk || (await fs.stat(versionedPrefix).catch(() => undefined))?.isDirectory();
  const windows = process.platform === 'win32';
  const name = windows ? 'install.ps1' : 'install.sh';
  report('Downloading the official HuxerUI installer');
  const response = await fetch(releases + '/download/v' + version + '/' + name, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Could not download the HuxerUI ' + version + ' installer (HTTP ' + response.status + ').');
  }
  const contents = Buffer.from(await response.arrayBuffer());
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huxerui-installer-'));
  try {
    const script = path.join(directory, name);
    await fs.writeFile(script, contents, { signal });
    const executable = windows ? 'powershell.exe' : '/bin/sh';
    const args = windows
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
          '-Version', version, '-Prefix', installPrefix, '-Yes']
      : [script, '--version', version, '--prefix', installPrefix, '--yes'];
    if (canSelect) {
      // Use the installer's version-selection mode to keep existing SDKs in place.
      args.push(windows ? '-Sdk' : '--sdk', 'use');
    }
    report('Running the official HuxerUI ' + version + ' installer');
    try {
      await execFileAsync(executable, args, { signal, windowsHide: true });
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }
      const failure = error as Error & { stderr?: string; stdout?: string };
      const details = failure.stderr?.trim() || failure.stdout?.trim() || failure.message;
      throw new Error('The HuxerUI installer failed. ' + details);
    }
    return version;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
