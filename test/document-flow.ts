import { format } from "prettier";
import { expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const formatTemplate = (source: string) =>
  format(source, { parser: "django-html", plugins: [DjangoPlugin] });

const semanticTokens = (source: string) =>
  source.match(/<[^>]+>|{%[\s\S]*?%}|{{[\s\S]*?}}|[^\s<>{}]+/g) ?? [];

test.each(['{% include "part.html" %}', '{% url "view" as target %}'])(
  "standalone tag %s does not add rendered whitespace inside inline text",
  async (tag) => {
    const source = `<span>a${tag}b</span>`;
    await expect(formatTemplate(source)).resolves.toBe(`${source}\n`);
  },
);

test.each([
  ["JavaScript", "<script>const text = \"{% include 'part.html' %}\";</script>"],
  ["CSS", "<style>.x { content: \"{% include 'part.html' %}\"; }</style>"],
])("standalone tags do not insert literal newlines into a %s string", async (_name, source) => {
  await expect(formatTemplate(source)).resolves.toContain("\"{% include 'part.html' %}\"");
});

test("a standalone tag inside a JavaScript expression does not trigger semicolon insertion", async () => {
  const source = '<script>const x = {{value}}{% include "suffix" %};</script>';
  // A suffix template containing '+ 1' is part of the initializer, not a statement.
  const output = await formatTemplate(source);
  expect(output).toContain('{{ value }}{% include "suffix" %};');
  expect(await formatTemplate(output)).toBe(output);
});

test("adjacent inline elements containing standalone tags stay adjacent", async () => {
  const source = '<span>{% include "a" %}</span><span>{% include "b" %}</span>';
  const output = await formatTemplate(source);
  // A line break between these elements renders an extra word separator.
  expect(output).toContain("</span><span>");
  expect(await formatTemplate(output)).toBe(output);
});

test("a non-rendering comment block between inline siblings adds no separator", async () => {
  const source = "<span>a</span>{% comment %}hidden{% endcomment %}<span>b</span>";
  await expect(formatTemplate(source)).resolves.toBe(`${source}\n`);
});

test("leading blank lines before a standalone tag are removed on the first pass", async () => {
  const output = await formatTemplate('\n\n{% include "part.html" %}\n');
  expect(await formatTemplate(output)).toBe(output);
});

test("title content containing a standalone tag is idempotent", async () => {
  const source = '<title>{{a}}{% include "part.html" %}{{b}}</title>';
  const output = await formatTemplate(source);
  expect(await formatTemplate(output)).toBe(output);
});

test("generic document-flow docs preserve whitespace-sensitive token order", async () => {
  const source =
    "<p>before {% custom_asset %} after</p><ul><li>{{ label }}{% if show %}<ol>{{ descendants }}</ol>{% endif %}</li></ul>";
  const formatted = await formatTemplate(source);

  expect(semanticTokens(formatted)).toEqual(semanticTokens(source));
  expect(formatted).toMatch(/before\s+{% custom_asset %}\s+after/);
  expect(formatted).toContain(
    "{% if show %}\n      <ol>\n        {{ descendants }}\n      </ol>\n    {% endif %}",
  );
  expect(await formatTemplate(formatted)).toBe(formatted);
});

test("inline template-block near misses do not gain significant whitespace", async () => {
  const source = "<span>{{ a }}{% if b %}<em>{{ c }}</em>{% endif %}d</span>";
  const formatted = await formatTemplate(source);

  expect(formatted).toBe("<span>{{ a }}{% if b %}<em>{{ c }}</em>{% endif %}d</span>\n");
  expect(await formatTemplate(formatted)).toBe(formatted);
});

test("mid-document standalone-only elements remain inline and idempotent", async () => {
  const source = "<div>x</div><span>{% foo %}</span><div>y</div>";
  const formatted = await formatTemplate(source);

  expect(formatted).toBe("<div>x</div>\n<span>{% foo %}</span>\n<div>y</div>\n");
  expect(await formatTemplate(formatted)).toBe(formatted);
});

test("standalone-only element matching is quote-aware", async () => {
  const source = '<div>x</div><span title=">">{% foo %}</span><div>y</div>';
  const formatted = await formatTemplate(source);

  expect(formatted).toBe('<div>x</div>\n<span title=">">{% foo %}</span>\n<div>y</div>\n');
  expect(await formatTemplate(formatted)).toBe(formatted);
});

test("consecutive standalone-only inline elements stay adjacent", async () => {
  const source = "<span>{% foo %}</span><em>{% bar %}</em>";
  const formatted = await formatTemplate(source);

  expect(formatted).toBe("<span>{% foo %}</span><em>{% bar %}</em>\n");
  expect(await formatTemplate(formatted)).toBe(formatted);
});

test.each([
  [
    "comment",
    "<!-- <fake> --><span>{% foo %}</span><div>y</div>",
    "<!-- <fake> --><span>{% foo %}</span>\n<div>y</div>\n",
  ],
  [
    "script",
    '<script>const value = "<fake>";</script><span>{% foo %}</span><div>y</div>',
    '<script>\n  const value = "<fake>";\n</script>\n<span>{% foo %}</span>\n<div>y</div>\n',
  ],
  [
    "style",
    '<style>.item::before { content: "<fake>"; }</style><span>{% foo %}</span><div>y</div>',
    '<style>\n  .item::before {\n    content: "<fake>";\n  }</style\n><span>{% foo %}</span>\n<div>y</div>\n',
  ],
  [
    "template",
    "<template><fake></fake></template><span>{% foo %}</span><div>y</div>",
    "<template><fake></fake></template><span>{% foo %}</span>\n<div>y</div>\n",
  ],
])("%s prefixes with tag-like text format idempotently", async (_name, source, expected) => {
  const formatted = await formatTemplate(source);

  expect(formatted).toBe(expected);
  expect(await formatTemplate(formatted)).toBe(formatted);
});
