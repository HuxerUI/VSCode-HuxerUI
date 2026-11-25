# HuxerUI Web 预览实施计划

## 1. 交付目标

在 VSCode-HuxerUI 中新增命令 **HuxerUI: Open Live Preview**，命令 ID 为 `huxerui.preview`。从包含 Web 目标的 HuxerUI CMake 项目启动后，在当前编辑器右侧打开 Webview，运行该项目的已保存代码。

首次打开和每次相关保存都对 **完整的 Web 预览目标** 做一次干净的 Debug 构建。构建通过后整页刷新，重新初始化页面内存状态。结构、逻辑、样式和资源都沿用该项目的 Web 构建链，因此都通过同一次构建生效。

| 场景 | 预览入口和行为 |
| --- | --- |
| CMake 应用 | 构建项目现有的 Web 应用目标 |
| CMake 库 | 构建库的 `examples/preview` Web 应用。SDK 绑定和保存监听归属库根目录 |
| 当前文件未保存 | 预览磁盘上的已保存版本。保存后才更新 |
| Web 目标或工具链缺失 | 显示具体原因和相应的现有项目设置入口 |
| 多项目工作区 | 从活动文件找到其所属项目。候选不唯一时只列出可预览的 CMake 项目 |

预览的 CMake 构建目录固定为 **`<工程根目录>/build/live-preview`**。应用使用应用根目录，Library Preview 使用库根目录，并以库下的 `examples/preview` 为 CMake 源目录。应用正式构建和打包继续使用现有入口与产物目录，SDK 按项目已选版本使用。

## 2. 复用扩展已有能力

| 位置 | 实施职责 |
| --- | --- |
| `package.json` | 声明命令供命令面板调用 |
| `src/extension.ts` | 通过现有命令注册与 Workspace Trust 检查打开会话，在扩展停用时等待收尾 |
| `src/projects.ts` | 复用活动文件归属、CMake 项目、Web 平台和 Library Preview 的发现规则 |
| `src/sdk.ts`、`src/toolchain.ts` | 复用项目 SDK 绑定和 Web 工具链检查，取得构建宿主实际使用的 CMake 和 Emscripten |
| `src/tasks.ts`、`src/diagnostics.ts` | 接入 `Build Web Preview` 任务，复用进程取消、构建终端和 VS Code「问题」面板 |
| 新增预览模块 | 管理会话、构建队列、SDK 集成计划读取、产物发布和 Webview 生命周期 |

命令入口先检查工作区信任，再解析项目并检查 Web 目标和宿主工具链。库的 SDK 依旧从库根目录解析，实际 CMake 源目录使用 `examples/preview`。同一项目重复运行命令时，显示已有面板并请求一次重建。SDK 或构建环境切换后，重新打开预览建立新会话。

## 3. 隔离构建与产物定位

### 构建与发布目录

将 `build/live-preview` 直接传给 CMake 的 `-B` 和 `--build`。每个会话在同一目录下的 `.preview-sites` 中单独发布 Web 文件。发布文件由扩展管理，独立于 CMake 声明的生成目标。

```text
<工程根目录>/
  build/
    live-preview/                  # CMake -B 和 --build 都使用此目录
      CMakeCache.txt
      huxerui-integration/
      <target>.html
      <target>.js
      <target>.wasm
      .preview-sites/
        session-<id>/
          site-<revision>/
```

关闭预览时保留固定构建目录和 CMake 配置，清理本会话的发布文件。每次构建仍执行 `--clean-first`，让目标源码与依赖重新进入完整的构建图。已显示的页面从独立发布目录取文件，因此清理构建输出时仍可读取上一版 Wasm 和资源。同一工程跨窗口打开时，对固定构建目录持有互斥锁，避免两个构建同时清理或写入。

### 构建步骤

