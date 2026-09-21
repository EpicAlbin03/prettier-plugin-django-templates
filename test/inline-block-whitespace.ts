import { format } from "prettier";
import { expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const options = { parser: "django-html", plugins: [DjangoPlugin] };

test.each([
  "<span>a{% if x %}b{% endif %}</span>",
  "<span>{% if x %}a{% else %}b{% endif %}</span>",
  '<span data-label="<div>">{% if x %}a{% else %}b{% endif %}</span>',
  '<span data-label="<div>">a{% if x %}b{% endif %}</span>',
  "<span>a{% for x in xs %}{{ x }}{% endfor %}b</span>",
  "<span>a{% if x %}{% if y %}b{% endif %}{% endif %}c</span>",
])("preserves rendered inline block whitespace: %s", async (source) => {
  const formatted = await format(source, options);
  expect(formatted).toBe(`${source}\n`);
  expect(await format(formatted, options)).toBe(formatted);
});
