# Contributing

Thanks for helping improve Banana Split.

## Before opening a change

- Search existing issues before filing a new one.
- Use an issue to discuss substantial behavior or contract changes first.
- Keep changes focused and consistent with the V1 contract in
  [docs/BANANA_SPLIT_V1_SPEC.md](docs/BANANA_SPLIT_V1_SPEC.md).
- Do not include credentials, private workflow data, or generated local state.

## Development

Banana Split targets Windows 11 x64 and macOS on Apple Silicon and Intel.
Install Git, Node.js with npm, Bun 1.3 or newer, and a current authenticated
Codex CLI. See the [quickstart](README.md#quickstart) for installation links.
From the repository root, run:

```powershell
npm ci
npm run verify
```

`npm run verify` checks the TypeScript bundle, runs the test suite, and builds
a complete plugin marketplace under `dist/bun-<platform>-<architecture>/`.
The executable is `plugins/banana-split-v1/runtime/banana.exe` inside the Windows
package and `plugins/banana-split-v1/runtime/banana` inside either macOS package.
Install from that generated marketplace using the quickstart commands.

Use `npm run build:windows` to cross-build Windows x64, or `npm run build:macos`
for both Mac architectures. Cross-compilation is not live platform acceptance.
Linux can cross-build packages, but the runtime and native `npm run verify`
build target do not support Linux or WSL.

The historical Windows executable in `distribution/` is tracked with Git LFS.
You do not need to fetch it for a source build; the build compiles a replacement.
Do not update that binary as part of a routine documentation or source change.
If a change intentionally updates it, use the verified Windows build and Git LFS.

Keep `config/banana.example.json` aligned with the shipped defaults in
`distribution/plugins/banana-split-v1/config/banana.json`. The example is a
reference, not the runtime's startup file. Changes to startup settings require
a runtime restart; see [operations](docs/OPERATIONS.md).

The source tests exercise mocked App Server interactions as well as local
process and storage behavior. Distinguish those results from an authenticated
installed workflow; see [verification evidence](docs/VERIFICATION.md). For
downloadable archives and release preparation, see [releasing](docs/RELEASING.md).

## Pull requests

Explain the user-visible change, note any contract or configuration impact, and
include focused tests when they protect critical behavior or a non-obvious
invariant. By contributing, you agree that your contribution is licensed under
the repository's MIT License.
