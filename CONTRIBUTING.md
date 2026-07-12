# Contributing

## Prerequisites

- Node.js 22 or 24
- [Vite+](https://viteplus.dev/) (`vp`)

Install dependencies:

```bash
vp install
```

## Development and validation

Run the standard checks while developing:

```bash
vp check
vp test
vp run build
```

Before submitting a releasable change, run the same complete gate used by CI and the release workflow:

```bash
vp run validate:release
```

The release gate checks formatting, linting, and types. Runs the test suite, builds the package, inspects a dry-run package, and installs the packed tarball into a temporary consumer for runtime and declaration smoke tests. To run only the smoke test, optionally against a specific supported Prettier version, use:

```bash
vp run test:package
vp run test:package -- 3.0.0
```

## Tests and fixtures

Focused behavior tests live in `test/*.ts`. End-to-end fixtures live in `test/cases/data/<case-name>/` and contain:

- `input.html`: the source Django HTML template
- `expected.html`: the exact formatted result or expected `Error(...)`
- `config.json` (optional): for Prettier options specific to that fixture

Add the smallest fixture or focused regression test that demonstrates a behavior. The fixture runner formats every successful result a second time, so expected output must be idempotent. Preserve template meaning and include whitespace-sensitive assertions when layout could affect rendered output.

## Changesets

Add a Changesets file for every user-visible change:

```bash
pnpm changeset
pnpm changeset status
```

This package normally uses a patch changeset for fixes, tooling, and documentation. Keep separate planned sections in separate changesets. See [`.changeset/README.md`](.changeset/README.md) for more info on what changesets are.
