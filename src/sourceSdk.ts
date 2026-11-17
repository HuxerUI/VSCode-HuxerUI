import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const executableName = process.platform === 'win32' ? 'huxerui.exe' : 'huxerui';

export async function isSourceCheckout(root: string): Promise<boolean> {
  try {
    const markers = await Promise.all([
      fs.stat(path.join(root, 'CMakeLists.txt')),
      fs.stat(path.join(root, 'cmake', 'HuxerUIApp.cmake')),
      fs.stat(path.join(root, 'include', 'huxerui', 'huxerui.h')),
      fs.stat(path.join(root, 'tools', 'huxerui_cli', 'CMakeLists.txt')),
      fs.stat(path.join(root, 'tools', 'prebuilt')),
    ]);
    return markers.slice(0, -1).every(marker => marker.isFile()) && markers[4].isDirectory();
  } catch {
    return false;
  }
}

export async function sourceCheckouts(explicit: string, anchor?: string): Promise<string[]> {
  const candidates = [explicit, process.env.HUXERUI_HOME];
  if (anchor) {
    const parent = path.dirname(anchor);
    candidates.push(anchor, parent, path.join(anchor, 'HuxerUI'), path.join(parent, 'HuxerUI'));
  }
  const checkouts = new Set<string>();
  for (const candidate of candidates) {
    if (candidate && path.isAbsolute(candidate) && await isSourceCheckout(candidate)) {
      const canonical = await fs.realpath(candidate).catch(() => undefined);
      if (canonical) {
        checkouts.add(canonical);
      }
    }
  }
  return Array.from(checkouts);
}

function cachedCli(root: string, storage: string): string {
  const key = createHash('sha256').update(root).digest('hex').slice(0, 20);
  return path.join(storage, 'source-cli', key, executableName);
}

function cliOutputs(build: string): string[] {
  return [
    path.join(build, executableName),
    path.join(build, 'Release', executableName),
    path.join(build, 'Debug', executableName),
    path.join(build, 'bin', executableName),
    path.join(build, 'bin', 'Release', executableName),
    path.join(build, 'bin', 'Debug', executableName),
  ];
}

export async function sourceCliCandidates(root: string, storage: string, explicit?: string): Promise<string[]> {
  // Check conventional in-tree and standalone CMake build directories.
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const builds = ['build', 'out', path.join('out', 'huxerui-cli'),
    ...entries.filter(entry => entry.isDirectory() && entry.name.startsWith('cmake-build-')).map(entry => entry.name)];
  return [explicit, ...builds.flatMap(build => cliOutputs(path.join(root, build))), cachedCli(root, storage)]
    .filter((file): file is string => Boolean(file));
}

export async function buildSourceCli(root: string, storage: string): Promise<string> {
  const destination = cachedCli(root, storage);
  const builds = path.join(storage, 'source-cli');
  await fs.mkdir(builds, { recursive: true });
  const stage = await fs.mkdtemp(path.join(builds, '.build-'));
  const options = { windowsHide: true, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 };
  try {
    await execFileAsync('cmake', ['-S', path.join(root, 'tools', 'huxerui_cli'), '-B', stage,
      '-DCMAKE_BUILD_TYPE=Release'], options);
    await execFileAsync('cmake', ['--build', stage, '--config', 'Release', '--target', 'huxerui_cli',
      '--parallel', '4'], options);
    // The standalone CLI embeds its templates. Cache the binary so the checkout stays free of generated files.
    await fs.mkdir(path.dirname(destination), { recursive: true });
    for (const file of cliOutputs(stage)) {
      if ((await fs.stat(file).catch(() => undefined))?.isFile()) {
        await fs.rename(file, destination);
        return destination;
      }
    }
    throw new Error('The standalone HuxerUI CLI build did not produce an executable.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Install CMake and configure a C++ toolchain to build the HuxerUI CLI from source.');
    }
    throw error;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
