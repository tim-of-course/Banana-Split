# Preparing a release

Release packages contain a complete local Codex marketplace, the native runtime, host skill, configuration, operations guide, schema and license. A standalone executable or GitHub's automatic source archive is not the installable product.

## Build the archives

From the repository root, with Node/npm, Bun 1.3 or newer and `tar` on `PATH`:

```sh
npm ci
npm run check
npm test
npm run package:release
```

`package:release` cross-builds all four supported targets and replaces generated contents under `dist/releases/`. For version `0.1.1`, it produces:

```text
dist/releases/
  banana-split-0.1.1-windows-x64.tar.gz
  banana-split-0.1.1-darwin-arm64.tar.gz
  banana-split-0.1.1-darwin-x64.tar.gz
  banana-split-0.1.1-linux-x64.tar.gz
  SHA256SUMS
```

Each archive extracts into `bun-<platform>-<architecture>/`, including `.agents/plugins/marketplace.json`; the Linux package extracts into `bun-linux-x64/`. Archiving preserves hidden files and Unix executable permissions. The Windows system `tar` command and macOS/Linux `tar` can extract these packages. Checksums refer to the compressed assets; when all four assets are present, macOS users can run `shasum -a 256 -c SHA256SUMS` and Linux users can run `sha256sum -c SHA256SUMS`. Windows users can compare `Get-FileHash <archive> -Algorithm SHA256` with its entry.

For hosted builds, run **Build release packages** from the repository's Actions tab on the intended commit or tag. The workflow installs Bun 1.3.14 and Node 24, checks the source on Ubuntu 24.04 with a 30-second per-test timeout, cross-builds the packages, smoke-tests the extracted Linux binary and MCP entry point, and uploads the `banana-split-release-packages` artifact. Download and unpack that artifact to obtain the four archives and checksum file. The workflow has read-only repository permissions and does not create tags or publish releases.

## Verify and publish

Before publishing, align the release version in `package.json`, `package-lock.json`, the plugin manifest, runtime/MCP version strings, and user-facing release notes. Plugin build metadata such as `+codex.<timestamp>` may differ, but the manifest's release version must match `package.json`; packaging checks this. Keep example and shipped configuration aligned.

On each supported platform you can test, extract its archive into a fresh directory, follow the README installation and first-task instructions, and record the actual results. Inspect the installed operations guide and verify that the workflow recap includes the expected agents and routing. Stop an idle runtime, restart it, and verify retained workflow inspection. Record any platforms or Desktop capabilities you could not exercise.

Linux acceptance targets x64 with glibc on Ubuntu 24.04. Verify a coordinator with two reviewers, direct-parent acceptance, completion, retained inspection after restart, and a bounded write in a scratch workspace under the Linux sandbox. Record the OS, architecture, Bun version, and Codex version. Linux ARM64, Alpine/musl, and WSL remain unverified. Host Computer Use requires a host that provides it and is a separate acceptance claim.

Cross-compilation and source tests do not prove live App Server compatibility or platform acceptance. The hosted build runs on Linux; it does not authenticate Codex or run live model workflows. Packages are currently unsigned and macOS packages are not notarized. State those limits in the release notes.

When ready to publish, create a GitHub release for the verified commit and attach **all four `.tar.gz` files and `SHA256SUMS`**. Mark `0.x` releases as prereleases under the project's alpha/beta policy. Describe supported platforms, tested Codex/Bun versions, known limitations and breaking changes. Keep historical verification reports as evidence rather than rewriting them to imply current acceptance.
