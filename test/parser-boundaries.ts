import { format } from "prettier";
import { describe, expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";
import { parse } from "../src/parser.js";

const formatTemplate = (source: string) =>
  format(source, { parser: "django-html", plugins: [DjangoPlugin] });

describe("quoted template tag arguments", () => {
  test.each([
    [
      "escaped double quotes",
      String.raw`{%  translate   "say \"hello\"  now"   %}`,
      String.raw`{% translate "say \"hello\"  now" %}`,
    ],
    [
      "escaped single quotes",
      String.raw`{%  translate   'it\'s  ready'   %}`,
      String.raw`{% translate 'it\'s  ready' %}`,
    ],
    [
      "escaped backslashes",
      String.raw`{%  custom_asset   "path\\"   next   %}`,
      String.raw`{% custom_asset "path\\" next %}`,
    ],
  ])(
    "preserves %s and quoted whitespace while normalizing separators",
    async (_name, source, normalized) => {
      const root = parse(source);
      const tags = Object.values(root.nodes).filter((node) => node.type === "template-tag");
      expect(tags).toHaveLength(1);
      expect(tags[0]).toMatchObject({
        sourceText: source,
        sourceStart: 0,
        sourceEnd: source.length,
      });
      expect(await formatTemplate(source)).toBe(`${normalized}\n`);
      expect(await formatTemplate(`${normalized}\n`)).toBe(`${normalized}\n`);
    },
  );
});

test("locates a construct after leading blank lines", async () => {
  const source = "\n\n{{value}}";
  const nodes = Object.values(parse(source).nodes);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]).toMatchObject({ type: "expression", sourceStart: 2, sourceEnd: 11 });
  expect(await formatTemplate(source)).toBe("{{ value }}\n");
});

test("resumes attribute parsing after a case-insensitive raw-text closing tag with whitespace", () => {
  const source = '<script></   SCRIPT><div title="{{value}}"></div>';
  const expressions = Object.values(parse(source).nodes).filter(
    (node) => node.type === "expression",
  );
  expect(expressions).toHaveLength(1);
  expect(expressions[0]).toMatchObject({
    hostContext: "attribute-value",
    sourceStart: source.indexOf("{{"),
    sourceEnd: source.indexOf("}}") + 2,
  });
});

test.each(["<script></", "<script></script", "<"])(
  "accepts truncated markup without inventing template constructs: %s",
  (source) => {
    const root = parse(source);
    expect(root).toMatchObject({ sourceStart: 0, sourceEnd: source.length, sourceText: source });
    expect(Object.values(root.nodes)).toEqual([]);
  },
);

describe("incomplete preserved regions", () => {
  test("an unclosed HTML comment does not suppress active Django tags", () => {
    const source = "before <!-- {{ unfinished {% endif %}";
    expect(() => parse(source)).toThrow('No start tag found for template end tag "{% endif %}".');
  });

  test.each([
    "{% verbatim named %}",
    "{% verbatim named %}literal {% endverbatim",
    "{% verbatim named %}{% endverbatim other %}",
  ])("preserves a named raw body without its exact terminator: %s", async (source) => {
    const root = parse(source);
    const nodes = Object.values(root.nodes);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      type: "raw-block",
      sourceText: source,
      sourceStart: 0,
      sourceEnd: source.length,
      body: undefined,
    });
    expect(await formatTemplate(source)).toBe(source);
  });

  test.each(["comment", "verbatim"])(
    "an unmatched unnamed %s tag does not hide following expressions",
    (name) => {
      const source = `{% ${name} %}{{ value }}`;
      const root = parse(source);
      const nodes = Object.values(root.nodes);
      expect(nodes.map((node) => node.type)).toEqual(["template-tag", "expression"]);
      expect(nodes[1]).toMatchObject({
        sourceStart: source.indexOf("{{"),
        sourceEnd: source.length,
        sourceText: "{{ value }}",
      });
    },
  );
});

test.each([
  "<!-- prettier-ignore-start -->{{broken<!-- prettier-ignore-end -->",
  "{# prettier-ignore-start #}{{broken{# prettier-ignore-end #}",
])("locates template tags after opaque ignore regions: %s", (region) => {
  const source = `${region}\n\n{% include 'card.html' %}\n`;
  expect(
    Object.values(parse(source).nodes).find((node) => node.type === "template-tag"),
  ).toMatchObject({
    sourceText: "{% include 'card.html' %}",
    sourceStart: region.length + 2,
    sourceEnd: source.length - 1,
  });
});
