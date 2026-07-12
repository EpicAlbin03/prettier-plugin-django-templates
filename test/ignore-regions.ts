import { format } from "prettier";
import { describe, expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const prettify = (code: string) =>
  format(code, {
    parser: "django-html",
    plugins: [DjangoPlugin],
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
