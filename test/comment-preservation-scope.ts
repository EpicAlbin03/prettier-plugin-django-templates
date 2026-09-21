import { format } from "prettier";
import { expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const options = { parser: "django-html", plugins: [DjangoPlugin] };

test.each([
  "<!-- {% if x%} -->a{% endif %}",
  "{% if x%}a<!-- {% endif %} -->",
  "{% if x%}<!-- {% else %} -->other{% endif %}",
  "<!-- {{value}} -->",
  "<!-- {% if x %} --><div>hidden</div><!-- {% endif %} {% if y %} -->other{% endif %}",
  "<!-- {% verbatim %} -->{% endif %}{% endverbatim %}",
])("preserves only the affected range before an unrelated block: %s", async (region) => {
  const source = `${region}\n\n{% if condition%}\n<div>Item</div>\n{% endif %}\n`;
  const formatted = await format(source, options);
  expect(formatted).toContain(region);
  expect(formatted).toContain("{% if condition %}\n  <div>Item</div>\n{% endif %}");
  expect(await format(formatted, options)).toBe(formatted);
});

test("formats around comments inside a containing template block", async () => {
  const comment = "<!-- {% if x%}<b>Hidden</b>{% endif %} -->";
  const source = `{% block content%}\n${comment}\n<div   class = 'a' >{{value}}</div>\n{% endblock%}`;
  const formatted = await format(source, options);
  expect(formatted).toContain(comment);
  expect(formatted).toContain('<div class="a">{{ value }}</div>');
  expect(formatted).toMatch(/^{% block content %}\n/);
  expect(await format(formatted, options)).toBe(formatted);
});

test.each([
  "<!-- {% if x %} --><span>{% endif %}text</span>",
  "<!-- {% if x %} --><pre>{% endif %}  a   {{value}}<!-- {% if x %} --></pre>{% endif %}",
  "{% block content %}<!-- {% if x %} --><span>{% endif %}text</span>{% endblock %}",
])(
  "retains the enclosing source when a comment range hides an HTML boundary: %s",
  async (source) => {
    const formatted = await format(source, options);
    expect(formatted.trimEnd()).toBe(source);
    expect(await format(formatted, options)).toBe(formatted);
  },
);

test("preserves adjacency around an inline HTML comment", async () => {
  const source = "<span>a<!-- {{value}} -->b</span>";
  const formatted = await format(source, options);
  expect(formatted).toBe(`${source}\n`);
  expect(await format(formatted, options)).toBe(formatted);
});

test("formats HTML between separate protected comments", async () => {
  const first = "<!-- {{first}} -->";
  const second = "<!-- {% if x%}hidden{% endif %} -->";
  const source = `${first}\n<div   class = 'a' >{{value}}</div>\n${second}`;
  const formatted = await format(source, options);
  expect(formatted).toContain(first);
  expect(formatted).toContain(second);
  expect(formatted).toContain('<div class="a">{{ value }}</div>');
  expect(await format(formatted, options)).toBe(formatted);
});

test("keeps sibling comment preservation stable at scale", async () => {
  const source = "<!-- {{value}} -->\n<div   class = 'a' >{{value}}</div>\n".repeat(200);
  const formatted = await format(source, options);
  expect(formatted.match(/<!-- {{value}} -->/g)).toHaveLength(200);
  expect(formatted.match(/<div class="a">{{ value }}<\/div>/g)).toHaveLength(200);
  expect(await format(formatted, options)).toBe(formatted);
});

test("formats unrelated blocks after a comment containing Django syntax", async () => {
  const comment = "<!--\n{% if x%}\n<div>Hidden</div>\n{% endif %}\n-->";
  const source = `${comment}\n\n{% if condition%}\n<div>Item</div>\n{% endif %}\n`;
  const expected = `${comment}\n\n{% if condition %}\n  <div>Item</div>\n{% endif %}\n`;
  expect(await format(source, options)).toBe(expected);
  expect(await format(expected, options)).toBe(expected);
});
