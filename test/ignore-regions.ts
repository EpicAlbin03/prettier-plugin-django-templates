import { format } from "prettier";
import { describe, expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const prettify = (code: string) =>
  format(code, {
    parser: "django-html",
    plugins: [DjangoPlugin],
  });

describe("attribute ignore directives", () => {
  test.each([
    ["<!-- prettier-ignore-attribute data-x -->", true],
    ["<!--\n prettier-ignore-attribute\n data-x title \n-->", true],
    ["<!-- prettier-ignore-attribute -->", true],
    ["<!-- prettier-ignore-attribute DATA-X -->", false],
    ["<!-- prettier-ignore-attribute data-other -->", false],
    ["<!-- prettier-ignore-attribute data-x -->text", false],
    ["<!-- prettier-ignore-attribute data-x --><!-- another comment -->", false],
    ["<!-- prettier-ignore-attribute data-x -->{{between}}", false],
    ["<!-- prettier-ignore-attributes data-x -->", false],
  ])("matches Prettier directive semantics: %s", async (prefix, ignored) => {
    const source = `${prefix}\n<div data-x="{{value}}" title="{{title}}">{{body}}</div>`;
    const output = await prettify(source);
    expect(output).toContain(ignored ? 'data-x="{{value}}"' : 'data-x="{{ value }}"');
    expect(output).toContain("{{ body }}");
    expect(await prettify(output)).toBe(output);
  });
});

describe("unterminated ignore regions at EOF", () => {
  test.each([
    [
      "HTML comment delimiter",
      "<p>Before</p>\n<!-- prettier-ignore-start -->\n{% alpha %}{% beta %}\n{{x}}{% if y %}",
    ],
    [
      "Django comment delimiter",
      "<p>Before</p>\n{# prettier-ignore-start #}\n{% alpha %}{% beta %}\n{{x}}{% if y %}",
    ],
  ])("preserves no final newline for the %s", async (_name, input) => {
    const output = await prettify(input);
    expect(output).toBe(input);
    await expect(prettify(output)).resolves.toBe(input);
  });
});
