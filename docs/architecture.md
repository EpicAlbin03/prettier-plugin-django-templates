# Formatting pipeline

The formatter has three stages:

```text
source → parse / freeze AST → analyze document → construct Prettier Docs → Prettier layout
```

## Source contract

`parser.ts` builds nodes using private draft types from `ast-builders.ts`. Before returning, it freezes the nodes, child lists, parent context records, and shared dictionary. Neither analysis nor printing may modify that graph.

- `sourceStart` and `sourceEnd` are UTF-16 offsets into the parser input.
- `sourceText` is exactly that source slice, including original delimiter spacing.
- Leaf `content` is the token body; template-tag bodies have normalized separators outside quoted arguments.
- Container `html` is a projection containing child markers, **not** source text. Projection offsets must never be used as source offsets.
- `hostContext` is one of `document-flow`, `start-tag`, or `attribute-value`. Preformatted/opaque content is a separate concern, not another overlapping host flag.

`template-text.ts` constructs normalized Django spellings and whitespace-preserving inline text. It does not render Docs.

## Shared HTML interpretation

`html-host-context.ts` owns quote-aware HTML scanning, tag/comment events, enclosing elements, fragment balance, raw-text handling, and attribute splitting. Parser context, branch analysis, and HTML adaptation consume these same facts rather than maintaining separate tag regexes or void-element tables.

This is deliberately a conservative scanner, not a replacement for Prettier's HTML parser. Branches are balanced separately: an opening in one branch cannot satisfy a closing in another branch.

## Document plan

The printer's `preprocess` hook calls `analyzeDocument` **before** Prettier collects child embeds. `formatting-plan.ts` owns:

- one allocator/reservation pass per document;
- cached subtree expansion, segment balances, and branch ambiguity;
- explicit preserved spans with a source range, text, and reason;
- synthetic protected ranges in a separate projection dictionary;
- container body modes, prepared HTML segments, marker spacing instructions, segment separators, and EOF policy.

Ignore, inline, translation, and conditional-HTML preservation are decided here. Opaque ancestors suppress descendant embeds regardless of traversal order. Generated markers never become children of the parsed AST. The allocator is local to analysis; printing cannot allocate markers or change preservation decisions.

Plans are retained in a weak map keyed by the parsed document's dictionary, so unrelated formatting calls cannot share allocation state. `analyzeDocument` can also be called directly to test deterministic planning against a frozen AST.

## Doc construction

`printer.ts` consumes the plan, delegates prepared HTML to `textToDoc`, and composes groups, indentation, and line Docs. Planned line-separated block-only sequences can be composed directly without HTML parsing. Ordinary HTML without template constructs or marker-like literals skips Django-specific analysis and Doc rewriting.

`html-doc-cache.ts` bounds reuse of small expression-bearing HTML fragments to one formatting call. Cache keys preserve marker widths, aliasing, literal text, and whitespace sensitivity; hits substitute the current markers and freshen layout-group IDs before Django Docs are inserted. Embedded languages, attribute constructs, and HTML comments retain the ordinary HTML path. Prettier still receives the original fragment, never a canonicalized input.

`html-adapter.ts` substitutes markers inside HTML Doc text leaves; it does not reinterpret or render the resulting Docs. Temporary marker restoration uses literal callbacks, never replacement-string interpolation.

The root returns a composed Doc. There is no `printDocToString` call, final output scan, or post-render whitespace repair. Semantic boundaries have a planned owner, and Prettier makes the final width, indentation, and line-ending decisions.

`test/architecture.ts` exercises raw-source contracts, frozen ASTs, deterministic plans, reversed embedding traversal, explicit preserved spans, shared scanning, Doc composition, boundary layout, and concurrent document isolation. Existing fixtures continue to check exact output and idempotence.
