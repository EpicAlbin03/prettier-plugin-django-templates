# Formatting review

## Scope and reproduction

Reviewed `src/`, the focused tests in `test/`, and relevant formatting fixtures. Findings below are reproduced through Prettier's public `format()` API, not just internal helpers. This is a list of confirmed findings, not a guarantee that no others remain.

- Before changes: **514 tests passed** across 26 test files.
- Added: `test/formatting-review-regressions.ts`, with **40 intentionally failing cases covering 24 findings**.
- Also added: **40 `input.html` / `expected.html` fixture pairs**, mirroring those cases under `test/cases/data/review_f01_*` through `review_f24_*`.
- No production code or existing expectations were changed.
- Run the focused regressions: `vp test run test/formatting-review-regressions.ts`.
- Run just the new fixtures: `vp test run test/cases/index.ts -t 'cases: review_'`.
- Run everything: `vp test run` (**514 existing tests pass; 80 new tests intentionally fail**).

The F01–F24 identifiers below match the test names and fixture directory prefixes. Tests assert desired behavior; they are not skipped, marked `test.fails`, or snapshots of broken output. In examples, `\n` and `\r` denote actual line-ending characters.

### Input/expected fixture conventions

Each fixture supplies complete desired output, including significant whitespace and EOF behavior. The existing fixture runner automatically discovers these directories and checks both exact output and second-pass idempotence. Cases that currently throw contain the valid expected template, not an expected-error sentinel.

- Variants get separate directories, for example `review_f01_unquoted_attribute_expression`, `review_f01_unquoted_attribute_interpolated_text`, and `review_f01_unquoted_attribute_conditional`.
- Whitespace-preservation cases keep significant inline text and tag adjacency. Structural tag-support cases (F17–F19) and the CR-containing `if` case (F24) expect multiline blocks with two-space body indentation and aligned branch/end tags; compact input is not itself a requirement to keep those blocks inline. Embedded JS/CSS expectations allow ordinary surrounding code indentation without altering strings or statement boundaries.
- `review_f24_cr_expression_input/input.html` and `review_f24_cr_tag_input/input.html` contain literal CR bytes, not escaped text. `.gitattributes` disables text conversion for the F24 HTML fixtures so checkout normalization cannot change the cases.
- `review_f24_cr_output_literal_delimiters/config.json` requests `endOfLine: "cr"`. Its expected output deliberately retains the LF inside the literal delimiter and has no added EOF newline: preserving Django lexical meaning must take precedence over converting that significant LF into CR. The existing runner leaves lone CR bytes intact, so no runner changes are required.

## Corrupted markup and lost template constructs

### F01 — Unquoted attribute values become broken marker attributes

**High impact.** `<div data-x={{value}}></div>` becomes `<div data-x="dj0" =""></div>`. The expression is lost. Literal prefixes/suffixes and conditional values are also affected.

The scanner only recognizes quoted attribute-value contexts (`src/html-host-context.ts:167`). Consequently the parser emits an attribute-shaped marker inside an existing value (`src/parser.ts:443`), and HTML formatting splits it before restoration.

Tests cover an expression, interpolation with surrounding text, and a conditional value. Existing `test/html-host-context.ts` checks unquoted attribute _ranges_, but not the formatting/context classification of their contents.

### F02 — A conditional attribute touching a void element name corrupts the name

**High impact.** `<input{% if x %} disabled{% endif %}>` becomes `<inputdj2 =""></inputdj2>`: both the conditional and the input element are lost.

A closed start-tag block receives an attribute-shaped ID but `protectedMarkerKind: "inline"` (`src/parser.ts:687–704`). The separator insertion in `adaptHtmlProjection` only handles nodes classified as `attr` (`src/formatting-plan.ts:484`), so the marker is parsed as part of the element name. The test specifically uses a void element; a balanced `<div>...</div>` can instead take a preservation fallback.

### F03 — Marker allocation overlooks attributes that normalize to marker spellings

**High impact.** `<div dj0='' {{attrs}}></div>` becomes `<div {{ attrs }} {{ attrs }}></div>`. The real `dj0` attribute disappears and the template expression is duplicated. `dj0 = ""` has the same problem.

