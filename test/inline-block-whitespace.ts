import { format } from "prettier";
import { expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const options = { parser: "django-html", plugins: [DjangoPlugin] };

const formatTemplate = (source: string) => format(source, options);

test.each([
  "a{% if x %}b{% endif %}c",
  "<div>a{% if x %}b{% endif %}c</div>",
  "<div>{% for x in xs %}{{ x }},{% endfor %}</div>",
])("does not introduce spaces into rendered block text: %s", async (source) => {
  await expect(formatTemplate(source)).resolves.toBe(`${source}\n`);
});

test("whitespace-only blocks retain their literal body", async () => {
  const source = "<div>one{% if x %} {% endif %}two</div>";
  // With x=true this must still render 'one two', not 'onetwo'.
  await expect(formatTemplate(source)).resolves.toBe(`${source}\n`);
});

test.each(["{{ value }}", "{# hidden #}"])(
  "multiple HTML attributes preserve adjacency around %s",
  async (body) => {
    const source = `<span class="a" title="b">${body}</span>`;
    await expect(formatTemplate(source)).resolves.toBe(`${source}\n`);
  },
);

test.each([
  "<span>a{% if x %}b{% endif %}</span>",
  "<span>{% if x %}a{% else %}b{% endif %}</span>",
  '<span data-label="<div>">{% if x %}a{% else %}b{% endif %}</span>',
  '<span data-label="<div>">a{% if x %}b{% endif %}</span>',
  "<span>a{% for x in xs %}{{ x }}{% endfor %}b</span>",
  "<span>a{% if x %}{% if y %}b{% endif %}{% endif %}c</span>",
  "<span>a{% if x %}\n  b\n{% endif %}c</span>",
  "<span>\n  {% if x %}a\n  {% else %}\n    b\n  {% endif %}\n</span>",
  "<span>\n  {% if x %}\n    a{% else %}b\n  {% endif %}\n</span>",
])("preserves rendered inline block whitespace: %s", async (source) => {
  const formatted = await format(source, options);
  expect(formatted).toBe(`${source}\n`);
  expect(await format(formatted, options)).toBe(formatted);
});

test("preserves a block whose closing delimiter touches inline text", async () => {
  const block = "{% if x %}\n    a\n  {% endif %}";
  const formatted = await format(`<span>\n  ${block}b\n</span>`, options);
  expect(formatted).toContain(`${block}b`);
  expect(await format(formatted, options)).toBe(formatted);
});

test.each([
  [
    "branches",
    "{% if x %}\n        <b>yes</b>\n{% elif y %}\n <i>maybe</i>\n{% else %}\n      <em>no</em>\n{% endif %}",
    "  {% if x %}\n    <b>yes</b>\n  {% elif y %}\n    <i>maybe</i>\n  {% else %}\n    <em>no</em>\n  {% endif %}",
  ],
  [
    "nested blocks",
    "{% if x %}\n{% for y in ys %}\n        <span>{{ y }}</span>\n{% empty %}\n <b>empty</b>\n{% endfor %}\n{% endif %}",
    "  {% if x %}\n    {% for y in ys %}\n      <span>{{ y }}</span>\n    {% empty %}\n      <b>empty</b>\n    {% endfor %}\n  {% endif %}",
  ],
])("indents %s inside inline HTML", async (_name, input, expected) => {
  const formatted = await format(`<button>\n${input}\n</button>`, options);
  expect(formatted).toBe(`<button>\n${expected}\n</button>\n`);
  expect(await format(formatted, options)).toBe(formatted);
});

test.each(["button", "span"])(
  "indents standalone block delimiters inside <%s>",
  async (element) => {
    const source = `<${element}>\n  {% if x %}\n      <span>yes</span>\n  {% endif %}\n</${element}>`;
    const expected = `<${element}>\n  {% if x %}\n    <span>yes</span>\n  {% endif %}\n</${element}>\n`;
    const formatted = await format(source, options);
    expect(formatted).toBe(expected);
    expect(await format(formatted, options)).toBe(formatted);
  },
);
