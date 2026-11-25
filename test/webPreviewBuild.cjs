const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PreviewBuild } = require('../out/webPreviewBuild');

test('library preview rebuilds the named target and keeps the published copy across clean builds', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'huxerui preview ')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'examples', 'preview');
  await fs.mkdir(source, { recursive: true });
  const project = { root: { fsPath: root }, preview: { fsPath: source } };
  const build = await PreviewBuild.open(project);
  const directory = path.join(root, 'build', 'live-preview');
  assert.equal(build.buildDir, directory);
  await assert.rejects(PreviewBuild.open(project), /Another Web Preview/);

  let target = 'before';
  let includeHtml = true;
  const tasks = {
    async buildForPreview(owner, { cwd, args }) {
      assert.equal(owner, project);
      assert.equal(cwd, source);
      if (args.includes('-S')) {
        assert.equal(args[args.indexOf('-B') + 1], directory);
        assert.ok(args.includes('-DCMAKE_EXE_LINKER_FLAGS_DEBUG:STRING=-sDYNAMIC_EXECUTION=0'));
        const plan = path.join(directory, 'huxerui-integration', target, 'Debug');
        await fs.mkdir(plan, { recursive: true });
        await fs.writeFile(path.join(plan, 'app.json'), JSON.stringify({
          schema: 1, target, artifact: path.join(directory, target + '.js'),
        }));
      } else {
        assert.deepEqual(args, ['--build', directory, '--config', 'Debug', '--clean-first', '--target', target, '--parallel']);
        if (includeHtml) {
          await fs.writeFile(path.join(directory, target + '.html'), '<head></head>');
        }
        for (const [ext, content] of Object.entries({ js: target + '.wasm', wasm: target, data: 'assets' })) {
          await fs.writeFile(path.join(directory, target + '.' + ext), content);
        }
      }
      return 0;
    },
  };
  const tools = { generator: 'Ninja', cmake: 'cmake', toolchainFile: 'Emscripten.cmake', env: {} };
  const compile = () => build.compile(project, { root }, tools, tasks, new AbortController().signal);
  const first = await build.stage(await compile(), 1);
  includeHtml = false;
  const fallback = await build.stage(await compile(), 2);
  assert.match(fallback.html, /import\("\.\/before\.js"\)/);
  assert.equal(first.html, '<head></head>');
  await fs.unlink(path.join(directory, 'before.wasm'));
  target = 'after';
  const second = await compile();
  await fs.unlink(path.join(directory, 'after.wasm'));
  await assert.rejects(build.stage(second, 3), /Missing Web preview output/);
  assert.equal(await fs.readFile(path.join(first.directory, 'before.wasm'), 'utf8'), 'before');
  assert.equal(await fs.readFile(path.join(first.directory, 'before.data'), 'utf8'), 'assets');
  await build.close();
  assert.deepEqual(await fs.readdir(path.join(directory, '.preview-sites')), []);
  const reopened = await PreviewBuild.open(project);
  await reopened.close();
  assert.ok((await fs.stat(path.join(directory, 'after.js'))).isFile());
});

test('preview stages a default HTML entry when the project emits no HTML', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'huxerui no shell ')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const build = await PreviewBuild.open({ root: { fsPath: root } });
  const app = {
    target: 'demo',
    artifact: path.join(build.buildDir, 'demo.js'),
    bundleIdentifier: 'dev.test.preview',
  };
  try {
    await fs.writeFile(app.artifact, 'demo.wasm');
    await fs.writeFile(path.join(build.buildDir, 'demo.wasm'), 'wasm');
    await fs.writeFile(path.join(build.buildDir, 'demo.data'), 'assets');

    const site = await build.stage(app, 1);
    assert.match(site.html, /import\("\.\/demo\.js"\)/);
    assert.match(site.html, /huxeruiStorageKey: "dev.test.preview"/);
    assert.match(site.html, /mountHuxerUI\("#huxerui-root"\)/);
    assert.equal(await fs.readFile(path.join(site.directory, 'demo.html'), 'utf8'), site.html);
    assert.equal(await fs.readFile(path.join(site.directory, 'demo.data'), 'utf8'), 'assets');
    await assert.rejects(fs.stat(path.join(build.buildDir, 'demo.html')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(root, 'platform')), { code: 'ENOENT' });
  } finally {
    await build.close();
  }
});