`src/internal-markers.ts:43` reserves only the exact spelling `dj0=""`, not HTML-equivalent spellings. Prettier normalizes the real attribute into the allocated marker before `src/html-adapter.ts` restores markers. Existing collision tests cover exact marker spellings, not normalization-induced collisions.

## Changes to rendered text and embedded code

### F04 — Inline textual blocks are expanded inside block-flow HTML or at the root

**High impact.** `<div>a{% if x %}b{% endif %}c</div>` gains newlines around `b`; with `x=true`, `abc` becomes text containing spaces between the letters. Root-level text has the same issue. A loop emitting `{{ x }},` gains separators between iterations.

`src/formatting-plan.ts:836–843` protects inline blocks based on the enclosing element's display classification, not the significance of the block's text. `src/printer.ts:166` then expands other document-flow blocks. A block-level parent does not make whitespace between its textual children insignificant. Tests cover root text, a `div`, and a loop. Existing inline-whitespace tests primarily exercise inline parents such as `span`.

### F05 — Whitespace-only blocks lose their entire body

**High impact.** `<div>one{% if x %} {% endif %}two</div>` loses the space inside the conditional. With `x=true`, `one two` becomes `onetwo`.

The whitespace-only branch of `buildBlock` (`src/printer.ts:173`) prints the delimiters without their body. Existing empty-block fixtures use genuinely empty bodies and miss this distinction.

### F06 — Structural formatting changes the input and result of filter blocks

**High impact.** `{% filter length %}abc{% endfilter %}` acquires newlines and indentation inside the block. Django consequently filters a different string and no longer returns `3`.

`filter` is treated as an ordinary structural block (`src/tags.ts`, `src/printer.ts:166`); unlike translation blocks, it has no body-preservation policy in `src/template-text.ts` / `src/formatting-plan.ts`. This is significant even without any surrounding inline HTML. The existing `template_tag_filter_block/expected.html` fixture already encodes inserted body whitespace, but uses `lower`, which obscures the changed input.

### F07 — Standalone tags introduce whitespace inside inline text

**High impact.** `<span>a{% include "part.html" %}b</span>` gains literal newlines around the include. An empty included template should leave `ab`, not `a b`. A non-rendering `{% url "view" as target %}` produces the same problem.

The block marker/standalone printing policy (`src/parser.ts:443`, `src/printer.ts:63`) is applied without protecting surrounding inline text. Tests cover both an include and an assigned URL tag. Existing standalone-text tests use already-separated words or tags classified as inline.

### F08 — Standalone tags introduce literal newlines inside JS/CSS strings

**High impact.** A string such as `"{% include 'part.html' %}"` inside `script` or `style` gains line breaks _between its quote characters_. Even if the include renders ordinary text, the resulting JavaScript/CSS string is broken.

`printDocumentFlowNode` (`src/printer.ts:63`) injects HTML-style line breaks into embedded-language string Docs. The tests assert string-literal adjacency without prescribing surrounding JS/CSS formatting. Both language paths fail.

### F09 — Standalone block markers change JavaScript statement boundaries

**High impact.** `<script>const x = {{value}}{% include "suffix" %};</script>` gains a semicolon between the expression and include. If the suffix template contains `+ 1`, the initializer's meaning changes. A second formatting pass also removes the now-redundant trailing semicolon, so the result is not idempotent.

The include's HTML-comment marker reaches the JavaScript formatter through the HTML embedding path (`src/parser.ts:443`, `src/html-doc-cache.ts:35`, `src/printer.ts:290`). JavaScript interprets that marker as a comment before it is restored. This is separate from F08's line breaks inserted during restoration.

### F10 — Splitting standalone-only elements inserts separators between inline siblings

**High impact.** `<span>{% include "a" %}</span><span>{% include "b" %}</span>` is split onto separate lines. The added inter-element whitespace changes adjacent rendered text.

`splitTopLevelInlineOnlyStandaloneElements` and `planSegmentBoundaries` (`src/formatting-plan.ts:71`, `:615`) unconditionally separate these elements. `test/document-flow.ts` currently expects the same problematic newline for adjacent `span`/`em` elements containing custom tags. Those existing expectations will need reconsideration when fixing this finding.

### F11 — A non-rendering comment block adds whitespace between inline siblings

**High impact.** `<span>a</span>{% comment %}hidden{% endcomment %}<span>b</span>` gains a newline after the first span. Django removes the comment block, leaving a separator that was absent from the original rendered text.

