import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createConnection, createServer, Server, Socket } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { targetAbis } from './abi';
import { Device, MobileTarget, readyDevices } from './devices';
import { Project } from './projects';
import { Sdk, sdkEnvironment } from './sdk';
import { HuxerTasks } from './tasks';
import { prepareToolchain } from './toolchain';

const execFileAsync = promisify(execFile);
const active = new Map<string, MobileSession>();

interface MobileSession {
  readonly id: string;
  readonly target: MobileTarget;
  readonly controller: AbortController;
  session?: vscode.DebugSession;
  pending?: Thenable<vscode.DebugConfiguration | undefined>;
  cancellation?: vscode.Disposable;
  startTimeout?: NodeJS.Timeout;
  restartAndroid?: boolean;
  close?: () => Promise<void>;
  releasing?: Promise<void>;
}

type Tool = (args: string[], options?: { timeout?: number; finishOnCancel?: boolean; input?: string }) => Promise<string>;

function tool(executable: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, prefix: string[] = []): Tool {
  return async (args, { timeout = 15_000, finishOnCancel, input } = {}) => {
    const result = execFileAsync(executable, [...prefix, ...args], {
      cwd, env, timeout, signal: finishOnCancel ? undefined : signal, windowsHide: true,
    });
    try {
      if (input) {
        const upload = pipeline(createReadStream(input), result.child.stdin!, { signal });
        await Promise.all([upload, result]);
      }
      return (await result).stdout.trim();
    } catch (error) {
      if (input) {
        result.child.kill();
      }
      const failure = error as { stderr?: string; stdout?: string; message?: string };
      throw new Error([path.basename(executable), ...args].join(' ') + ': ' +
        (failure.stderr?.trim() || failure.stdout?.trim() || failure.message || String(error)));
    }
  };
}

function sourceMap(source: string, canonical: string, artifact: string): Record<string, string> {
  const from = [canonical];
  // The artifact keeps the spelling of the project root used by the build.
  for (let directory = path.dirname(artifact); directory !== path.dirname(directory); directory = path.dirname(directory)) {
    if (path.basename(directory) === '.huxerui' ||
        path.relative(directory, artifact).startsWith(path.join('platform', 'android') + path.sep)) {
      from.push(path.basename(directory) === '.huxerui' ? path.dirname(directory) : directory);
      break;
    }
  }
  return Object.fromEntries(from.filter(root => root !== source).map(root => [root, source]));
}

async function readPlan(file: string): Promise<{ artifact: string; bundle?: string; bundleIdentifier?: string }> {
  const plan = JSON.parse(await fs.readFile(file, 'utf8').catch(() => 'null'));
  if (plan?.schema !== 1 || typeof plan.artifact !== 'string' || !path.isAbsolute(plan.artifact) ||
      !await fs.stat(plan.artifact).then(stat => stat.isFile(), () => false)) {
    throw new Error('The mobile Debug build did not produce a valid application plan at ' + file + '.');
  }
  return plan;
}

async function prepareIos(root: string, sdk: Sdk, device: Device, abis: string[] | undefined,
                          record: MobileSession): Promise<vscode.DebugConfiguration> {
  const signal = record.controller.signal;
  const [canonical, home] = await Promise.all([fs.realpath(root), fs.realpath(sdk.root)]);
  // iOS has no CMake cache at this level. Locate the plan using the CLI's SDK key.
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(home, 'utf8')) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  const variant = 'ios-simulator' + (abis?.length ? '-' + abis.join('+') : '');
  const plan = await readPlan(path.join(root, '.huxerui', 'build', 'home-' + hash.toString(16).padStart(16, '0'),
    variant, 'debug-no-lto', 'huxerui-integration', 'app.json'));
  const { artifact, bundle, bundleIdentifier } = plan;
  if (typeof bundle !== 'string' || !path.isAbsolute(bundle) || !artifact.startsWith(path.normalize(bundle) + path.sep) ||
      typeof bundleIdentifier !== 'string' || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/.test(bundleIdentifier)) {
    throw new Error('The iOS Debug build did not produce a valid simulator app bundle.');
  }
  const simctl = tool('xcrun', root, sdkEnvironment(sdk), signal, ['simctl']);
  await simctl(['install', device.id, bundle], { timeout: 120_000 });
  signal.throwIfAborted();
  record.close = async () => {
    await simctl(['terminate', device.id, bundleIdentifier], { timeout: 5_000, finishOnCancel: true }).catch(() => undefined);
  };
  // Capture the launch result before honoring cancellation so a suspended app can be stopped.
  const output = await simctl(['launch', '--terminate-running-process', '--wait-for-debugger', device.id, bundleIdentifier],
    { finishOnCancel: true });
  const result = /^(.+): ([1-9]\d*)$/.exec(output);
  if (result?.[1] !== bundleIdentifier) {
    throw new Error('Could not identify the iOS simulator process for ' + bundleIdentifier + '.');
  }
  return { name: 'HuxerUI: ' + path.basename(bundle, '.app') + ' (iOS)', type: 'lldb', request: 'attach',
    program: artifact, pid: Number(result[2]), sourceMap: sourceMap(root, canonical, artifact) };
}