1. 使用所选 SDK 的 Web 诊断计划确认 CMake、Emscripten 和 SDK 路径。以 SDK 实际要求的 Emscripten 版本为准。扩展当前对应的 SDK 源码使用 4.0.19。优先采用工作区宿主已配置且与 Emscripten 兼容的生成器，有 Ninja 时可将其作为默认选项。 [SDK Web 工具链检查](https://github.com/HuxerUI/HuxerUI/blob/d9c430fc3b720e09510e041862f98275c2c20f78/tools/huxerui_cli/platform/web.cpp#L51-L96)
2. 在 `build/live-preview` 中使用该 Emscripten 工具链和 Debug 配置，按预览配置关闭 LTO。保留项目自己的 `hcg` 转换、资源打包、依赖和 Web 壳。配置与构建使用参数数组启动，覆盖 Windows 含空格路径以及远程扩展宿主的路径。
3. 配置完成后，从 `build/live-preview/huxerui-integration/<target>/Debug/app.json` 读取 SDK 生成的集成计划。验证 schema、目标名和 JavaScript 产物路径，并确认产物位于固定预览构建目录内。项目目标改名时，只读取本轮配置生成的计划。标准项目应有一个可运行 Web 应用，未找到或存在多个时提示用户明确可预览入口。 [SDK 集成计划生成](https://github.com/HuxerUI/HuxerUI/blob/d9c430fc3b720e09510e041862f98275c2c20f78/cmake/HuxerUIApp.cmake#L285-L307)
4. 使用 `cmake --build <工程根目录>/build/live-preview --config Debug --clean-first --target <web-app-target> --parallel` 执行干净构建。记录标准输出、标准错误和退出码。预览任务以项目为作用域，将编译器或 `hcg` 的文件、行号和列号交给现有诊断解析器。
5. 构建成功后，根据 Web 入口与 SDK 打包约定找到 HTML、JavaScript、Wasm 及所需同目录资源，保留相对路径，复制到本轮发布目录。确认入口和其依赖已经完整写入，再交给 Webview。 [SDK Web 运行与产物规则](https://github.com/HuxerUI/HuxerUI/blob/d9c430fc3b720e09510e041862f98275c2c20f78/tools/huxerui_cli/platform/web.cpp#L209-L251)

### 配置命令示意

```text
cmake -S <app-root> -B <project-root>/build/live-preview -DCMAKE_TOOLCHAIN_FILE=<emscripten-cmake> -DHUXERUI_HOME=<sdk-root> -DCMAKE_BUILD_TYPE=Debug -DHUXERUI_ENABLE_LTO=OFF
cmake --build <project-root>/build/live-preview --config Debug --clean-first --target <web-app-target> --parallel
```

配置命令还需要采用该宿主的实际生成器和 SDK Web 工具链参数。验收时在任务日志中核对生效的配置，确认每次执行的是干净构建。

## 4. 保存、错误与关闭

| 事件 | 行为 |
| --- | --- |
| 首次打开 | 右侧面板显示构建中。第一份成功产物就绪后挂载 Web 应用 |
| 空闲时保存 | 立即请求一次完整构建 |
| 构建期间连续保存 | 将最新一轮请求排队。当前构建退出后，用磁盘上的最新版本再次完整构建 |
| 其他项目或生成目录保存 | 保持当前会话空闲。项目归属沿用现有发现规则，排除预览缓存和发布输出 |
| 旧构建完成时已有更新请求 | 保留当前画面，继续处理最新请求，避免短暂显示旧版本 |
| 配置、编译或产物校验失败 | 标记失败并展示诊断，保留最后成功页面。首次失败则在面板显示失败原因 |
| 修正后保存 | 重新进入正常构建队列，成功后自动刷新 |
| 关闭面板、移除工作区项目或停用扩展 | 停止接收保存事件，取消待构建请求和运行中的进程。进程退出后清理该会话的发布目录并释放构建锁 |

每个会话保留一个运行中的构建、一个最新待处理请求和最后成功的发布版本。以保存请求序号判断结果是否仍可发布。初始化、编译、复制或取消阶段遇到失败时，临时产物只在当前会话内清理。再次打开可以直接重建。

## 5. Webview 加载约定

1. 用 `WebviewPanel` 在编辑器旁打开面板，沿用 SDK 生成的 HTML 和应用入口。在首次打开时保留源码编辑器焦点。
2. 用 `webview.asWebviewUri` 生成发布目录的资源地址。让 SDK 壳的相对模块导入、Wasm 请求和资源请求仍在该目录解析。`localResourceRoots` 只授权当前发布目录。
3. 配置 CSP，允许当前预览所需的脚本、样式和资源，并允许 `'wasm-unsafe-eval'`。单独验证 SDK 壳的内联模块脚本以及 Emscripten 的实际加载行为。用 VS Code 自身的 Webview 机制刷新，在本机和远程工作区共用同一条资源路径。 [VS Code Webview 资源与安全策略](https://code.visualstudio.com/api/extension-guides/webview)
4. 为每轮发布使用不同目录和资源 URI。所有文件就绪且会话仍有效后才更新页面，同时更新资源授权。随后回收已经退役的发布目录。浏览器侧的资源或启动错误可通过 Webview 开发工具定位，构建错误仍由任务终端和「问题」面板显示。

## 6. 按文件实施

以下代码块是实施时的改动位置和参考片段。`src/webPreview.ts` 中的协调流程用伪代码列全，采用前后各节定义的数据、输入和返回值。

### 第一步 · 先跑通一个真实 Web 构建

1. 用当前 SDK 准备一个启用了 Web 的标准 CMake 应用。选一个包含按钮、文本输入和本地图片的程序，以便一次检查 Wasm、逻辑和资源。
2. 在应用目录运行以下命令，得到普通 SDK 构建的基准。若诊断提示缺少工具，按诊断结果配置工具链并重新检查。

   ```powershell
   huxerui doctor web --operation build --json
   huxerui build web --config debug --lto off
   ```

3. 查看普通 Web 构建生成的 `app.json`，记录其中的 `target` 和 `artifact`。核对 `artifact` 对应的 JS 模块、同目录 HTML、Wasm 和资源。如果计划目录或产物名称与第 3 节不符，按所选 SDK 实际生成的文件调整读取器。
4. 在样例工程的 `build/live-preview` 运行第 3 节的 CMake 配置和 `--clean-first` 命令。首次构建和第二次源码保存后均检查编译、链接日志。核对预览与普通 SDK 构建各自的产物路径。
5. 用 Web 已启用的 Library Preview 重复配置。命令在库根目录选择 SDK，CMake 的 `-S` 指向 `examples/preview`。确认更改库本身的源码能影响生成的 Web 页面。

### 第二步 · 注册命令并选择预览项目

在 `package.json` 的 `contributes.commands` 中添加条目。

```json
{
  "command": "huxerui.preview",
  "title": "HuxerUI: Open Live Preview"
}
```

在 `src/extension.ts` 中导入预览模块。在 `activate` 已创建的 `sdkSelection` 和 `tasks` 后实例化 `WebPreviews`，把它加入 `context.subscriptions`，再通过现有的 `command` 函数注册。把管理器保存在模块级变量中，供 `deactivate` 等待清理。

```ts
import { WebPreviews } from './webPreview';

let webPreviews: WebPreviews | undefined;

// In activate, after sdkSelection and tasks have been created:
const previews = new WebPreviews(context, sdkSelection, tasks);
webPreviews = previews;
context.subscriptions.push(previews);
// Register this beside the other command(...) calls:
command('preview', () => previews.open());

// Replace the body of deactivate:
await Promise.all([webPreviews?.dispose(), disposeMobileDebug()]);
```

`WebPreviews.open()` 按下面的顺序执行。

1. 使用 `projectsForFile(activeDocument.uri)` 得到当前文件最近的项目。存在匹配时，在可预览候选里选取项目。编辑器没有项目上下文时，复用 `selectProject()` 的工作区选择流程。
2. 检查 `project.buildSystem === 'cmake'`、`project.platforms.includes('web')` 和 `canBuild('web')`。候选为空时给出对应的项目、Web 目标或执行宿主提示。
3. 用 `project.root.toString()` 作为会话键。同一项目面板存在时，显示该面板并调用 `requestBuild()`。同一项目已在初始化时，复用该次初始化，不再启动第二次 SDK 检查。
4. 调用 `sdkSelection.resolve(project.root)` 和下一步的 `prepareWebPreviewToolchain()`。选择取消后结束命令。等待完成后再核对项目仍在当前工作区、管理器仍有效。
5. 从 `project.root` 派生固定构建目录和发布根 URI，创建目录后获取该工程的构建锁，再在发布根下用 `fs.mkdtemp` 建立本次会话的发布目录。创建右侧面板并注册保存、关闭和工作区变化事件，最后请求第一次构建。初始化中任一步失败时，清理本次会话已创建的发布目录并释放已经取得的锁。

   ```ts
   const buildUri = vscode.Uri.joinPath(project.root, 'build', 'live-preview');
   const buildDir = buildUri.fsPath;
   const sitesUri = vscode.Uri.joinPath(buildUri, '.preview-sites');
   ```

   用独占创建的锁文件标识占用者。在固定构建目录已有活动会话时，提示先关闭另一窗口的预览。进程异常退出留下锁时，只有确认锁记录的宿主进程已退出，才回收旧锁。

面板创建时保留源码编辑器焦点。资源授权等第一份产物就绪后再设置。

```ts
const panel = vscode.window.createWebviewPanel(
  'huxerui.preview',
  projectName + ' Preview',
  { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
  { enableScripts: true, localResourceRoots: [] },
);
```

### 第三步 · 从 SDK 诊断结果拿到明确的工具路径

在 `src/toolchain.ts` 把原 `prepareToolchain()` 的诊断、安装和二次校验提取成私有 `prepareToolchainPlan()`。原方法成功后返回布尔值，新方法成功后返回已经验证的 `Plan`，用户取消时返回 `undefined`。现有工具链命令和安装确认流程继续经过同一段逻辑。

```ts
export interface WebPreviewToolchain {
  cmake: string;
  toolchainFile: string;
}

export async function prepareWebPreviewToolchain(
  tasks: HuxerTasks, project: Project, sdk: Sdk,
): Promise<WebPreviewToolchain | undefined> {
  const plan = await prepareToolchainPlan(tasks, project, sdk, {
    target: 'web',
    operation: 'build',
  });
  if (!plan) {
    return undefined;
  }

  const cmake = plan.checks.find(check =>
    check.id === 'cmake' && check.status === 'ready')?.detail;
  const emcc = plan.checks.find(check =>
    check.id === 'emcc' && check.status === 'ready')?.detail;
  if (!cmake || !emcc || !path.isAbsolute(cmake) || !path.isAbsolute(emcc)) {
    throw new Error('The SDK toolchain plan did not identify CMake and Emscripten.');
  }

  const compiler = await fs.realpath(emcc);
  const toolchainFile = process.env.CMAKE_TOOLCHAIN_FILE ||
    path.join(path.dirname(compiler), 'cmake', 'Modules', 'Platform', 'Emscripten.cmake');
  return { cmake, toolchainFile };
}
```

以上片段需新增 `node:fs/promises` 的导入。构建环境来自 `sdkEnvironment(sdk)`。检查安装版 SDK 和源码 SDK 都能解析到实际可执行文件。Windows 上用 CMake 的绝对路径和 Emscripten 的 toolchain 文件启动配置，参数保持为数组。指定 `CMAKE_GENERATOR` 时沿用其值，有已发现的 Ninja 且未指定生成器时追加 `-G Ninja`。

### 第四步 · 接入任务系统和干净构建

在 `HuxerTasks` 中添加专用方法，复用 `executeAndWait` 与 `terminal`。保留项目根作为诊断归属，`Invocation.cwd` 则使用应用或 Library Preview 的实际 CMake 目录。

```ts
async buildForPreview(
  project: Project, invocation: Invocation, signal: AbortSignal,
): Promise<number> {
  return this.executeAndWait(completed => {
    const task = new vscode.Task(
      { type: 'huxerui-preview-build', project: project.root.toString() },
      project.folder,
      'Build Web Preview',
      'HuxerUI',
      new vscode.CustomExecution(async () =>
        this.terminal(project.root, async () => invocation, 'build', completed)),
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Silent,
      focus: false,
      panel: vscode.TaskPanelKind.Dedicated,
    };
    return task;
  }, signal);
}
```

在新模块中实现 `configureAndBuild(session, signal): Promise<WebApp>`。其中 `WebApp` 至少包含 `target` 和 `artifact`，`session` 持有 `project`、`sdk`、`tools`、`buildDir` 以及 `tasks`。

1. 计算 `appRoot = (project.preview ?? project.root).fsPath`，把 `buildDir` 固定为 `project.root/build/live-preview` 的绝对路径。用 `sdkEnvironment(sdk)` 和工具绝对路径组成两条 `Invocation`。若复用的 CMake 缓存仍绑定到旧 SDK、工具链、生成器或源目录，按 CMake 的缓存重置流程重新配置该预览目录。
2. 配置前，枚举固定预览目录内上一轮的 `huxerui-integration/*/Debug/app.json`，仅移除已验证路径的旧计划文件。这样目标改名后不会命中上轮记录。
3. 配置参数使用以下数组，附上第三步确定的生成器参数。配置任务退出码为零后再读取本轮生成的计划。

   ```ts
   const configureArgs = [
     '-S', appRoot,
     '-B', buildDir,
     '-DCMAKE_BUILD_TYPE=Debug',
     '-DCMAKE_TOOLCHAIN_FILE=' + tools.toolchainFile,
     '-DHUXERUI_HOME=' + sdk.root,
     '-DHUXERUI_ENABLE_LTO=OFF',
     ...generatorArgs,
   ];
   ```

4. 枚举计划并解析 JSON。接受 `schema === 1`、`target` 与集成目录名一致、`artifact` 是位于构建目录内的绝对 JS 路径的记录。用 `path.relative` 判断目录归属，并拒绝 `..`、绝对的相对路径和越界的真实路径。跳过上轮已删除计划留下的空目录。本轮候选为零或多于一个时，输出对应的可操作错误。
5. 用计划里的目标名执行下面的参数数组。两条任务顺序执行，每条都把同一 `AbortSignal` 传入 `tasks.buildForPreview()`。取消时结束本轮，非零退出码包含失败阶段和任务终端入口。

   ```ts
   const rebuildArgs = [
     '--build', buildDir,
     '--config', 'Debug',
     '--clean-first',
     '--target', app.target,
     '--parallel',
   ];
   ```

6. 构建结束后检查 JS 和 HTML 入口，并在 SDK 使用分离 Wasm 时检查对应的 Wasm 文件。记录本轮目标名、退出码和耗时，再把 `WebApp` 交给发布阶段。

### 第五步 · 复制产物并安装到 Webview

在新模块中把文件准备和页面切换拆成两个动作。这样可以在复制结束后再检查请求序号，判断该结果是否仍然需要显示。

| 方法 | 输入 | 输出或副作用 |
| --- | --- | --- |
| `stageWebApp(app, session, revision)` | 仅接受本轮确认过的构建结果 | 返回 `{ directory, uri, html }`。将入口、模块、Wasm 和其他 SDK Web 资源放进独立发布目录，保持相对路径 |
| `renderPreviewHtml(webview, site)` | 生成的 HTML、发布目录 URI 和当前 Webview | 返回可显示的 HTML，增加 CSP 与资源根地址 |
| `commitSite(session, site)` | 仅接受仍然有效的最新请求 | 更新 `localResourceRoots` 和 `webview.html`，记为最后成功版本 |
| `discardSite(session, site)` | 归属于该会话的临时发布目录 | 对已验证的真实路径做清理 |

基线 SDK 通过 `<target>.html` 加载同目录 `<target>.js`。对 SDK 自动生成的同名产物使用 `target + '.'` 识别，保留 `.wasm`、`.data`、图标等已经生成的文件。添加 Web 自定义资源的支持时，将资源路径列入确定的产物集合并保留子目录布局。先等所有复制任务结束，再允许发布或清理目录。

从 `build/live-preview/.preview-sites` 的项目 URI 构造当前发布目录 URI，保留远程 URI 的 scheme 和 authority。将其转成 Webview 资源 URL 时保留尾部斜杠，作为 SDK HTML 的 `<base href="…">`。把 CSP 和 base 一起放进 `<head>` 的开头，保留其余 HTML 字节和相对导入。下面是标准 SDK 壳的实现骨架。

```ts
function renderPreviewHtml(webview: vscode.Webview, site: PreviewSite): string {
  const head = /<head\b[^>]*>/i;
  if (!head.test(site.html)) {
    throw new Error('The generated preview page has no head element.');
  }

  const directoryUri = site.uri.with({ path: site.uri.path + '/' });
  const base = webview.asWebviewUri(directoryUri).toString();
  const source = webview.cspSource;
  const csp = [
    "default-src 'none'",
    'base-uri ' + source,
    "script-src " + source + " 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src " + source + " 'unsafe-inline'",
    'connect-src ' + source + ' https: http: wss: ws:',
    'img-src ' + source + ' data: blob: https:',
    'font-src ' + source + ' data: https:',
    'media-src ' + source + ' blob: https:',
    'worker-src ' + source + ' blob:',
  ].join('; ');

  return site.html.replace(head, tag => tag +
    '<meta http-equiv="Content-Security-Policy" content="' + escapeAttribute(csp) + '">' +
    '<base href="' + escapeAttribute(base) + '">');
}
```

`escapeAttribute()` 至少转义 `&`、`"`、`<`、`>`。CSP 中的内联脚本权限用于可信项目生成的 SDK HTML 模块入口。外链脚本限制在 Webview 资源源。自定义 Web 壳使用了额外的浏览器能力时，在真实样例中逐项验证后再扩展相应的权限。

发布时先准备 HTML。确认当前请求仍有效后，在同一次同步更新中将资源授权切换到新目录并设置 `webview.html`。更新成功后记录新目录，再清理退役的旧目录。为每轮发布使用独立 URI，避免浏览器从缓存拿到前一版 JS 或 Wasm。

### 第六步 · 实现会话和保存调度

在新模块中按项目维护 `WebPreviews` 管理器，在每个 `WebPreviewSession` 中保存下面的状态。

| 字段 | 用途 |
| --- | --- |
| `project`、`sdk`、`tools`、`buildDir`、`siteDirectory`、`panel` | 固定本次会话的执行上下文 |
| `requestedRevision` | 打开、有效保存或重复运行命令时递增 |
| `attemptedRevision` | 已开始尝试的版本，包括失败的构建 |
| `activeBuild` | 当前构建循环的 Promise，只有一份 |
| `publishedSite` | 正在显示的最后一份成功产物 |
| `controller`、`subscriptions`、`cleanup` | 取消进程、移除监听并等待一次性清理 |

`onDidSaveTextDocument` 先检查 URI 的 scheme、authority 和项目路径范围，再过滤 `build/live-preview`、`.git` 和 `dist` 等生成或管理目录。对嵌套项目用 `projectsForFile()` 确认归属，Library Preview 的入口文件和库内的源文件都归库根。保存监听覆盖源码、头文件、CMake 配置和资源，使用同一套构建入口。

```text
requestBuild():
  如果会话已结束，返回
  requestedRevision 加一
  如果 activeBuild 已存在，返回
  保存 runBuildLoop() 的 Promise 到 activeBuild
  Promise 结束时清除 activeBuild
  此时若仍有未尝试的请求且会话未结束，再启动循环

runBuildLoop():
  只要会话未结束且 attemptedRevision < requestedRevision
    revision = requestedRevision
    attemptedRevision = revision
    在标题或首次占位页显示 Building
    candidate = 空

    尝试
      app = configureAndBuild(session, signal)
      若会话已结束或 revision 已过期，进入下一轮
      candidate = stageWebApp(app, session, revision)
      若会话仍有效且 revision 仍等于 requestedRevision
        commitSite(session, candidate)
        清除失败状态

    捕获错误
      若会话仍有效且 revision 仍等于 requestedRevision
        显示 Build Failed 和诊断入口
        已有发布页面时保留页面
        首次失败时在占位区域显示错误

    最终
      candidate 存在且未提交时，释放候选目录
```

只有收到新保存、命令重试或重新打开时才增加 `requestedRevision`。失败尝试也更新 `attemptedRevision`，防止同一个错误触发无限重建。日志可携带请求序号，用来区分构建失败、被新保存替代和用户关闭取消。

关闭时先把会话标为结束并注销监听，再触发 `controller.abort()`。管理器保存清理 Promise。旧会话等待运行中的任务及文件复制结束，再删除自己位于 `.preview-sites` 内且通过真实路径校验的发布目录，最后释放构建锁。重新打开同一项目时等待上一会话清理完成。扩展停用等待活动会话和已经关闭但仍在清理的会话。

## 7. 按步骤验证

1. 在扩展仓库运行 `npm ci`、`npm run compile` 和 `git diff --check`，通过后用 F5 打开 **Extension Development Host**。
2. 在开发宿主打开第一步的标准 Web App。从 C++ 源文件运行 **HuxerUI: Open Live Preview**，观察右侧面板和 **Build Web Preview** 任务。核对日志中的 `-B` 和 `--build` 都指向当前工程的 `build/live-preview`，实际编译命令含 `--clean-first`，浏览器能加载真实的 SDK Wasm。
3. 分别修改布局顺序、按钮逻辑、颜色或间距、本地图片。每次保存后检查任务退出状态和新画面。先把按钮计数改到非初始值，再保存，确认整页刷新后的计数回到新程序的初始值。
4. 留在已有可用画面上，加入一个 C++ 语法错误后保存。检查上一版画面及交互仍在、「问题」定位到源码。修正后保存，确认诊断清除且同一面板显示修正后的页面。
5. 在一次较长的构建进行时连续保存两次不同的可见改动。检查日志中任务顺序执行，最后只显示磁盘上最新的值。再在配置或编译中关闭面板，确认进程退出、会话发布目录被清理、固定构建目录保留，重新打开可成功构建。
6. 对 Library Preview 重复步骤 2 至 4，再用另一个独立项目验证保存归属。用含空格的 Windows 路径运行样例。使用远程工作区时，在该工作区宿主检查相同 SDK 和 Webview 资源路径。
7. 用原有的 **HuxerUI: Build** 与 **HuxerUI: Package** 构建同一份源码，比较相同配置下的发布文件清单和体积。分别记录首次打开和后续保存到首帧的耗时，日志中拆出配置、编译、产物复制和页面加载时间。

## 8. 验收清单

| 验收场景 | 通过标准 |
| --- | --- |
| 命令与条件检查 | 可信 Web 项目可启动。缺 Web 目标、缺 SDK 或缺 Emscripten 时提示具体原因。取消选择后无后台任务 |
| 应用和库各打开一次 | 真正的 HuxerUI Web 应用在右侧显示，已保存代码生效。库源码保存后触发同一 Library Preview |
| 改结构、逻辑、样式和资源 | 保存后执行干净构建，四项变化均在整页刷新后生效。先前的页面内存状态按整页重启规则重置 |
| 构建失败与恢复 | 引入 C++ 错误后上一版画面仍可交互，「问题」面板定位到手写源码。修正保存后页面自动更新 |
| 连续保存 | 同一项目没有重叠构建，最后发布的是最新保存版本 |
| 多项目与项目关闭 | 保存另一个项目不会触发当前面板。关闭面板时取消该会话的任务，再打开后可重建 |
| CMake 目标改名和路径含空格 | 新目标可被发现并运行。Windows 源目录、SDK 路径和输出路径含空格时能构建 |
| 产物与发包 | 预览编译产物位于工程的 `build/live-preview`。使用相同应用源码与发布配置对照，预览文件未进入应用包，包体积保持一致 |

TypeScript 编译和合成 Wasm 冒烟测试用来验证扩展链路。应用与 Library Preview 的最终验收使用真实 HuxerUI SDK 和其配套 Emscripten，记录宿主、SDK、工具链版本和构建日志。