Raw blocks use block markers (`src/parser.ts:460`), and `adaptHtmlProjection` inserts a newline after an adjacent closing HTML tag (`src/formatting-plan.ts:507–519`). Existing tests preserve comment blocks inside a single inline element, but not between inline siblings.

### F12 — Two or more HTML attributes cause inline content padding

**High impact.** `<span class="a" title="b">{{ value }}</span>` becomes `<span class="a" title="b"> {{ value }} </span>`. A template comment as the only child also gains spaces, even though the comment renders nothing. Equivalent one-attribute inputs do not get padding.

`adaptHtmlProjection` (`src/formatting-plan.ts:523–538`) inserts line breaks around a single inline marker based on the number of attributes, without checking whether the element's body is whitespace-sensitive. HTML formatting collapses these into spaces. Existing multiple-attribute tests target `div` and attribute wrapping rather than inline body semantics.

## Ignore and raw-region handling

### F13 — Valid alternative spellings of prettier-ignore do not protect Django tokens

**Medium impact.** `<!--prettier-ignore-->` and a multiline comment containing only `prettier-ignore` are valid Prettier directives, but `{{value}}` inside the ignored element becomes `{{ value }}`.

`ignoredSourceRanges` (`src/formatting-plan.ts:741–746`) requires the exact full comment string `<!-- prettier-ignore -->`, unlike its whitespace-tolerant attribute-ignore matching. The HTML printer honors the directive, but Django marker restoration does not. Existing directive-grammar tests cover attribute ignores only.

### F14 — prettier-ignore targets the wrong source range

**Medium impact.** There are two reproducible scope errors:

- `<!-- prettier-ignore -->{{first}} {{second}}` preserves only the first expression, not the entire following HTML text node.
- If ordinary text or another HTML comment follows the directive, an unrelated later element's Django tokens are ignored even though that element's HTML is still formatted.

`ignoredSourceRanges` (`src/formatting-plan.ts:747–762`) chooses between the next Django node and the next HTML tag without modeling intervening text/comment nodes or the entire text-node target. Three tests cover these cases.

### F15 — Comment blocks accept a non-exact terminator that Django ignores

**High impact.** The valid template `{% comment %}{% endcomment note %}ignored{% endcomment %}` throws an unmatched-end-tag error. Django ignores `endcomment note` and closes on the final exact `endcomment` token.

`matchesRawBodyEnd` (`src/tags.ts:285`) compares only the first word for comment blocks. Django's `Parser.skip_past()` compares the whole token content. `test/tags.ts` currently asserts the incorrect behavior for `endcomment optional`; that assertion will need updating along with the implementation.

### F16 — Comment scanning does not respect lexer-level verbatim state

**High impact.** `{% comment %}{% verbatim %}{% endcomment %}{% endverbatim %}{% endcomment %}` is valid Django but throws on `endverbatim`. The inner `endcomment` is literal text while Django's lexer is in verbatim mode.

`findRawBodyEnd` (`src/template-regions.ts:25`) skips complete expression/comment tokens but does not maintain verbatim state while searching for a comment terminator. Existing raw-terminator tests cover tokens containing terminator-looking text, not this lexer-state interaction.

## Supported tag variants rejected by the parser

### F17 — Self-closing django-components tags are treated as unclosed blocks

**High impact.** `{% if x %}{% component "card" / %}{% endif %}` throws because the component is considered still open. A self-closing `slot` does too.

The registry classifies these names unconditionally as starts (`src/tags.ts:62`), and `createTagToken` / the parser stack never interpret the `/` form (`src/parser.ts:168`, `:731–738`). Existing component fixtures exercise paired forms only.

### F18 — Standalone django CMS placeholders are treated as unclosed blocks

**High impact.** `{% if x %}{% placeholder "content" %}{% endif %}` throws because `placeholder` is considered still open. Django CMS requires a body only when the `or` option is present.

The unconditional start descriptor (`src/tags.ts:79`) cannot distinguish the standalone and fallback-body forms. Existing ecosystem-block coverage exercises paired placeholders.

### F19 — django-waffle switch/sample reject valid else branches

**High impact.** `{% switch "feature" %}yes{% else %}no{% endswitch %}` and the equivalent `sample` block both throw at `else`.

