import { format } from "prettier";
import { describe, expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const prettify = (code: string) =>
  format(code, {
    parser: "django-html",
    plugins: [DjangoPlugin],
  });

const cases = [
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
