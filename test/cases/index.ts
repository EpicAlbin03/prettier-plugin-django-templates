import { existsSync, readdirSync, readFileSync } from "fs";
import { format, type Options } from "prettier";
import { test } from "vitest";
import * as DjangoPlugin from "../../src/index.js";

const prettify = (code: string, options: Options) =>
  format(code, {
    parser: "django-html",
    plugins: [DjangoPlugin],
    ...options,
  });

const casesDir = "test/cases/data";
const cases = readdirSync(casesDir, { withFileTypes: true });

for (const entry of cases) {
  if (!entry.isDirectory() || entry.name.startsWith("_")) {
    continue;
  }

  const caseName = entry.name;
  const base = `${casesDir}/${caseName}`;
  if (readdirSync(base).length === 0) {
    continue;
  }

  test.concurrent(`cases: ${caseName}`, async ({ expect }) => {
    const input = readFileSync(`${base}/input.html`, "utf-8").replace(/\r?\n/g, "\n");
    const expected = readFileSync(`${base}/expected.html`, "utf-8").replace(/\r?\n/g, "\n");
    const configPath = `${base}/config.json`;
    const options = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf-8")) : {};

    const expectedError = expected.match(/Error\(`(?<message>[\s\S]*)`\)/)?.groups?.message;

    if (expectedError) {
      await expect(() => prettify(input, options)).rejects.toThrow(expectedError);
      return;
    }

    const actual = await prettify(input, options);
    expect(actual, `Expected:\n${expected}\n\nActual:\n${actual}`).toBe(expected);

    const actual2 = await prettify(actual, options);
    expect(actual2, `Reprint failed. Expected:\n${expected}\n\nActual:\n${actual2}`).toBe(expected);
  });
}
