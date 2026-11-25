import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { Project } from './projects';
import { Sdk } from './sdk';
import { HuxerTasks } from './tasks';
import { WebPreviewToolchain } from './toolchain';

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function checkedDirectory(parent: string, name: string): Promise<string> {
  const directory = path.join(parent, name);
  await fs.mkdir(directory, { recursive: true });
  if (path.relative(directory, await fs.realpath(directory)) !== '') {
    throw new Error('The preview directory resolves outside its expected location: ' + directory);
  }
  return directory;
}

async function removeChildDirectory(parent: string, child: string): Promise<void> {
  const real = await fs.realpath(child);
  if (path.relative(child, real) !== '' || path.relative(parent, path.dirname(real)) !== '') {
    throw new Error('Unexpected preview cleanup path: ' + child);
  }
  await fs.rm(real, { recursive: true, force: true, maxRetries: 3 });
}

// Each contender creates its own claim before inspecting all other claims. A stale
// claim can be removed by name without accidentally unlinking a new owner's lock.
async function claimBuild(sitesRoot: string): Promise<string> {
  const host = createHash('sha256').update(hostname()).digest('hex').slice(0, 16);
  const claim = host + '.' + process.pid + '.' + randomUUID() + '.lock';
  const lock = path.join(sitesRoot, claim);
  await fs.writeFile(lock, '', { flag: 'wx' });
  try {
    for (const entry of await fs.readdir(sitesRoot)) {
      if (entry === claim || !entry.endsWith('.lock')) {
        continue;
      }
      const owner = /^([a-f0-9]{16})\.(\d+)\.[\da-f-]+\.lock$/.exec(entry);
      if (owner?.[1] === host && Number(owner[2]) > 0) {
        try {
          process.kill(Number(owner[2]), 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            await fs.rm(path.join(sitesRoot, entry), { force: true });
            continue;
          }
        }
      }
      throw new Error('Another Web Preview owns build/live-preview. Close the preview in the other window first.');
    }
    return lock;
  } catch (error) {
    await fs.unlink(lock);
    throw error;
  }
}

export interface PreviewSite {
  directory: string;
  html: string;
}

interface WebApp {
  target: string;
  artifact: string;
  bundleIdentifier: string;
}