async function lldbServer(toolchain: string, abi: string): Promise<string> {
  const prebuilt = path.join(path.resolve(toolchain, '../../..'), 'toolchains', 'llvm', 'prebuilt');
  const arch = abi === 'arm64-v8a' ? 'aarch64' : 'x86_64';
  for (const host of await fs.readdir(prebuilt).catch(() => [])) {
    const clang = path.join(prebuilt, host, 'lib', 'clang');
    for (const version of await fs.readdir(clang).catch(() => [])) {
      const file = path.join(clang, version, 'lib', 'linux', arch, 'lldb-server');
      if (await fs.stat(file).then(stat => stat.isFile(), () => false)) {
        return file;
      }
    }
  }
  throw new Error('The Android NDK selected by the project has no LLDB server for ' + abi + '.');
}

function quoteLldb(value: string): string {
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}

async function androidPid(adb: Tool, packageId: string, signal: AbortSignal): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    signal.throwIfAborted();
    const pid = await adb(['shell', 'pidof', packageId], { timeout: 3_000 }).catch(() => '');
    if (/^[1-9]\d*$/.test(pid)) {
      return pid;
    }
    await delay(200, undefined, { signal });
  }
  throw new Error('The Android application process did not start: ' + packageId + '.');
}

async function prepareAndroid(root: string, sdk: Sdk, device: Device, abi: string,
                              record: MobileSession): Promise<vscode.DebugConfiguration> {
  const signal = record.controller.signal;
  const env = sdkEnvironment(sdk);
  const doctor = tool(sdk.cli, root, env, signal);
  const output = await doctor(['doctor', 'android', '--operation', 'run', '--sdk', sdk.root,
    '--device', device.id, '--abi', abi, '--json'], { timeout: 60_000 });
  const diagnostics = JSON.parse(output) as { schema?: number; checks?: { id: string; status: string; path?: string }[] };
  const findTool = (id: string) => diagnostics.schema === 1 && diagnostics.checks?.find(check =>
    check.id === id && check.status === 'ready')?.path;
  const executable = findTool('android.platform_tools');
  const ndk = findTool('android.android_ndk');
  if (!executable || !ndk || !path.isAbsolute(executable) || !path.isAbsolute(ndk)) {
    throw new Error('Android debugging requires ADB and the project’s Android NDK. Run HuxerUI: Set Up Toolchain.');
  }
  const adb = tool(executable, root, env, signal, ['-s', device.id]);
  const build = path.join(root, 'platform', 'android', 'app', 'build');
  const plan = await readPlan(path.join(build, 'generated', 'huxerui', 'integration', 'debug', abi, 'app.json'));
  const metadata = JSON.parse(await fs.readFile(path.join(build, 'outputs', 'apk', 'debug', 'output-metadata.json'), 'utf8'));
  const packageId = metadata?.applicationId;
  if (typeof packageId !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageId) ||
      !/^[A-Za-z0-9_.-]+\.so$/.test(path.basename(plan.artifact))) {
    throw new Error('The Android Debug build did not produce valid application and native library metadata.');
  }
  const binary = await lldbServer(ndk, abi);
  await adb(['shell', 'run-as', packageId, 'pwd']).catch(error => {
    throw new Error('Could not use run-as for ' + packageId + '. Use a debuggable APK and a device that permits native debugging. ' +
      String(error));
  });
  const pid = await androidPid(adb, packageId, signal);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'huxerui-android-debug-'));
  const serverPath = 'code_cache/huxerui-' + record.id;
  const cleanupOptions = { timeout: 4_000, finishOnCancel: true };
  const clients = new Set<Socket>();
  let relay: Server | undefined;
  let connections = Promise.resolve();
  record.close = async () => {
    record.controller.abort();
    const closed = new Promise<void>(resolve => {
      if (relay) {
        relay.close(() => resolve());
      } else {
        resolve();
      }
    });
    for (const client of clients) {
      client.destroy();
    }
    await Promise.all([closed, connections]);
    await Promise.all([adb(['shell', 'run-as', packageId, 'rm', '-f', serverPath], cleanupOptions).catch(() => undefined),
      fs.rm(work, { recursive: true, force: true })]);
  };
  const program = path.join(work, 'app_process64');
  const processFile = await adb(['shell', 'run-as', packageId, 'readlink', '/proc/' + pid + '/exe']);
  if (!processFile.startsWith('/') || !processFile.endsWith('/app_process64')) {
    throw new Error('Android did not start the expected 64-bit application process.');
  }
  const transfers = await Promise.allSettled([
    adb(['pull', processFile, program]), adb(['pull', '/system/bin/linker64', path.join(work, 'linker64')]),
    adb(['shell', '-T', 'run-as', packageId, 'sh', '-c',
      "'mkdir -p code_cache && cat > " + serverPath + ' && chmod 700 ' + serverPath + "'"], { input: binary, timeout: 60_000 }),
  ]);
  const failed = transfers.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    throw failed.reason;
  }
  signal.throwIfAborted();
  const canonical = await fs.realpath(root);
  const listener = relay = createServer({ pauseOnConnect: true }, client => {
    clients.add(client);
    const disconnected = new Promise<void>(resolve => client.once('close', () => {
      clients.delete(client);
      resolve();
    }));
    client.on('error', () => client.destroy());
    // CodeLLDB reuses its endpoint on Restart. Give each connection its own device-side server.
    connections = connections.then(async () => {
      if (client.destroyed || signal.aborted) {
        client.destroy();
        return;
      }
      if (record.restartAndroid) {
        record.restartAndroid = false;
        await adb(['shell', 'am', 'start', '-S', '-n', packageId + '/.MainActivity']);
      }
      const targetPid = await androidPid(adb, packageId, signal);
      const socket = 'huxerui-' + randomUUID();
      let server: ReturnType<typeof spawn> | undefined;
      let upstream: Socket | undefined;
      let serverError = '';
      try {
        const port = await adb(['forward', 'tcp:0', 'localabstract:' + socket], { finishOnCancel: true });
        if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
          throw new Error('ADB did not provide a local port for Android debugging.');
        }
        signal.throwIfAborted();
        server = spawn(executable, ['-s', device.id, 'shell', '-T', '-n', 'run-as', packageId,
          './' + serverPath, 'gdbserver', 'unix-abstract://' + socket, '--attach', targetPid],
        { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        server.on('error', error => { serverError = error.message; });
        for (const output of [server.stdout, server.stderr]) {
          output?.setEncoding('utf8').on('data', (chunk: string) => { serverError = (serverError + chunk).slice(-4096); });
        }
        const deadline = Date.now() + 10_000;
        while (!client.destroyed && server.exitCode === null && server.signalCode === null && Date.now() < deadline) {
          const status = await adb(['shell', 'run-as', packageId, 'cat', '/proc/' + targetPid + '/status'],
            { timeout: 3_000 }).catch(() => '');
          signal.throwIfAborted();
          if (/^TracerPid:\s+[1-9]\d*/m.test(status) && !client.destroyed) {
            upstream = createConnection(Number(port), '127.0.0.1');
            upstream.on('error', () => client.destroy());
            upstream.once('close', () => client.end());
            client.pipe(upstream).pipe(client);
            await disconnected;
            return;
          }
          await delay(150, undefined, { signal });
        }
        if (!client.destroyed) {
          throw new Error('The Android LLDB server could not attach. ' + serverError.trim());
        }
      } finally {
        upstream?.destroy();
        server?.kill();
        const forwards = await adb(['forward', '--list'], cleanupOptions).catch(() => '');
        for (const line of forwards.split(/\r?\n/)) {
          const [serial, port, name] = line.trim().split(/\s+/);
          if (serial === device.id && name === 'localabstract:' + socket && /^tcp:\d+$/.test(port)) {
            await adb(['forward', '--remove', port], cleanupOptions).catch(() => undefined);
          }
        }
      }
    }).catch(error => {
      if (!signal.aborted && !client.destroyed) {
        vscode.debug.activeDebugConsole.appendLine(error instanceof Error ? error.message : String(error));
      }
      client.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start the Android debug connection.');
  }
  return { name: 'HuxerUI: ' + packageId + ' (Android)', type: 'lldb', request: 'attach', program,
    sourceMap: sourceMap(root, canonical, plan.artifact), initCommands: ['platform select remote-android'],
    // Register the unstripped library before LLDB discovers modules mapped directly from the APK.
    targetCreateCommands: ['target create ' + quoteLldb(program),
      'settings set target.exec-search-paths ' + quoteLldb(work) + ' ' + quoteLldb(path.dirname(plan.artifact)),
      'target modules add ' + quoteLldb(plan.artifact)],
    // Allow the device to relaunch before the handshake and suppress the attach stop.
    processCreateCommands: ['settings set plugin.process.gdb-remote.packet-timeout 30',
      'process handle -s false -n false -p false SIGSTOP', 'gdb-remote 127.0.0.1:' + address.port],
  };
}

function recordFor(session: vscode.DebugSession): MobileSession | undefined {
  return [...active.values()].find(record => record.id === session.configuration.huxeruiMobileSession);
}

function release(key: string, record: MobileSession): Promise<void> {
  clearTimeout(record.startTimeout);
  record.cancellation?.dispose();
  return record.releasing ??= Promise.resolve().then(() => record.close?.()).catch(error => {
    console.warn('Could not clean up HuxerUI mobile debugging.', error);
  }).finally(() => active.delete(key));
}

export function mobileDebugProjects(): string[] {
  return [...active.keys()];
}

export async function stopMobileDebug(key: string): Promise<void> {
  const record = active.get(key);
  if (record) {
    record.controller.abort();
    if (record.session) {
      await vscode.debug.stopDebugging(record.session);
    } else if (!record.pending) {
      await release(key, record);
    }
  }
}

export async function disposeMobileDebug(): Promise<void> {
  await Promise.allSettled([...active].map(async ([key, record]) => {
    await stopMobileDebug(key).catch(() => undefined);
    await Promise.resolve(record.pending).catch(() => undefined);
    await release(key, record);
  }));
}

export function registerMobileDebug(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.debug.onDidStartDebugSession(session => {
    const record = recordFor(session);
    if (record) {
      record.session = session;
      record.cancellation?.dispose();
      if (record.controller.signal.aborted) {
        void vscode.debug.stopDebugging(session);
      }
    }
  }), vscode.debug.onDidTerminateDebugSession(session => {
    const key = [...active].find(([, record]) => record.id === session.configuration.huxeruiMobileSession)?.[0];
    const record = key && active.get(key);
    if (key && record) {
      record.session = undefined;
      void release(key, record);
    }
  }), vscode.debug.registerDebugAdapterTrackerFactory('lldb', {
    createDebugAdapterTracker(session) {
      const record = recordFor(session);
      clearTimeout(record?.startTimeout);
      if (record?.target !== 'android') {
        return;
      }
      let revision = 0;
      let resume = Promise.resolve();
      return { onWillReceiveMessage(message) {
        if (message.type === 'request' && message.command === 'restart') {
          record.restartAndroid = true;
        }
      }, onDidSendMessage(message) {
        if (message.event === 'continued') {
          revision++;
        }
        if (message.event !== 'stopped') {
          return;
        }
        const current = ++revision;
        const stop = message.body;
        const internal = stop?.reason === 'breakpoint' && Array.isArray(stop.hitBreakpointIds) && stop.hitBreakpointIds.length > 0 &&
          stop.hitBreakpointIds.every((id: number) => Number.isInteger(id) && id < 0);
        const nullFault = stop?.reason === 'exception' && /^signal SIGSEGV:.*\bfault address=0x0\)/.test(stop.description ?? '');
        if ((!internal && !nullFault) || !Number.isInteger(stop.threadId) || stop.threadId < 1) {
          return;
        }
        const id: number = stop.threadId;
        // A newer stop can arrive while the stack request is in flight.
        resume = resume.then(async () => {
          if (current !== revision) {
            return;
          }
          const result = await session.customRequest('stackTrace', { threadId: id, levels: 1 });
          const frame = result?.stackFrames?.[0];
          // ART uses null faults in Java JIT code for implicit null checks. Keep native faults visible.
          const managed = typeof frame?.moduleId === 'string' && frame.moduleId.startsWith('JIT(') &&
            /^(?:java|android)\.[\w.$]+$/.test(frame.name ?? '');
          if (current === revision && (internal || managed)) {
            await session.customRequest('continue', { threadId: id });
          }
        }).catch(() => undefined);
      } };
    },
  }));
}

export async function prepareMobileDebug(project: Project, sdk: Sdk, tasks: HuxerTasks, target: MobileTarget,
                                         options: { device?: string; abis?: string[] }, token?: vscode.CancellationToken):
  Promise<vscode.DebugConfiguration | undefined> {
  const key = project.root.toString();
  if (active.has(key)) {
    throw new Error('Stop the active HuxerUI mobile debug session for this project first.');
  }
  const record: MobileSession = { id: randomUUID(), target, controller: new AbortController() };
  const signal = record.controller.signal;
  if (token?.isCancellationRequested) {
    return;
  }
  active.set(key, record);
  let prepared: vscode.DebugConfiguration | undefined;
  record.cancellation = token?.onCancellationRequested(() => void stopMobileDebug(key).catch(() => undefined));
  try {
    record.pending = vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Preparing HuxerUI Debug',
      cancellable: true }, async (progress, progressToken) => {
      const cancellation = progressToken.onCancellationRequested(() => record.controller.abort());
      const picker = new vscode.CancellationTokenSource();
      const cancelPicker = () => picker.cancel();
      signal.addEventListener('abort', cancelPicker, { once: true });
      try {
        if (!await prepareToolchain(tasks, project, sdk, { target, operation: 'run' })) {
          return;
        }
        signal.throwIfAborted();
        const devices = await readyDevices(sdk, project, target);
        signal.throwIfAborted();
        const ready = target === 'ios' ? devices.filter(device => device.kind === 'simulator') : devices;
        if (!ready.length) {
          throw new Error(target === 'ios' ? 'Boot an iOS simulator to debug.' : 'Connect an authorized Android device or start an emulator.');
        }
        const device = ready.find(item => item.id === options.device) ?? (!options.device && ready.length === 1 ? ready[0] :
          (await vscode.window.showQuickPick(ready.map(device => ({ label: device.label, description: device.id, device })),
            { placeHolder: options.device ? 'The selected device is unavailable. Choose a device to debug' : 'Choose a device to debug' },
            picker.token))?.device);
        if (!device) {
          return;
        }
        signal.throwIfAborted();
        const abi = target === 'android' ? device.abis?.find(item => (options.abis ?? targetAbis.android).includes(item)) : undefined;
        if (target === 'android' && !abi) {
          throw new Error('Could not select a compatible Android ABI for ' + device.label + '. Refresh Devices and check the ABI selection.');
        }
        const abis = abi ? [abi] : options.abis;
        progress.report({ message: 'Building ' + device.label + ' in Debug' });
        const code = await tasks.buildForDebug(project, sdk, target, { device: device.id, abis, lto: 'off' }, signal);
        signal.throwIfAborted();
        if (code !== 0) {
          throw new Error('The HuxerUI Debug build did not complete. See the task terminal for details.');
        }
        progress.report({ message: 'Connecting CodeLLDB' });
        const root = (project.preview ?? project.root).fsPath;
        const configuration = abi ? await prepareAndroid(root, sdk, device, abi, record)
          : await prepareIos(root, sdk, device, abis, record);
        signal.throwIfAborted();
        return { ...configuration, huxeruiMobileSession: record.id, suppressMultipleSessionWarning: true };
      } finally {
        signal.removeEventListener('abort', cancelPicker);
        picker.dispose();
        cancellation.dispose();
      }
    });
    prepared = await record.pending;
    signal.throwIfAborted();
    if (prepared) {
      // Release the device if VS Code abandons the launch before creating an adapter.
      record.startTimeout = setTimeout(() => void stopMobileDebug(key).catch(() => undefined), 30_000).unref();
    }
    return prepared;
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  } finally {
    record.pending = undefined;
    if (!prepared || signal.aborted) {
      await release(key, record);
    }
  }
}
