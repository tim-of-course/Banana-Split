# Contributing

Thanks for helping improve Banana Split.

## Before opening a change

- Search existing issues before filing a new one.
- Use an issue to discuss substantial behavior or contract changes first.
- Keep changes focused and consistent with the V1 contract in
  [docs/BANANA_SPLIT_V1_SPEC.md](docs/BANANA_SPLIT_V1_SPEC.md).
- Do not include credentials, private workflow data, or generated local state.

## Development

Banana Split currently targets Windows 11 x64. Install Node.js, npm, Bun 1.3 or
newer, and an authenticated current Codex CLI, then run:

```powershell
npm install
npm run verify
```

`npm run verify` checks the TypeScript bundle, runs the test suite, and builds
`dist/banana.exe`. If a pull request intentionally updates the packaged
runtime, copy the verified executable to
`distribution/plugins/banana-split-v1/runtime/banana.exe`.

## Pull requests

Explain the user-visible change, note any contract or configuration impact, and
include focused tests when they protect critical behavior or a non-obvious
invariant. By contributing, you agree that your contribution is licensed under
the repository's MIT License.