function defaultWebEntry(app: WebApp): string {
  const modulePath = JSON.stringify('./' + encodeURIComponent(path.basename(app.artifact)));
  const storageKey = JSON.stringify(app.bundleIdentifier).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HuxerUI Preview</title>
  <style>
    html, body, #huxerui-root { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  </style>
</head>
<body>
  <div id="huxerui-root"></div>
  <script type="module">
    try {
      const { default: createApp } = await import(${modulePath});
      const app = await createApp({ huxeruiStorageKey: ${storageKey} });
      await document.fonts.ready;
      if (!app.mountHuxerUI("#huxerui-root")) {
        throw new Error("HuxerUI Web session could not be mounted.");
      }
    } catch (error) {
      document.getElementById("huxerui-root").textContent = "Web preview failed to start. " + error.message;
      console.error(error);
    }
  </script>
</body>
</html>`;
}

async function integrationPlans(build: string): Promise<string[]> {
  const integration = path.join(build, 'huxerui-integration');
  const paths: string[] = [];
  try {
    if (path.relative(integration, await fs.realpath(integration)) !== '') {
      throw new Error('Unexpected Web application plan directory.');
    }
    for (const entry of await fs.readdir(integration, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const file = path.join(integration, entry.name, 'Debug', 'app.json');
      try {
        if (path.relative(file, await fs.realpath(file)) !== '') {
          throw new Error('Unexpected Web application plan path: ' + file);
        }
        paths.push(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  return paths;
}

async function readAppPlan(build: string, file: string): Promise<WebApp | undefined> {
  const plan = JSON.parse(await fs.readFile(file, 'utf8'));
  if (plan?.schema !== 1 || plan.target !== path.basename(path.dirname(path.dirname(file))) ||
      !/^[a-zA-Z0-9_.+-]+$/.test(plan.target) || typeof plan.artifact !== 'string' ||
      !path.isAbsolute(plan.artifact) || !within(build, plan.artifact) || path.extname(plan.artifact) !== '.js') {
    return undefined;
  }
  return { target: plan.target, artifact: plan.artifact,
    bundleIdentifier: typeof plan.bundleIdentifier === 'string' && plan.bundleIdentifier ? plan.bundleIdentifier : plan.target };
}

async function findApp(build: string): Promise<WebApp> {
  const plans = await integrationPlans(build);
  if (plans.length !== 1) {
    throw new Error('Expected one Web application in build/live-preview, found ' + plans.length + '. Check the CMake application entry.');
  }
  const app = await readAppPlan(build, plans[0]);
  if (!app) {
    throw new Error('The Web application plan must identify a JavaScript artifact inside build/live-preview.');
  }
  return app;
}

async function clearGeneratedEntry(build: string, file: string): Promise<void> {
  const app = await readAppPlan(build, file).catch(error => {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  });
  if (!app) {
    return;
  }
  const output = path.dirname(app.artifact);
  const real = await fs.realpath(output).catch(error => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
  if (real && path.relative(output, real) === '') {
    await fs.rm(path.join(output, app.target + '.html'), { force: true });
  }
}

async function needsFreshCache(build: string, appRoot: string, sdk: Sdk, tools: WebPreviewToolchain): Promise<boolean> {
  const file = path.join(build, 'CMakeCache.txt');
  let cache: string;
  try {
    cache = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  const value = (key: string) => new RegExp('^' + key + ':[^=]+=(.*)$', 'm').exec(cache)?.[1].trim();
  const changed = (key: string, expected: string) => {
    const cached = value(key);
    return !cached || path.relative(cached, expected) !== '';
  };
  return changed('CMAKE_HOME_DIRECTORY', appRoot) || changed('HUXERUI_HOME', sdk.root) ||
    changed('CMAKE_TOOLCHAIN_FILE', tools.toolchainFile) ||
    tools.generator !== value('CMAKE_GENERATOR');
}

export class PreviewBuild {
  private constructor(readonly buildDir: string, readonly siteDirectory: string, private readonly lock: string) {}

  static async open(project: Project): Promise<PreviewBuild> {
    const root = await fs.realpath(project.root.fsPath);
    const build = await checkedDirectory(await checkedDirectory(root, 'build'), 'live-preview');
    const sites = await checkedDirectory(build, '.preview-sites');
    const lock = await claimBuild(sites);
    try {
      return new PreviewBuild(build, await fs.mkdtemp(path.join(sites, 'session-')), lock);
    } catch (error) {
      await fs.unlink(lock);
      throw error;
    }
  }

  async compile(project: Project, sdk: Sdk, tools: WebPreviewToolchain, tasks: HuxerTasks, signal: AbortSignal): Promise<WebApp> {
    const cwd = await fs.realpath((project.preview ?? project.root).fsPath);
    const run = async (args: string[], step: string) => {
      signal.throwIfAborted();
      const code = await tasks.buildForPreview(project, {
        executable: tools.cmake, cwd, env: tools.env, args,
      }, signal);
      signal.throwIfAborted();
      if (code !== 0) {
        throw new Error('Web preview ' + step + ' failed (exit ' + code + '). See the Build Web Preview task terminal.');
      }
    };
    // CMake file(GENERATE) can leave an obsolete plan when an application is renamed.
    for (const file of await integrationPlans(this.buildDir)) {
      // SDK shells are copied by a custom target and can survive --clean-first.
      await clearGeneratedEntry(this.buildDir, file);
      await fs.unlink(file);
    }
    // Generate Embind's invokers at link time so the trusted Webview needs no JS eval.
    const args = ['-S', cwd, '-B', this.buildDir, '-DCMAKE_BUILD_TYPE=Debug',
      '-DCMAKE_EXE_LINKER_FLAGS_DEBUG:STRING=-sDYNAMIC_EXECUTION=0',
      '-DHUXERUI_HOME=' + sdk.root, '-DHUXERUI_ENABLE_LTO=OFF', '-DCMAKE_TOOLCHAIN_FILE=' + tools.toolchainFile];
    args.push('-G', tools.generator);
    if (await needsFreshCache(this.buildDir, cwd, sdk, tools)) {
      // CMake 3.20 is supported by the SDK and predates --fresh.
      await fs.unlink(path.join(this.buildDir, 'CMakeCache.txt'));
      const files = path.join(this.buildDir, 'CMakeFiles');
      await removeChildDirectory(this.buildDir, files).catch(error => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
    await run(args, 'configuration');
    const app = await findApp(this.buildDir);
    await run(['--build', this.buildDir, '--config', 'Debug', '--clean-first', '--target', app.target, '--parallel'], 'build');
    return app;
  }

  async stage(app: WebApp, revision: number): Promise<PreviewSite> {
    if (!within(this.buildDir, await fs.realpath(app.artifact))) {
      throw new Error('The Web artifact resolves outside build/live-preview.');
    }
    const output = path.dirname(app.artifact);
    const entries = await fs.readdir(output, { withFileTypes: true });
    const module = path.basename(app.artifact);
    const moduleStem = path.basename(module, '.js');
    const files = entries.filter(file => file.isFile() &&
      (file.name.startsWith(app.target + '.') || file.name.startsWith(moduleStem + '.')));
    if (!files.some(file => file.name === module)) {
      throw new Error('Missing Web preview output: ' + module);
    }
    const wasm = moduleStem + '.wasm';
    if (!files.some(file => file.name === wasm) && (await fs.readFile(app.artifact, 'utf8')).includes(wasm)) {
      throw new Error('Missing Web preview output: ' + wasm);
    }
    const directory = path.join(this.siteDirectory, 'site-' + revision);
    await fs.mkdir(directory);
    try {
      for (const file of files) {
        await fs.copyFile(path.join(output, file.name), path.join(directory, file.name));
      }
      const entry = app.target + '.html';
      const entryPath = path.join(directory, entry);
      if (files.some(file => file.name === entry)) {
        return { directory, html: await fs.readFile(entryPath, 'utf8') };
      }
      const html = defaultWebEntry(app);
      await fs.writeFile(entryPath, html);
      return { directory, html };
    } catch (error) {
      await removeChildDirectory(this.siteDirectory, directory);
      throw error;
    }
  }

  discard(site: PreviewSite): Promise<void> {
    return removeChildDirectory(this.siteDirectory, site.directory);
  }

  async close(): Promise<void> {
    try {
      await removeChildDirectory(path.dirname(this.lock), this.siteDirectory);
    } finally {
      await fs.unlink(this.lock);
    }
  }
}
