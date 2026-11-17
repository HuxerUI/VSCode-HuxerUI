# HuxerUI for Visual Studio Code

Development build of the HuxerUI extension for the 0.5 SDK.

## Try the extension

1. Run `npm ci`, open this repository in VS Code, and press F5. This opens an Extension Development Host.
2. In that window, open a trusted HuxerUI project folder or run **HuxerUI: Create Project**.
3. Run **HuxerUI: Select SDK** to choose a local 0.5 SDK. For a source build, select the HuxerUI checkout and the CLI built from it.
4. Run **HuxerUI: Diagnose Environment**, then **HuxerUI: Build** or **HuxerUI: Run**. Build issues with source locations appear in Problems.

To build a development CLI with HuxerUI checked out beside this repository, run these commands from the extension repository.

```sh
cmake -S ../HuxerUI/tools/huxerui_cli -B out/huxerui-cli
cmake --build out/huxerui-cli --config Release
```

In **Select SDK**, choose **Browse for Source Checkout**, select the HuxerUI checkout, and select the resulting `huxerui` executable under `out/huxerui-cli`.

The extension uses the toolchain on the workspace host. In a remote window, configure SDK and toolchain paths on that host. With several SDKs installed, use **Select SDK** to bind each project. CMake projects can pin an exact installed SDK with the folder setting `huxerui.sdkVersion`.

**Run with Watch**, **Stop**, **Package**, and **Open Artifacts** are also available for CMake projects. When an ordinary run launches a detached app, close that app through its own UI. mcpp is a preview and uses the host's `mcpp` command and the project's own manifest.

Built-in SDK discovery and folder selection are available in this development build. Managed download and offline archive import depend on the SDK installer mode described in the [design](docs/design.md).
