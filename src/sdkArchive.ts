import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const releases = 'https://github.com/HuxerUI/HuxerUI/releases';

export function isSupportedSdkVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(version);
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 5));
}

function archiveName(version: string): string {
  if (process.platform === 'win32' && process.arch === 'x64') {
    return 'huxerui-sdk-' + version + '-windows-x86_64.zip';
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const platform = process.platform === 'darwin' ? 'macos' : 'linux';
    const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64'
      ? (platform === 'macos' ? 'arm64' : 'aarch64') : undefined;
    if (arch) {
      return 'huxerui-sdk-' + version + '-' + platform + '-' + arch + '.tar.gz';
    }
  }
  throw new Error('No HuxerUI SDK archive is published for ' + process.platform + ' ' + process.arch + '.');
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

export async function managedSdkFolders(storage: string): Promise<string[]> {
  const directory = path.join(storage, 'sdks');
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isDirectory() && entry.name.startsWith('huxerui-sdk-'))
    .map(entry => path.join(directory, entry.name));
}

async function getAsset(url: string, name: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Could not download ' + name + ' (HTTP ' + response.status + '). Check the release and host architecture.');
  }
  return response;
}

async function downloadVerifiedArchive(url: string, name: string, file: string, signal: AbortSignal): Promise<void> {
  const checksum = await getAsset(url + '.sha256', name + '.sha256', signal);
  const entry = /^([a-f0-9]{64})[ \t]+\*?([^\r\n]+)$/i.exec((await checksum.text()).trim());
  if (!entry || entry[2] !== name) {
    throw new Error('The SDK checksum file does not name ' + name + '.');
  }

  const response = await getAsset(url, name, signal);
  if (!response.body) {
    throw new Error('The SDK download did not contain an archive.');
  }
  const digest = createHash('sha256');
  const hashStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
    hashStream, createWriteStream(file, { flags: 'wx' }), { signal });
  if (digest.digest('hex') !== entry[1].toLowerCase()) {
    throw new Error('The downloaded HuxerUI SDK failed SHA-256 verification.');
  }
}

async function unpack(file: string, stage: string, archiveRoot: string, signal: AbortSignal): Promise<void> {
  const options = { signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
  const executable = process.platform === 'win32' ? 'tar.exe' : 'tar';
  try {
    const { stdout } = await execFileAsync(executable, ['-tf', file], options);
    const entries = stdout.split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.some(entry =>
      (entry !== archiveRoot && !entry.startsWith(archiveRoot + '/')) ||
      entry.includes('\\') || entry.split('/').includes('..'))) {
      throw new Error('The SDK archive contains a path outside its expected directory.');
    }
    await execFileAsync(executable, ['-xf', file, '-C', stage, '--no-same-owner'], options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Install the system tar utility on this host to unpack the HuxerUI SDK.');
    }
    throw error;
  }
}

export async function installManagedSdk<T>(
  storage: string,
  pin: string,
  inspect: (root: string, version: string) => Promise<T | undefined>,
  signal: AbortSignal,
  report: (message: string) => void,
): Promise<T> {
  report('Checking the HuxerUI release');
  const version = await releaseVersion(pin, signal);
  const name = archiveName(version);
  const archiveRoot = name.replace(/(?:\.tar\.gz|\.zip)$/, '');
  const directory = path.join(storage, 'sdks');
  const destination = path.join(directory, archiveRoot);

  const installed = await inspect(destination, version);
  if (installed !== undefined) {
    return installed;
  }

  await fs.mkdir(directory, { recursive: true });
  const stage = await fs.mkdtemp(path.join(directory, '.install-'));
  try {
    const archive = path.join(stage, name);
    report('Downloading HuxerUI ' + version);
    await downloadVerifiedArchive(releases + '/download/v' + version + '/' + name, name, archive, signal);
    report('Unpacking the verified SDK');
    await unpack(archive, stage, archiveRoot, signal);

    const extracted = path.join(stage, archiveRoot);
    const usable = (await fs.lstat(extracted)).isDirectory() && await inspect(extracted, version);
    if (!usable) {
      throw new Error('The archive does not contain a usable HuxerUI ' + version + ' SDK for this host.');
    }

    signal.throwIfAborted();
    // Publish only a complete SDK. A concurrent window can publish the same version first.
    try {
      await fs.rename(extracted, destination);
    } catch (error) {
      const existing = await inspect(destination, version);
      if (existing !== undefined) {
        return existing;
      }
      throw error;
    }
    const sdk = await inspect(destination, version);
    if (sdk === undefined) {
      throw new Error('Could not open the installed HuxerUI SDK at ' + destination + '.');
    }
    return sdk;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
