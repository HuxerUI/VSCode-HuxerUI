# HuxerUI for Visual Studio Code

Development build of the HuxerUI extension for the 0.5 SDK.

## Try the extension

1. Run `npm ci`, open this repository in VS Code, and press F5. This opens an Extension Development Host.
2. In that window, open a trusted HuxerUI project folder or run **HuxerUI: Create Project**.
3. Run **HuxerUI: Diagnose Environment**, then **HuxerUI: Build** or **HuxerUI: Run**. A single eligible installed SDK or discovered source CLI is selected automatically. Build issues with source locations appear in Problems.
4. If no SDK is ready, choose **Download Latest HuxerUI SDK** or **Build CLI and Use Source Checkout**. A project with an exact version pin offers to download that version.

**HuxerUI: Select SDK** can override the choice for a project. The extension looks for a nearby `HuxerUI` checkout and common CMake build directories. For a checkout elsewhere, use **Browse for Source Checkout** or set `huxerui.sourceCheckout` on the execution host. A preferred checkout can build its standalone CLI using the host's CMake and C++ compiler. Set `huxerui.sourceCli` for a CLI built at a custom path.

The extension uses the toolchain on the workspace host. In a remote window, configure SDK and toolchain paths on that host. With several SDKs installed, use **Select SDK** to bind each project. CMake projects can pin an exact installed SDK with the folder setting `huxerui.sdkVersion`.

**Run with Watch**, **Stop**, **Package**, and **Open Artifacts** are also available for CMake projects. When an ordinary run launches a detached app, close that app through its own UI. mcpp is a preview and uses the host's `mcpp` command and the project's own manifest.

Managed downloads verify the release SHA-256 and use the host's `tar` to unpack the SDK into the extension cache. Offline archive import is described in the [design](docs/design.md).
