import { format } from "prettier";
import { expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const formatTemplate = (source: string) =>
  format(source, { parser: "django-html", plugins: [DjangoPlugin] });

test("preserves a conditional attribute adjacent to the element name", async () => {
  const output = await formatTemplate("<input{% if x %} disabled{% endif %}>");
  expect(output).toContain("{% if x %}");
  expect(output).toContain("disabled");
  expect(output).toContain("{% endif %}");
  expect(output).not.toMatch(/dj\d+/);
  expect(await formatTemplate(output)).toBe(output);
});

test("formats an empty template block inside an HTML start tag", async () => {
  const source = "<input {%if enabled%}{%endif%}>";
  const expected = "<input {% if enabled %}{% endif %} />\n";
  expect(await formatTemplate(source)).toBe(expected);
  expect(await formatTemplate(expected)).toBe(expected);
});

test("formats standalone expressions and branches in multiline start-tag blocks", async () => {
  const source =
    '<div\n{% if enabled %}\n{{attrs}}\nclass="{{name}}"\n{% else %}\n{{defaults}}\n{% endif %}\n></div>';
  const expected =
    '<div\n  {% if enabled %}\n    {{ attrs }}\n    class="{{ name }}"\n  {% else %}\n    {{ defaults }}\n  {% endif %}\n></div>\n';
  expect(await formatTemplate(source)).toBe(expected);
  expect(await formatTemplate(expected)).toBe(expected);
});
