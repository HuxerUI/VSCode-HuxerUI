# HuxerUI for Visual Studio Code

Development build of the HuxerUI extension for the 0.5 SDK.

## Try the extension

Open **HuxerUI** in the Activity Bar to create an app or library from a form. In a HuxerUI workspace, the sidebar also selects the project, SDK, target, device, and build options for the next run or package task.

1. Run `npm ci`, open this repository in VS Code, and press F5. This opens an Extension Development Host.
2. In that window, open a trusted HuxerUI project folder or run **HuxerUI: Create Project**.
3. Run **HuxerUI: Diagnose Environment**, then **HuxerUI: Build** or **HuxerUI: Run**. A single eligible installed SDK or discovered source CLI is selected automatically. Build issues with source locations appear in Problems.
4. If no SDK is ready, choose **Download Latest HuxerUI SDK** or **Build CLI and Use Source Checkout**. A project with an exact version pin offers to download that version.

**HuxerUI: Select SDK** can override the choice for a project. The extension looks for a nearby `HuxerUI` checkout and common CMake build directories. For a checkout elsewhere, use **Browse for Source Checkout** or set `huxerui.sourceCheckout` on the execution host. A preferred checkout can build its standalone CLI using the host's CMake and C++ compiler. Set `huxerui.sourceCli` for a CLI built at a custom path.

After updating a source checkout, use **HuxerUI: Rebuild Source CLI** from the Command Palette or **Rebuild CLI** beside the sidebar SDK selector. Run uses the last successful CLI build for that checkout.

The extension uses the toolchain on the workspace host. In a remote window, configure SDK and toolchain paths on that host. With several SDKs installed, use **Select SDK** to bind each project. CMake projects can pin an exact installed SDK with the folder setting `huxerui.sdkVersion`.

**Run with Watch**, **Stop**, **Package**, and **Open Artifacts** are also available for CMake projects. When an ordinary run launches a detached app, close that app through its own UI. mcpp is a preview and uses the host's `mcpp` command and the project's own manifest.

SDK downloads run the official HuxerUI installer on the workspace host. It verifies the release checksum and sets `HUXERUI_HOME` and `PATH` for new sessions. HuxerUI commands can use the installed SDK immediately. Restart VS Code from the updated environment to pick up the new default in tools such as CMake Tools.

## Live preview

To preview a HuxerUI CMake application or Library Preview, open a source file and run **HuxerUI: Open Live Preview**. The extension uses the project's selected SDK and Emscripten toolchain. It builds the saved application in `build/live-preview/` under the project root and opens it beside the editor. When the build does not generate an HTML entry, the extension creates one in the preview output. This also supports projects without `platform/web` whose application and dependencies compile with Emscripten.

For a library, the extension builds `examples/preview` into the library root's `build/live-preview/`. Saving project code or changing a Web resource requests a clean Debug build. After a successful build, the page restarts with its initial state. Saves received during a build queue the latest revision. Compilation errors appear in Problems and the **Build Web Preview** task terminal while the previous page stays available. Close the preview tab to stop rebuilding.

## Edit HuxerUI source

In a CMake or mcpp project, type `[[` or `[[huxerui::` in a C++ file and select `[[huxerui::composable]]` from the suggestions.

In a standard CMake project, press F12 on a resource name such as `app::images::logo`, `app::raw::sample_config_json`, or `app::strings::welcome` to open its source. String references open the key in `resources/strings/default.properties`. Resource navigation works before the generated resource header exists.

## Debug with VS Code

Open **Run and Debug**, choose **HuxerUI…** in the configuration picker, and select a target. You can also open the picker with **Debug: Select and Start Debugging**. VS Code lists supported targets for each open HuxerUI CMake app or Library Preview. After selecting a target, use **F5** to start and **Shift+F5** to stop. The sidebar **Debug** button and **HuxerUI: Debug** run the same build and launch flow.

The dynamic configurations work without `launch.json`. To share a configuration, select **HuxerUI: Launch** from the **Add Configuration** snippets and set `target` to the desired platform. Desktop configurations can also set `args`. The extension reads the project's SDK and the sidebar's mobile device and ABI preferences each time it starts a session.

### Desktop apps

Use [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) on macOS. On Windows and Linux, enable Microsoft C/C++ from the extension pack on the workspace host. Windows builds use the MSVC build tools. Linux debugging requires an executable `gdb` on the workspace host's `PATH`.

Set a source breakpoint and start the host's desktop target. HuxerUI builds in Debug mode with the selected SDK and launches the app executable from the CMake integration plan.

For composable functions, set a line breakpoint inside the handwritten body. The current generator can assign the same line to the first statement and its generated `Scope` wrapper. In that case, Step Over can return to the handwritten caller. A breakpoint on the next executable statement lets you step inside the body.

### Android and iOS apps

Install CodeLLDB on the workspace host. Select Android or iOS Simulator in **Run and Debug**, or choose a target in the HuxerUI sidebar. If a saved device is unavailable, select a device from the picker. Mobile sessions use the selected SDK in Debug mode with LTO disabled.

- Android uses ADB and the project's Android NDK. The selected device must support `run-as`. Debug builds for one compatible ABI and attaches after launching the APK, so set a breakpoint in C++ code that you can trigger after launch.
- iOS debugging on macOS uses a booted Xcode simulator. Set breakpoints before launching so CodeLLDB can attach before the app starts running. If a source SDK build reports duplicate archive members in `dsymutil` and breakpoints stay unverified, select an installed SDK and retry.

On Android, **Restart** in the debugger toolbar relaunches the deployed Debug APK and reconnects. Stop and start a new debug session to build and deploy source changes.

Use the debugger toolbar or **HuxerUI: Stop** to end the session.

## Install a local build

Run `npm ci` and `npm run package:vsix`. In a normal VS Code window, run **Extensions: Install from VSIX...** and select the generated `huxerui-*.vsix` file.

The HuxerUI extension pack installs Microsoft C/C++ and CMake Tools with HuxerUI. You can manage each companion extension independently.
