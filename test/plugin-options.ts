import { format, getFileInfo, getSupportInfo, type Options } from "prettier";
import { describe, expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const options: Options = { parser: "django-html", plugins: [DjangoPlugin] };

describe("plugin registration", () => {
  test("selects the Django HTML parser from a filepath without an explicit parser", async () => {
    const inferredOptions = { plugins: [DjangoPlugin], filepath: "templates/card.html" };
    const source = "<div>{{name}}</div>";
    const expected = "<div>{{ name }}</div>\n";
    expect(await format(source, inferredOptions)).toBe(expected);
    expect(await format(expected, inferredOptions)).toBe(expected);
    expect(
      await getFileInfo("templates/card.html", { plugins: [DjangoPlugin], resolveConfig: false }),
    ).toEqual({
      ignored: false,
      inferredParser: "django-html",
    });
  });

  test("advertises Django HTML support through Prettier", async () => {
    const support = await getSupportInfo({ plugins: [DjangoPlugin] });
    expect(support.languages.find((language) => language.name === "HTML+Django")).toMatchObject({
      parsers: ["django-html"],
      extensions: [".html"],
      vscodeLanguageIds: ["html"],
    });
  });
});

test.each<[string, Options, string]>([
  [
    "four-space indentation",
    { tabWidth: 4 },
    "{% if enabled %}\n    <div>{{ value }}</div>\n{% endif %}\n",
  ],
  [
    "tab indentation",
    { useTabs: true },
    "{% if enabled %}\n\t<div>{{ value }}</div>\n{% endif %}\n",
  ],
  [
    "CRLF output",
    { endOfLine: "crlf" },
    "{% if enabled %}\r\n  <div>{{ value }}</div>\r\n{% endif %}\r\n",
  ],
  ["CR output", { endOfLine: "cr" }, "{% if enabled %}\r  <div>{{ value }}</div>\r{% endif %}\r"],
])("respects %s when formatting template blocks", async (_name, overrides, expected) => {
  const source = "{%if enabled%}<div>{{value}}</div>{%endif%}";
  const resolvedOptions = { ...options, ...overrides };
  expect(await format(source, resolvedOptions)).toBe(expected);
  expect(await format(expected, resolvedOptions)).toBe(expected);
});

test("disabling embedded formatting conservatively preserves the complete source", async () => {
  const source = '<div   class="card">{{value}}</div>';
  expect(await format(source, { ...options, embeddedLanguageFormatting: "off" })).toBe(source);
});

test("formats both JavaScript and CSS embedded in a Django HTML template", async () => {
  const source =
    "<script>const value={a:1};</script><style>.card{color:red}</style><div>{{value}}</div>";
  const expected =
    "<script>\n  const value = { a: 1 };\n</script>\n<style>\n  .card {\n    color: red;\n  }\n</style>\n<div>{{ value }}</div>\n";
  expect(await format(source, options)).toBe(expected);
  expect(await format(expected, options)).toBe(expected);
});
