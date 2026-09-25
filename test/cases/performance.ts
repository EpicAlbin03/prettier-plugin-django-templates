import { readdirSync, readFileSync } from "node:fs";
import { format } from "prettier";
import { expect, test } from "vitest";
import * as plugin from "../../src/index.js";

const directory = new URL("./performance/", import.meta.url);
const names = readdirSync(directory)
  .filter((name) => name.endsWith(".html"))
  .sort();

test("benchmark corpus covers at least eight representative templates", () => {
  expect(names.length).toBeGreaterThanOrEqual(8);
});

for (const name of names) {
  test(`benchmark corpus ${name} formats idempotently`, async () => {
    const source = readFileSync(new URL(name, directory), "utf8");
    const options = { parser: "django-html", plugins: [plugin] };
    const formatted = await format(source, options);
    expect(formatted.trim()).not.toBe("");
    expect(await format(formatted, options)).toBe(formatted);
  });
}