The branch registry includes `flag` but omits `switch` and `sample` (`src/tags.ts:105`), although all three use the same upstream branch parser. The existing registry test snapshots this incomplete parent matrix rather than testing those valid variants.

## Preservation and idempotence inconsistencies

### F20 — Quoted whitespace in comment-tag notes is collapsed

**Low impact; source fidelity.** `{% comment "keep  these  spaces" %}hidden{% endcomment %}` loses the doubled spaces in its quoted note. Rendering is unaffected, but this contradicts the quote-aware normalization applied to other tag arguments.

`createTagToken` normalizes content quote-aware, then reconstructs `args` using `split(/\s+/)` and `join(" ")` (`src/parser.ts:174–183`). `getRawBlockText` prints those lossy args (`src/template-text.ts:68`). Existing escaped-quote tests cover ordinary template tags, not raw-block opening arguments.

### F21 — Preformatted token preservation is lost inside HTML template elements

**Medium impact; inconsistent preservation contract.** `<template><pre>{{value}}</pre></template>` normalizes the expression, while the same `pre` outside `template` preserves its original token spelling. `textarea` has the same inconsistency.

`scanHtmlHostContexts` treats `template` as raw text (`src/html-host-context.ts:289–307`), so it never discovers nested preformatted elements and their protection requirements. HTML template contents are parsed HTML, not raw text. These tests concern exact body/token preservation, not a claim that the added spaces inside Django expression delimiters alter its evaluated value.

### F22 — Leading blank lines require a second formatting pass

**Medium impact.** `\n\n{% include "part.html" %}\n` becomes `\n{% include "part.html" %}\n` on the first pass, then loses the remaining leading newline on the second pass.

The `preNewLines > 1` path in `printTemplateTag` (`src/printer.ts:105–115`) retains a leading line even at the document start. Existing leading-blank-line coverage uses an expression, not a standalone flow tag.

### F23 — Title content with an include is not idempotent

**Medium impact.** `<title>{{a}}{% include "part.html" %}{{b}}</title>` first becomes multiline; on the second pass it collapses to a single line with a space before `{{ b }}`.

The interaction is between raw-text HTML embedding and standalone block marker restoration (`src/html-host-context.ts:289`, `src/printer.ts:63`). Existing title tests use inline template blocks, not standalone includes between expressions.

### F24 — CR/LF normalization changes which Django constructs are active

**High impact; Prettier integration limitation.** Three cases reproduce through the public formatter:

- `{{\rvalue}}` is a valid Django expression, but default formatting converts it into the literal, LF-spanning `{{\nvalue}}`.
- `{% if\rx %}yes{% endif %}` is valid Django, but formatting throws an unmatched `endif` error after the opener becomes LF-spanning.
- With `endOfLine: "cr"`, literal `{{\nvalue}}` becomes active `{{\rvalue}}`, changing literal output into variable interpolation.

Django's lexer excludes LF, not CR. Prettier normalizes input line endings before invoking the plugin and applies output line endings afterward. Consequently the careful lexer in `src/parser.ts:234` / `src/template-regions.ts:32` does not receive the original distinction. This is an API-boundary compatibility problem, not simply a missing scanner condition. Existing `test/django-lexer.ts` tests CR recognition using `parse()` directly; existing CR output tests use constructs without internal line breaks. A fix must address or explicitly handle the integration limitation rather than only adjusting `parse()`.

## Primary-source checks

The vendored repositories described in `AGENTS.md` were not present under `@repos/` in this checkout. For framework-specific findings, these upstream sources were checked read-only:

- [Django template lexer and Parser.skip_past](https://github.com/django/django/blob/main/django/template/base.py): exact comment termination, lexer-level verbatim state, and non-DOTALL tokenization.
- [Django default tags](https://github.com/django/django/blob/main/django/template/defaulttags.py): comment parsing and filter-body evaluation.
- [django-waffle tag implementation](https://github.com/jazzband/django-waffle/blob/master/waffle/templatetags/waffle_tags.py): shared `else` handling for flag/switch/sample.
- [django CMS placeholder implementation](https://github.com/django-cms/django-cms/blob/main/cms/templatetags/cms_tags.py): optional `or` controls whether a placeholder has a body.
- [django-components node implementation](https://github.com/django-components/django-components/blob/master/src/django_components/node.py): self-closing tag syntax and shared tag parsing.
