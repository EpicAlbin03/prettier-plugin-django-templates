import { format } from "prettier";
import { expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const formatTemplate = (source: string) =>
  format(source, { parser: "django-html", plugins: [DjangoPlugin] });

const semanticTokens = (source: string) =>
  source.match(/<[^>]+>|{%[\s\S]*?%}|{{[\s\S]*?}}|[^\s<>{}]+/g) ?? [];

test("generic document-flow docs preserve whitespace-sensitive token order", async () => {
  const source =
    "<p>before {% custom_asset %} after</p><ul><li>{{ label }}{% if show %}<ol>{{ descendants }}</ol>{% endif %}</li></ul>";
  const formatted = await formatTemplate(source);

  expect(semanticTokens(formatted)).toEqual(semanticTokens(source));
  expect(formatted).toMatch(/before\s+{% custom_asset %}\s+after/);
  expect(formatted).toContain("{% if show %}<ol>{{ descendants }}</ol>{% endif %}");
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

test("consecutive standalone-only elements receive one stable line break", async () => {
  const source = "<span>{% foo %}</span><em>{% bar %}</em>";
  const formatted = await formatTemplate(source);

  expect(formatted).toBe("<span>{% foo %}</span>\n<em>{% bar %}</em>\n");
  expect(await formatTemplate(formatted)).toBe(formatted);
});

test.each([
  [
    "comment",
    "<!-- <fake> --><span>{% foo %}</span><div>y</div>",
    "<!-- <fake> -->\n<span>{% foo %}</span>\n<div>y</div>\n",
  ],
  [
    "script",
    '<script>const value = "<fake>";</script><span>{% foo %}</span><div>y</div>',
    '<script>\n  const value = "<fake>";\n</script>\n<span>{% foo %}</span>\n<div>y</div>\n',
  ],
  [
    "style",
    '<style>.item::before { content: "<fake>"; }</style><span>{% foo %}</span><div>y</div>',
    '<style>\n  .item::before {\n    content: "<fake>";\n  }\n</style>\n<span>{% foo %}</span>\n<div>y</div>\n',
  ],
  [
    "template",
    "<template><fake></fake></template><span>{% foo %}</span><div>y</div>",
    "<template><fake></fake></template>\n<span>{% foo %}</span>\n<div>y</div>\n",
  ],
])("%s prefixes with tag-like text split idempotently", async (_name, source, expected) => {
  const formatted = await formatTemplate(source);

  expect(formatted).toBe(expected);
  expect(await formatTemplate(formatted)).toBe(formatted);
});
