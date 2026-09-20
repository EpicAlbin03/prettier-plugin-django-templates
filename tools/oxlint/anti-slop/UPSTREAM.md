# Anti-slop provenance

Source repository: <https://github.com/EpicAlbin03/prettier-plugin-django-templates>

Source snapshot: `.agents/skills/install-anti-slop/assets/anti-slop/` at commit `b2eee55d5a4f27b85be6366ae1f79f133652514f`.

Installed paths:

- `tools/oxlint/anti-slop/index.ts`
- `tools/oxlint/anti-slop/rules/`
- `tools/oxlint/anti-slop/shared/`
- `tools/oxlint/anti-slop/vendor/`
- `tools/oxlint/anti-slop/effect/` (bundled but not registered)

Intentional deviations:

- The copied plugin source is unmodified.
- Only the generic `anti-slop` plugin is registered. The optional Effect plugin and rules are not enabled because this project does not use Effect.
- This provenance file was added beside the installed entry point. The nested `vendor/eslint-stylistic/UPSTREAM.md` records the separate source revision and adaptations for the vendored readability rule.
