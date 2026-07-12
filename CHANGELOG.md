# prettier-plugin-django-templates changelog

## 0.2.0

### Minor Changes

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`9a15320`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/9a15320569385f3847e9135657405b6786e036ba) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - Improve Django template formatting correctness, parser and printer performance, source locations, custom tag and ignore-region handling, marker safety, package compatibility, and release tooling.

### Patch Changes

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`3f7ffef`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/3f7ffef14a2cedc9ac2bfefc1d472517178f4661) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - prevented line breaks between adjacent Django template blocks in HTML attributes

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`c59f5fd`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/c59f5fd54f8de313d8cd7435781953e16aad5c66) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - remove obsolete marker processing paths

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`9afe3cb`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/9afe3cb228488c9dc18eab824d1e4d35104f1aa2) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - fixed multiline django tags in html attributes from collapsing

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`e063265`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/e063265cfa1d37ef167a719a0eef198a8d95ec15) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - Prevent internal parser and printer markers from colliding with template content, with exact and idempotent regression coverage.

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`37949ee`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/37949ee97cb66fe3dc1c6ff3c51de13bc3bc132f) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - Improve reproducible tooling, dependency hygiene, and contributor and support documentation.

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`70960b6`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/70960b60c539e713d4f37a5e13d25ecb0ce1a435) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - format conditional start-tag attributes on separate lines

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`8c1137b`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/8c1137b34beae3cad746dd6a30351e2a154d06c1) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - Fix the CommonJS Node entry point and add packed-package smoke coverage for runtime, browser, declaration, and package-content contracts.

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`e063265`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/e063265cfa1d37ef167a719a0eef198a8d95ec15) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - Report immutable original-source spans for Django AST locations, with cursor, range, Unicode, nested-block, and malformed-input coverage.

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`e063265`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/e063265cfa1d37ef167a719a0eef198a8d95ec15) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - Allow unknown custom `end*` tags to remain standalone while preserving contextual custom block matching and strict known closing-tag errors.

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`e063265`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/e063265cfa1d37ef167a719a0eef198a8d95ec15) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - replace application-specific output rewrites with generic document-flow docs

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`6af35e9`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/6af35e90b073d40185d24e2e3f59640af2b82f1f) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - preserve blank lines before html

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`e063265`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/e063265cfa1d37ef167a719a0eef198a8d95ec15) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - Match named verbatim terminators using Django's exact-content lexer semantics, preserving nonmatching raw content and idempotence.

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`e063265`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/e063265cfa1d37ef167a719a0eef198a8d95ec15) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - Pair ignore-region delimiter styles so crossed or missing terminators preserve content through the correct boundary.

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`184ac68`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/184ac6845659011755ecdc0e8cbb00f2169c0bb9) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - Improve parser and printer scaling by assembling protected template segments once, indexing tag and marker relationships, and adding generated scale and benchmark coverage.

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`37949ee`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/37949ee97cb66fe3dc1c6ff3c51de13bc3bc132f) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - Strengthen CI and release validation with a reproducible packed-package release gate.

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`9afe3cb`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/9afe3cb228488c9dc18eab824d1e4d35104f1aa2) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - fixed expression line break issue

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`c59f5fd`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/c59f5fd54f8de313d8cd7435781953e16aad5c66) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - consolidate template tag metadata

- [#15](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/15) [`c59f5fd`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/c59f5fd54f8de313d8cd7435781953e16aad5c66) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - unify html host context scanning

## 0.1.4

### Patch Changes

- [#13](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/13) [`10b0668`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/10b0668bd99ba4521d015ab48e368f4a975ff2b0) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - updated to typescript 7 + migrated CI to vite+

- [#13](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/13) [`9b6ca06`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/9b6ca06384807bff506787a9797c824173be7f9f) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - fix: incorrect line breaks

## 0.1.3

### Patch Changes

- [#11](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/11) [`3e65c10`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/3e65c1096e927dfeca96c43d56af39554aee20cc) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - fix: remove blank lines before end tags

## 0.1.2

### Patch Changes

- [#9](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/9) [`9387d52`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/9387d52a899b56ff2babe6a6a12fbcc0dfbcb1af) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - added more 3rd party django tags

- [#9](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/9) [`27442ab`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/27442abb77b86bce2b57a788a33d227019d6ac9a) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - migrated to vite plus (tsdown, oxlint, oxfmt, vitest)

## 0.1.1

### Patch Changes

- [#7](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/7) [`8eb9f36`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/8eb9f3660232f169685061dea0c363a002042af8) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - migrated from rollup to rolldown, build goes vrooom

## 0.1.0

### Minor Changes

- [#5](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/5) [`74a00bf`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/74a00bf99b3c580733e4315d6a2ce8f6b7d2ed55) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - \- Fixed invalid build files - rollup now uses module: 'esnext'.

  \- Improved Django template tag parsing and formatting, with clearer `template tag` terminology and expanded support for tags such as `ifequal`, `ifnotequal`, `thumbnail`, and `trans`.

  \- Fixed formatting around standalone and block-style template tags, including better handling of `extends` + `block` layouts and preservation of raw/verbatim/comment block bodies.

  \- Added stricter parser errors for malformed templates, including unterminated expressions/comments/tags and misnested closing tags.

  \- Expanded regression coverage with many renamed and new `template\_tag\_\*` fixtures, plus new cases for malformed input and edge-case formatting behavior.

  \- Hardened packaging and release verification by switching the browser build to `browser.mjs`, tightening package exports, and adding CI/package smoke-test checks.

  \- Refreshed README/package metadata to consistently describe the plugin as formatting Django HTML templates.

## 0.0.2

### Patch Changes

- [#3](https://github.com/EpicAlbin03/prettier-plugin-django-templates/pull/3) [`75ccafe`](https://github.com/EpicAlbin03/prettier-plugin-django-templates/commit/75ccafe3c0efd2f0d9f6581a178d341a934f5840) Thanks [@EpicAlbin03](https://github.com/EpicAlbin03)! - fix: blank space after comment, fix: readme formatting

## 0.0.1

- initial Django-focused package metadata, docs, tests, and parser source
