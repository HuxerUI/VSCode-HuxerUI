# HuxerUI for Visual Studio Code

Development build of the HuxerUI extension for the 0.5 SDK.

## Try the extension

Open **HuxerUI** in the Activity Bar to create an app or library from a form. In a HuxerUI workspace, the sidebar also selects the project, SDK, target, device, and build options for the next run or package task.

1. Run `npm ci`, open this repository in VS Code, and press F5. This opens an Extension Development Host.
2. In that window, open a trusted HuxerUI project folder or run **HuxerUI: Create Project**.
3. Run **HuxerUI: Diagnose Environment**, then **HuxerUI: Build** or **HuxerUI: Run**. A single eligible installed SDK or discovered source CLI is selected automatically. Build issues with source locations appear in Problems.
4. If no SDK is ready, choose **Download Latest HuxerUI SDK** or **Build CLI and Use Source Checkout**. A project with an exact version pin offers to download that version.

**HuxerUI: Select SDK** can override the choice for a project. The extension looks for a nearby `HuxerUI` checkout and common CMake build directories. For a checkout elsewhere, use **Browse for Source Checkout** or set `huxerui.sourceCheckout` on the execution host. A preferred checkout can build its standalone CLI using the host's CMake and C++ compiler. Set `huxerui.sourceCli` for a CLI built at a custom path.

The extension uses the toolchain on the workspace host. In a remote window, configure SDK and toolchain paths on that host. With several SDKs installed, use **Select SDK** to bind each project. CMake projects can pin an exact installed SDK with the folder setting `huxerui.sdkVersion`.

**Run with Watch**, **Stop**, **Package**, and **Open Artifacts** are also available for CMake projects. When an ordinary run launches a detached app, close that app through its own UI. mcpp is a preview and uses the host's `mcpp` command and the project's own manifest.

SDK downloads run the official HuxerUI installer on the workspace host. It verifies the release checksum and sets `HUXERUI_HOME` and `PATH` for new sessions. HuxerUI commands can use the installed SDK immediately. Restart VS Code from the updated environment to pick up the new default in tools such as CMake Tools.

## Debug desktop apps

Use [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) on macOS. On Windows and Linux, enable Microsoft C/C++ from the extension pack on the workspace host. Windows builds use the MSVC build tools. Linux debugging requires an executable `gdb` on the workspace host's `PATH`.

Open a CMake application or Library Preview with the host platform enabled, set a source breakpoint, and run **HuxerUI: Debug**. The command builds with the selected SDK in Debug mode and launches the app executable from the CMake integration plan.

For composable functions, set a line breakpoint inside the handwritten body. The current generator can assign the same line to the first statement and its generated `Scope` wrapper. In that case, Step Over can return to the handwritten caller. A breakpoint on the next executable statement lets you step inside the body.

## Install a local build

Run `npm ci` and `npm run package:vsix`. In a normal VS Code window, run **Extensions: Install from VSIX...** and select the generated `huxerui-*.vsix` file.

The HuxerUI extension pack installs Microsoft C/C++ and CMake Tools with HuxerUI. You can manage each companion extension independently.
