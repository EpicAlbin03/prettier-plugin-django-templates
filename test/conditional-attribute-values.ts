import { format } from "prettier";
import { describe, expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const options = { parser: "django-html", plugins: [DjangoPlugin] };

const formatTemplate = (source: string) => format(source, options);

describe("unquoted attribute values", () => {
  test.each([
    ["expression", "{{value}}", "{{ value }}"],
    ["interpolated text", "pre{{value}}post", "pre{{ value }}post"],
    [
      "conditional value",
      "{% if x %}yes{% else %}no{% endif %}",
      "{% if x %}yes{% else %}no{% endif %}",
    ],
  ])("retains the %s instead of leaking attribute markers", async (_name, value, expected) => {
    await expect(formatTemplate(`<div data-x=${value}></div>`)).resolves.toBe(
      `<div data-x="${expected}"></div>\n`,
    );
  });
});

test.each(['"', "'"])("retains block body whitespace inside %s attribute values", async (quote) => {
  for (const body of [
    "first  command\n\tsecond command\n\n  end ",
    "\n  {{ first }}\n    {{ second }}\n",
    "<b   class=literal>text  with  spaces</b>\n  tail",
  ]) {
    const value = `{% if enabled %}${body}{% else %}fallback\n  text{% endif %}`;
    const source = `<div data-code=${quote}${value}${quote}>{{body}}</div>`;
    const formatted = await format(source, options);
    expect(formatted).toContain(value);
    expect(formatted).toContain("{{ body }}");
    expect(await format(formatted, options)).toBe(formatted);
  }
});

test("attribute blocks retain stronger raw and translation body protection", async () => {
  const source = `<div data-code="{%if enabled%}{% verbatim %}{{untouched}}\n  {%if raw%}{% endverbatim %}{% blocktranslate %}hello  {{name}}\n  world{% endblocktranslate %}{%endif%}"></div>`;
  const formatted = await format(source, options);
  expect(formatted).toContain(
    "{% if enabled %}{% verbatim %}{{untouched}}\n  {%if raw%}{% endverbatim %}{% blocktranslate %}hello  {{name}}\n  world{% endblocktranslate %}{% endif %}",
  );
  expect(await format(formatted, options)).toBe(formatted);
});

test.each(['"', "'"])(
  "retains literal whitespace inside %s conditional attributes",
  async (quote) => {
    for (const value of ["a\n  b", "a \n\t b", "a\n\n    b", "a\n  {{ value }}\n b"]) {
      const attribute = `data-x=${quote}${value}${quote}`;
      const source = `<div {% if x %}${attribute}{% endif %}>x</div>`;
      const formatted = await format(source, options);
      expect(formatted).toContain(attribute);
      expect(await format(formatted, options)).toBe(formatted);
    }
  },
);
