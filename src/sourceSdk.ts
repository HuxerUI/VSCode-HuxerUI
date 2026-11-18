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

export function cachedSourceCli(root: string, storage: string): string {
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
  return [explicit, cachedSourceCli(root, storage), ...builds.flatMap(build => cliOutputs(path.join(root, build)))]
    .filter((file): file is string => Boolean(file));
}

function needsMsvcEnvironment(error: unknown): boolean {
  const generator = process.env.CMAKE_GENERATOR;
  const isCommandLineGenerator = !generator || /^(NMake Makefiles(?: JOM)?|Ninja(?: Multi-Config)?)$/.test(generator);
  const { stderr } = error as { stderr?: string };
  return process.platform === 'win32' && isCommandLineGenerator &&
    !process.env.VCToolsInstallDir && !process.env.CXX && !process.env.CMAKE_TOOLCHAIN_FILE &&
    /CMAKE_CXX_COMPILER not set|No CMAKE_CXX_COMPILER could be found/.test(stderr ?? '');
}

async function msvcEnvironment(): Promise<NodeJS.ProcessEnv> {
  const installHint = 'Install the Desktop development with C++ workload and a Windows SDK in Visual Studio Installer.';
  const programFiles = process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles;
  const locator = programFiles && path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!locator || !(await fs.stat(locator).catch(() => undefined))?.isFile()) {
    throw new Error(installHint);
  }
  const options = { windowsHide: true, timeout: 30_000 };
  const { stdout: developerCommand } = await execFileAsync(locator, [
    '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-utf8', '-find', 'Common7\\Tools\\VsDevCmd.bat',
  ], options);
  if (!developerCommand.trim()) {
    throw new Error(installHint);
  }

  // Run from the script directory so the installation path does not need cmd.exe quoting.
  const { stdout } = await execFileAsync(process.env.ComSpec ?? 'cmd.exe', [
    '/d', '/s', '/u', '/c', 'call .\\VsDevCmd.bat -no_logo -arch=x64 -host_arch=x64 >nul && set',
  ], { ...options, cwd: path.dirname(developerCommand.trim()), windowsVerbatimArguments: true, encoding: 'utf16le' });
  return Object.fromEntries(stdout.split(/\r?\n/).flatMap(line => {
    const separator = line.indexOf('=');
    return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
  }));
}

export async function buildSourceCli(root: string, storage: string, verify: (file: string) => Promise<void>): Promise<string> {
  const destination = cachedSourceCli(root, storage);
  const builds = path.join(storage, 'source-cli');
  await fs.mkdir(builds, { recursive: true });
  const stage = await fs.mkdtemp(path.join(builds, '.build-'));
  const options = { windowsHide: true, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 };
  const configure = (directory: string, env?: NodeJS.ProcessEnv) => execFileAsync('cmake', [
    '-S', path.join(root, 'tools', 'huxerui_cli'), '-B', directory, '-DCMAKE_BUILD_TYPE=Release',
  ], { ...options, env });
  try {
    let build = stage;
    let env: NodeJS.ProcessEnv | undefined;
    try {
      await configure(build);
    } catch (error) {
      if (!needsMsvcEnvironment(error)) {
        throw error;
      }
      env = await msvcEnvironment();
      // CMake may have cached the failed toolchain detection.
      build = path.join(stage, 'msvc');
      await configure(build, env);
    }
    await execFileAsync('cmake', ['--build', build, '--config', 'Release', '--target', 'huxerui_cli',
      '--parallel', '4'], { ...options, env });
    // The standalone CLI embeds its templates. Cache the binary so the checkout stays free of generated files.
    await fs.mkdir(path.dirname(destination), { recursive: true });
    for (const file of cliOutputs(build)) {
      if ((await fs.stat(file).catch(() => undefined))?.isFile()) {
        await verify(file);
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
