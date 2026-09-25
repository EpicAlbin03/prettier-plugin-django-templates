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
  ["a newline between an expression and a template comment", "{{ first }}\n{# comment #}\n"],
  ["a newline between a template comment and an expression", "{# comment #}\n{{ first }}\n"],
  ["a blank line before a template comment", "{{ first }}\n\n{# comment #}\n"],
  ["consecutive template comments", "{# first #}\n{# second #}\n"],
  ["an expression followed by a protected HTML comment", "{{ first }}\n<!-- {{value}} -->\n"],
  ["a protected HTML comment followed by an expression", "<!-- {{value}} -->\n{{ first }}\n"],
  ["mixed template and protected HTML comments", "{# comment #}\n<!-- {{value}} -->\n"],
  ["consecutive protected HTML comments", "<!-- {{first}} -->\n<!-- {{second}} -->\n"],
  ["an expression followed by a comment block", "{{ first }}\n{% comment %}body{% endcomment %}\n"],
  ["a comment block followed by an expression", "{% comment %}body{% endcomment %}\n{{ first }}\n"],
  ["a blank line before a protected HTML comment", "{{ first }}\n\n<!-- {{value}} -->\n"],
  ["an expression followed by an HTML comment", "{{ first }}\n<!-- comment -->\n"],
  [
    "comment line breaks inside block HTML",
    "<div>\n  {{ first }}\n  {# comment #}\n  <!-- {{value}} -->\n</div>\n",
  ],
  [
    "comment line breaks inside a template block",
    "{% block content %}\n  {{ first }}\n  {# comment #}\n{% endblock %}\n",
  ],
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
  ["same-line template comments", "{{first}} {#comment#}", "{{ first }} {# comment #}\n"],
  ["adjacent template comments", "{{first}}{#comment#}", "{{ first }}{# comment #}\n"],
  [
    "comments in inline HTML",
    "<span>{{first}}\n{#comment#}</span>",
    "<span>{{ first }} {# comment #}</span>\n",
  ],
  [
    "comments in attribute values",
    '<div title="{{first}}\n{#comment#}"></div>',
    '<div\n  title="{{ first }}\n{# comment #}"\n></div>\n',
  ],
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

test.each([8, 40, 80])("comment line breaks stay stable at print width %s", async (printWidth) => {
  const source = "{{ first }}\n{# comment #}\n<!-- {{value}} -->\n{{ second }}\n";
  const options = { parser: "django-html", plugins: [DjangoPlugin], printWidth };
  const output = await format(source, options);
  expect(output).toBe(source);
  await expect(format(output, options)).resolves.toBe(source);
});

test("comment line breaks respect the configured line endings", async () => {
  const source = "{{ first }}\n{# comment #}\n<!-- {{value}} -->\n";
  const expected = source.replace(/\n/g, "\r\n");
  const options = {
    parser: "django-html",
    plugins: [DjangoPlugin],
    endOfLine: "crlf" as const,
  };
  const output = await format(source, options);
  expect(output).toBe(expected);
  await expect(format(output, options)).resolves.toBe(expected);
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
