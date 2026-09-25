import { format } from "prettier";
import { describe, expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const prettify = (code: string) =>
  format(code, {
    parser: "django-html",
    plugins: [DjangoPlugin],
  });

const cases = [
  ["consecutive expressions at the document root", "{{ first }}\n{{ second }}\n"],
  [
    "expression line groups and blank lines at the document root",
    "{{ first }}{{ second }}\n{{ third }} {{ fourth }}\n\n{{ fifth }}\n",
  ],
  [
    "a blank line between an include and an expression",
    "{% block test %}\n  {% include 'path' %}\n\n  {{ card }}\n{% endblock test %}\n",
  ],
  [
    "a newline between an expression and an include",
    "{% block test %}\n  {{ card }}\n  {% include 'path' %}\n{% endblock test %}\n",
  ],
  [
    "a newline between a template block and an expression",
    "{% if text %}\n  <p>{{ text }}</p>\n{% endif %}\n{{ card }}\n",
  ],
  [
    "a blank line between a nested template block and an expression",
    "{% block test %}\n  {% if text %}\n    <p>{{ text }}</p>\n  {% endif %}\n\n  {{ card }}\n{% endblock test %}\n",
  ],
  ["a blank line between HTML and an expression", "<p>{{ text }}</p>\n\n{{ card }}\n"],
  ["a blank line between an HTML comment and an expression", "<!-- card -->\n\n{{ card }}\n"],
];

describe.each([
  ["LF", "\n"],
  ["CRLF", "\r\n"],
])("expression spacing with %s input", (_name, newline) => {
  test.each(cases)("preserves %s", async (_description, expected) => {
    const output = await prettify(expected.replace(/\n/g, newline));
    expect(output).toBe(expected);
    await expect(prettify(output)).resolves.toBe(expected);
  });
});

test.each([
  ["same-line expressions", "{{first}} {{second}}", "{{ first }} {{ second }}\n"],
  ["adjacent expressions", "{{first}}{{second}}", "{{ first }}{{ second }}\n"],
  ["same-line spacing", "\n{{first}}    {{second}}\n\n", "{{ first }}    {{ second }}\n"],
  ["a single expression", "\n{{first}}\n\n", "{{ first }}\n"],
  [
    "inline HTML content",
    "<p>Hello {{name}} {{surname}}!</p>",
    "<p>Hello {{ name }} {{ surname }}!</p>\n",
  ],
  [
    "multiline prose containing expressions",
    "Hello {{name}}\nand {{friend}}!\n",
    "Hello {{ name }} and {{ friend }}!\n",
  ],
])("preserves ordinary HTML formatting for %s", async (_description, source, expected) => {
  const output = await prettify(source);
  expect(output).toBe(expected);
  await expect(prettify(output)).resolves.toBe(expected);
});

test("same-line expressions stay together even at narrow print widths", async () => {
  const source = "{{ a }} {{ b }}\n";
  const expected = "{{ a }} {{ b }}\n";
  const options = { parser: "django-html", plugins: [DjangoPlugin], printWidth: 8 };
  const output = await format(source, options);
  expect(output).toBe(expected);
  await expect(format(output, options)).resolves.toBe(expected);
});

test("expression-only document lines respect the configured line endings", async () => {
  const source = "{{first}}\n{{second}}\n";
  const expected = "{{ first }}\r\n{{ second }}\r\n";
  const options = {
    parser: "django-html",
    plugins: [DjangoPlugin],
    endOfLine: "crlf" as const,
  };
  const output = await format(source, options);
  expect(output).toBe(expected);
  await expect(format(output, options)).resolves.toBe(expected);
});
