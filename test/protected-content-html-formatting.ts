import { format } from "prettier";
import { expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const options = { parser: "django-html", plugins: [DjangoPlugin] };

test("formats ordinary HTML around a protected expression", async () => {
  const source = '<div   class = "a" >{{ x }}</div>';
  const formatted = await format(source, options);
  expect(formatted).toBe('<div class="a">{{ x }}</div>\n');
  expect(await format(formatted, options)).toBe(formatted);
});

test.each([
  "<span   a = \"a\" b='b'>{% custom_asset %}</span>",
  "<span   a = \"a\" b='b'>a{% if x %}b{% else %}c{% endif %}d</span>",
  "<div>{{ before }}{% if x %}<div   a = \"a\" b='b'>{{ inside }}</div>{% endif %}</div>",
])("formats surrounding HTML while keeping protected content stable: %s", async (source) => {
  const perLineOptions = { ...options, singleAttributePerLine: true };
  const formatted = await format(source, perLineOptions);
  expect(formatted).toMatch(/a="a"\n\s+b="b"/);
  expect(await format(formatted, perLineOptions)).toBe(formatted);
});

test.each(["'", '"'])(
  "honors singleAttributePerLine with %s attributes on the first pass",
  async (quote) => {
    const source = `<div a=${quote}a${quote} b=${quote}b${quote}>{{ x }}</div>`;
    const perLineOptions = { ...options, singleAttributePerLine: true };
    const formatted = await format(source, perLineOptions);
    expect(formatted).toBe('<div\n  a="a"\n  b="b"\n>\n  {{ x }}\n</div>\n');
    expect(await format(formatted, perLineOptions)).toBe(formatted);
  },
);
