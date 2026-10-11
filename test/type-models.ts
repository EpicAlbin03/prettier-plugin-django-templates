import { doc, format, type Doc } from "prettier";
import { expect, expectTypeOf, test } from "vitest";
import type { RawBlockNode } from "../src/ast.js";
import { analyzeDocument } from "../src/formatting-plan.js";
import { HtmlDocCache } from "../src/html-doc-cache.js";
import * as plugin from "../src/index.js";
import { parse } from "../src/parser.js";
import { getRawBlockText, isUnclosedRawBlock } from "../src/template-text.js";

const rawCases = [
  {
    kind: "closed-template",
    source: "lead {%  comment  %} literal {{x}} {%  endcomment  %}",
    text: "{% comment %} literal {{x}} {% endcomment %}",
    unclosed: false,
  },
  {
    kind: "unclosed-template",
    source: "lead {% verbatim named %} literal {{x}}",
    text: "{% verbatim named %} literal {{x}}",
    unclosed: true,
  },
  {
    kind: "source",
    source: "lead <!-- {{x}} --> tail",
    text: "<!-- {{x}} -->",
    unclosed: false,
  },
  {
    kind: "source",
    source: "lead <!-- {{x}}",
    text: "<!-- {{x}}",
    unclosed: true,
  },
] satisfies Array<{ kind: RawBlockNode["kind"]; source: string; text: string; unclosed: boolean }>;

test.each(rawCases)("raw variant $kind retains closure and spelling: $source", async (fixture) => {
  const raw = Object.values(parse(fixture.source).nodes).find((node) => node.type === "raw-block");
  if (!raw) throw new Error("Expected a parsed raw block");
  expect(raw.kind).toBe(fixture.kind);
  expect(isUnclosedRawBlock(raw)).toBe(fixture.unclosed);
  expect(getRawBlockText(raw)).toBe(fixture.text);
  if (raw.kind === "closed-template") {
    expectTypeOf(raw.body).toEqualTypeOf<string>();
    expectTypeOf(raw.endArgs).toEqualTypeOf<string>();
    expect(raw.body).toBe(" literal {{x}} ");
  }
  const options = { parser: "django-html", plugins: [plugin] };
  const output = await format(fixture.source, options);
  expect(output).toContain(fixture.text);
  if (fixture.unclosed) {
    // HTML's Doc already supplies a trailing line for an unclosed HTML comment.
    expect(output.endsWith(fixture.text + (raw.kind === "source" ? "\n" : ""))).toBe(true);
  }
  expect(await format(output, options)).toBe(output);
});

test("parent membership carries its relationship and immutable context together", () => {
  const root = parse(
    "{% if x %}<div>{% for y in ys %}{{y}}{% endfor %}</div>{% else %}z{% endif %}",
  );
  expect(root.parentBlock).toBeUndefined();
  const blocks = Object.values(root.nodes).filter((node) => node.type === "template-block");
  expect(blocks).toHaveLength(2);
  for (const block of blocks) {
    expect(block.start.parentBlock).toMatchObject({ id: block.id, relationship: "start" });
    expect(block.end.parentBlock).toMatchObject({ id: block.id, relationship: "end" });
    for (const id of block.childIds) {
      const parent = root.nodes[id].parentBlock;
      expect(parent).toMatchObject({
        id: block.id,
        relationship: "content",
        context: { host: block.hostContext, hasHtmlMarkup: block.start.keyword === "if" },
      });
      expect(Object.isFrozen(parent)).toBe(true);
      expect(Object.isFrozen(parent?.context)).toBe(true);
    }
  }
});

test("each planned segment owns its original text, prepared text, and boundary", () => {
  const root = parse(
    "<main>{% if x %}<div>{{x}}</div>{% else %}<div>{{y}}</div>{% endif %}</main>",
  );
  const plan = analyzeDocument(root);
  for (const layout of plan.containers.values()) {
    expect(layout.segments.map((segment) => segment.original).join("")).toBe(layout.node.html);
    for (const segment of layout.segments) {
      expect(segment.segment).toBeTypeOf("string");
      expect(["none", "line", "trim-line"]).toContain(segment.boundary.before);
      expect(segment.boundary.after).toBeGreaterThanOrEqual(0);
    }
  }
});

test("cached Docs leave absent and non-symbol conditional group ids untouched", async () => {
  const root = parse("{{ a }}{{ b }}");
  const [firstId, secondId] = Object.keys(root.nodes);
  const cache = new HtmlDocCache(root.nodes);
  const conditional = { ...doc.builders.ifBreak("broken", "flat"), groupId: "not-a-symbol" };
  const missingGroupId = {
    ...doc.builders.indentIfBreak("indented", { groupId: Symbol("unused") }),
    groupId: undefined,
  };
  const textToDoc = async (text: string): Promise<Doc> => [
    text,
    conditional,
    doc.builders.ifBreak("broken", "flat"),
    missingGroupId,
  ];
  await cache.format(`<p>${firstId}</p>`, textToDoc, "css");
  const result = await cache.format(`<p>${secondId}</p>`, textToDoc, "css");
  expect(result).toEqual([
    `<p>${secondId}</p>`,
    conditional,
    doc.builders.ifBreak("broken", "flat"),
    missingGroupId,
  ]);
});
