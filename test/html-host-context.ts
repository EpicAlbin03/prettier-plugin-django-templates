import { format } from "prettier";
import { describe, expect, test } from "vitest";
import type { DjangoNode, RootNode } from "../src/ast.js";
import { scanHtmlHostContexts, type HtmlHostContext } from "../src/html-host-context.js";
import * as DjangoPlugin from "../src/index.js";
import { parse } from "../src/parser.js";

type ExpectedContext = [needle: string, context: HtmlHostContext, occurrence?: number];

function offsetOf(source: string, needle: string, occurrence = 0): number {
  let offset = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    offset = source.indexOf(needle, offset + 1);
  }
  expect(
    offset,
    `Missing occurrence ${occurrence} of ${JSON.stringify(needle)}`,
  ).toBeGreaterThanOrEqual(0);
  return offset;
}

describe("HTML host context scanner", () => {
  test.each<{ name: string; source: string; expected: ExpectedContext[] }>([
    {
      name: "document flow and tag boundaries",
      source: "before<div disabled>inside</div>after",
      expected: [
        ["before", "document-flow"],
        ["<div", "document-flow"],
        ["div", "start-tag"],
        [">", "start-tag"],
        ["inside", "document-flow"],
        ["/div", "start-tag"],
        ["after", "document-flow"],
      ],
    },
    {
      name: "single, double, and multiline quoted values",
      source: `<div title="> and <"\n data-note='line\n> two'>body</div>`,
      expected: [
        ["title", "start-tag"],
        ["> and <", "attribute-value"],
        ["data-note", "start-tag"],
        ["line\n> two", "attribute-value"],
        ["body", "document-flow"],
      ],
    },
    {
      name: "protected constructs retain their surrounding context",
      source: `<div {{ attrs|default:">" }} title="{{ value|default:'<' }}" {% if active %}open{% endif %}>{{ body }}</div>`,
      expected: [
        ["{{ attrs", "start-tag"],
        ["default", "start-tag"],
        ["{{ value", "attribute-value"],
        ["{% if", "start-tag"],
        ["{{ body", "document-flow"],
      ],
    },
    {
      name: "raw tag names inside attributes do not create document-flow raw bodies",
      source: `<div title="{% verbatim %}" data-after="{% endverbatim %}">{{ after }}</div>`,
      expected: [
        ["{% verbatim", "attribute-value"],
        ["data-after", "start-tag"],
        ["{% endverbatim", "attribute-value"],
        ["{{ after", "document-flow"],
      ],
    },
    {
      name: "comments and declarations ignore tag-like text",
      source: `<!-- <fake title="x"> --> <!DOCTYPE html " > " > {{ value }}`,
      expected: [
        ["fake", "document-flow"],
        ["title", "document-flow"],
        ["DOCTYPE", "document-flow"],
        ["{{ value", "document-flow"],
      ],
    },
    {
      name: "script and style bodies ignore HTML-looking strings",
      source: `<script>const html = '<fake title="x">'; {{ script_value }}</script><style>.x{content:'<b>'} {% theme %}</style>`,
      expected: [
        ["fake", "document-flow"],
        ["{{ script", "document-flow"],
        ["/script", "start-tag"],
        ["<b>", "document-flow"],
        ["{% theme", "document-flow"],
        ["/style", "start-tag"],
      ],
    },
    {
      name: "malformed tags and quotes retain conservative context",
      source: `<div title="unterminated {{ value }}`,
      expected: [
        ["div", "start-tag"],
        ["unterminated", "attribute-value"],
        ["{{ value", "attribute-value"],
      ],
    },
    {
      name: "unclosed tags retain start-tag context",
      source: `<div disabled {% active %}`,
      expected: [
        ["disabled", "start-tag"],
        ["{% active", "start-tag"],
      ],
    },
  ])("classifies $name", ({ source, expected }) => {
    const contexts = scanHtmlHostContexts(source);
    for (const [needle, context, occurrence = 0] of expected) {
      expect(contexts.at(offsetOf(source, needle, occurrence)), needle).toBe(context);
    }
  });

  test("protects complete raw bodies and ignore regions from affecting later context", async () => {
    const source = `{% verbatim %}<fake title="{% endverbatim %}
<!-- prettier-ignore-start --><broken value='<!-- prettier-ignore-end -->
{{ after }}`;
    const contexts = scanHtmlHostContexts(source);
    const afterOffset = offsetOf(source, "{{ after");
    expect(contexts.at(afterOffset)).toBe("document-flow");

    const parseSource = parse as unknown as (text: string) => RootNode | Promise<RootNode>;
    const root = await parseSource(source);
    const after = Object.values(root.nodes).find(
      (node) => node.type === "expression" && node.content.trim() === "after",
    );
    expect(after?.inTag).toBe(false);
    expect(after?.inAttribute).toBe(false);
  });

  test("tracks post-render normalization safety independently of lexical host context", () => {
    const source = `<div {% firstof a b %}><script>{{ value }}{% if enabled %}</script>text`;
    const contexts = scanHtmlHostContexts(source);
    expect(contexts.isDocumentFlowNormalizationSafeAt(offsetOf(source, "{% firstof"))).toBe(true);
    expect(contexts.at(offsetOf(source, "{% firstof"))).toBe("start-tag");
    expect(contexts.isDocumentFlowNormalizationSafeAt(offsetOf(source, "{{ value"))).toBe(false);
    expect(contexts.isDocumentFlowNormalizationSafeAt(offsetOf(source, "text"))).toBe(true);
  });

  test("defaults out-of-range offsets to conservative document flow", () => {
    const contexts = scanHtmlHostContexts("<div>");
    expect(contexts.at(-1)).toBe("document-flow");
    expect(contexts.at(100)).toBe("document-flow");
    expect(contexts.isDocumentFlowNormalizationSafeAt(-1)).toBe(false);
    expect(contexts.isDocumentFlowNormalizationSafeAt(100)).toBe(false);
  });

  test("parser and printer callers share the scanner's context decisions", async () => {
    const source =
      '<div {{ attrs }} title="{{ label }}{% if suffix %}-{{ suffix }}{% endif %}"><script>const html = "<fake>"; {{ payload }}</script></div>';
    const contexts = scanHtmlHostContexts(source);
    const parseSource = parse as unknown as (text: string) => RootNode | Promise<RootNode>;
    const root = await parseSource(source);
    const contextForNode = (node: DjangoNode): HtmlHostContext =>
      node.inAttribute ? "attribute-value" : node.inTag ? "start-tag" : "document-flow";

    for (const node of Object.values(root.nodes)) {
      if (node.type === "root" || node.type === "template-block") {
        continue;
      }
      expect(contextForNode(node), node.originalText).toBe(contexts.at(node.sourceStart));
    }

    const formatted = await format(source, {
      parser: "django-html",
      plugins: [DjangoPlugin],
    });
    expect(formatted).toContain("{{ label }}{% if suffix %}-{{ suffix }}{% endif %}");
    expect(await format(formatted, { parser: "django-html", plugins: [DjangoPlugin] })).toBe(
      formatted,
    );
  });

  test.each([
    [
      "script raw text",
      `<script>const value = "{{ value }}{% if enabled %}x{% endif %}";</script>`,
      `{{ value }}{% if enabled %}`,
    ],
    [
      "unquoted start-tag space",
      `<div {{ attrs }}{% if enabled %} hidden{% endif %}></div>`,
      `{{ attrs }} {% if enabled %}`,
    ],
  ])("does not insert document-flow boundaries in %s", async (_name, source, adjacency) => {
    const formatted = await format(source, {
      parser: "django-html",
      plugins: [DjangoPlugin],
    });
    expect(formatted).toContain(adjacency);
    expect(formatted).not.toMatch(/\}\}\s*\n\s*{% if/);
    expect(await format(formatted, { parser: "django-html", plugins: [DjangoPlugin] })).toBe(
      formatted,
    );
  });
});
