# Performance implementation plan

## Scope

This plan covers audit point 6: removing approximately quadratic parser/printer behavior and excessive transient memory use.

Do not commit changes. After this section is complete and validated, create one patch changeset for `prettier-plugin-django-templates` describing the performance improvement and its regression coverage.

## Prerequisites and sequencing

Execute the tooling plan first so package and CI gates are available. Prefer executing the general correctness plan before this plan because both modify parser offsets and marker allocation. Re-read the current parser after those changes rather than applying this plan mechanically to the audited line numbers.

Execute the cleanup/locality plan after this one so scanner and metadata extraction reflect the optimized implementation rather than preserving obsolete structures.

## Baseline

Capture repeatable baselines before changing implementation:

- parse-only time for repeated expressions and standalone tags;
- full-format time for mixed HTML/template documents;
- peak or delta RSS where reliably measurable;
- output and idempotence for all existing fixtures.

Use geometrically increasing sizes such as 1k, 2k, 4k, 8k, and 16k constructs. Include at least:

1. repeated `{{ value }}` expressions;
2. repeated standalone tags;
3. deeply nested supported blocks;
4. many sibling custom paired blocks;
5. large ordinary HTML with few template constructs;
6. long attribute values containing template constructs.

Keep benchmark execution deterministic, warm up the runtime, run multiple samples, and report median values. Avoid brittle wall-clock assertions in the normal unit suite.

## Design target

Preserve the small public Prettier interface while deepening the parser internals:

- source text is scanned a bounded number of times;
- protected content is assembled without repeated whole-document copying;
- HTML context is represented compactly;
- tag pairing does not repeatedly scan the remaining token list;
- parent/block relationships do not require repeated global node-table scans;
- marker lookup is indexed rather than repeatedly testing every marker against every string fragment.

Aim for near-linear growth with document size and construct count. Document any unavoidable super-linear HTML/Prettier behavior outside this plugin's control.

## Implementation stages

### Stage 1: Add performance and scale coverage

1. Add a benchmark script or Vite+ task separate from the normal correctness suite.
2. Add bounded scale regression tests that exercise thousands of constructs without relying on strict millisecond thresholds.
3. Assert output correctness and second-pass idempotence for generated scale inputs.
4. Add a documented command for reproducing benchmark results.
5. Save the pre-change benchmark results in the implementation report or PR description, not as unstable generated repository artifacts unless the project deliberately wants tracked benchmark data.

### Stage 2: Replace per-character object allocation

1. Remove `getHtmlState()`'s object-per-UTF-16-code-unit representation.
2. Prefer one of:
   - context flags captured directly while tokenizing in a single scan; or
   - compact typed arrays only if random offset lookup remains necessary.
3. Preserve behavior for HTML start tags, quoted attribute values, comments, malformed markup, and template constructs.
4. Do not combine this with the cleanup plan's shared-scanner extraction unless the current implementation naturally makes that seam clear.

### Stage 3: Eliminate repeated whole-string replacement

1. Stop calling `replaceAt()` for every template construct.
2. Build protected content from source slices and marker IDs in one pass, or use a piece-table/segment representation that is flattened once per required container.
3. Keep immutable source spans separate from protected-buffer positions.
4. Assemble nested template blocks without repeatedly slicing and rewriting the complete root string.
5. Define deterministic handling for unmatched starts and malformed nesting; preserve existing behavior unless the general plan has intentionally changed it with tests.

### Stage 4: Precompute tag relationships

1. Remove `tokens.slice(startIndex + 1).some(...)` from `hasMatchingEnd()`.
2. Pair start/end tags in a stack-based pass or precompute suffix/end-name availability.
3. Preserve custom paired-tag behavior, branch-parent validation, special end-name conventions, and conservative handling in attributes.
4. Store explicit parent/block relationships needed by the printer rather than recovering them through `content.includes()` scans.

### Stage 5: Index markers and printer relationships

1. Avoid sorting and scanning every node ID for every string fragment.
2. Centralize marker recognition in a collision-safe marker module shared with the general plan.
3. Replace repeated `Object.values(node.nodes).find/filter(...)` relationship discovery with explicit references or indexed lookups.
4. Keep root ownership of the node table; do not copy a global mutable table onto every AST node.
5. Ensure Prettier traversal remains acyclic and `getVisitorKeys` exposes only intentional child relationships.

### Stage 6: Measure and simplify

1. Run the same benchmark matrix used for the baseline.
2. Compare time growth and memory behavior, not just one absolute measurement.
3. Remove obsolete helpers and intermediate fields made unnecessary by the new assembly approach.
4. Confirm output diffs are either absent or explicitly intended and fixture-backed.

## Tests to add

- Generated scale correctness and idempotence tests.
- Parser tests confirming original source spans remain correct at scale.
- Deep nesting tests that stay below JavaScript/Prettier recursion limitations.
- Large malformed-input tests with deterministic outcomes.
- Marker-heavy attribute and document-flow tests.
- Benchmark coverage for sparse and dense template constructs.
- A non-flaky complexity guard, such as comparing normalized work counters or generous growth ratios across sizes, rather than a strict machine-dependent duration.

If practical, instrument internal test-only counters for scanned characters, assembled segments, and marker lookups. Prefer asserting bounded operation growth over timing alone.

## Validation

Run:

```text
vp check
vp test
vp run build
```

Then run:

- the dedicated benchmark command;
- packed-package smoke tests from the tooling plan;
- earliest/current Prettier compatibility tests;
- Node 22 and 24 validation where available.

Record before/after results for the same inputs and runtime configuration.

## Acceptance criteria

- Existing fixtures remain correct and idempotent.
- New scale fixtures remain correct and idempotent.
- Parser growth is demonstrably near-linear for dense template constructs over the benchmark range, or any remaining super-linear behavior is measured and explained.
- Large inputs no longer allocate one JavaScript object per source code unit.
- Parser assembly no longer copies the whole document for each construct.
- Tag pairing and marker restoration no longer repeatedly scan all remaining tokens/nodes.
- Source-location correctness from the general plan is preserved.
- The packed package continues to load and format successfully.

## Changeset

After the performance section passes all validation, create one patch changeset explaining that parser/printer scaling and memory behavior were improved without changing intended formatting semantics.

## Completion report

Report changed files, benchmark methodology and before/after results, commands and exit codes, the generated changeset path, remaining performance risks, and any intentionally deferred cleanup. Do not create commits.
