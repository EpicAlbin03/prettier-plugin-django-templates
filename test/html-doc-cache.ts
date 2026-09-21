import { doc, format, type Doc, type Options, type Plugin, type Printer } from "prettier";
import { expect, test } from "vitest";
import type { DjangoNode } from "../src/ast.js";
import { HtmlDocCache } from "../src/html-doc-cache.js";
import { analyzeDocument } from "../src/formatting-plan.js";
import * as plugin from "../src/index.js";
import { parse } from "../src/parser.js";

const { builders } = doc;

function expressionIds(source = "{{ a }}{{ b }}{{ c }}") {
  const root = parse(source);
  return { root, ids: Object.keys(root.nodes) };
}

test("reuses equal-width HTML projections but isolates markers and group decisions", async () => {
  const { root, ids } = expressionIds();
  const cache = new HtmlDocCache(root.nodes);
  const groupId = Symbol("layout");
  const calls: string[] = [];
  const textToDoc = async (text: string): Promise<Doc> => {
    calls.push(text);
    return builders.group(
      [
        text,
        builders.ifBreak("broken", "flat", { groupId }),
        builders.indentIfBreak("indented", { groupId }),
      ],
      { id: groupId },
    );
  };
  const first = await cache.format(`<p>${ids[0]}</p>`, textToDoc, "css");
  const second = await cache.format(`<p>${ids[1]}</p>`, textToDoc, "css");
  const third = await cache.format(`<p>${ids[2]}</p>`, textToDoc, "css");
  expect(calls).toEqual([`<p>${ids[0]}</p>`]);
  // Doc is a documented string/array/command union.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof second !== "object" || Array.isArray(second) || second.type !== "group") {
    throw new Error("Expected a group Doc");
  }
  expect(second.id).not.toBe(groupId);
  expect(second).toMatchObject({
    contents: [
      `<p>${ids[1]}</p>`,
      { type: "if-break", groupId: second.id },
      { type: "indent-if-break", groupId: second.id },
    ],
  });
  expect(first).toMatchObject({ id: groupId, contents: [calls[0], { groupId }, { groupId }] });
  expect(third).not.toMatchObject({ id: second.id });
});

test("cache keys retain marker widths, aliasing, literal text, and sensitivity", async () => {
  const { root, ids } = expressionIds("{{ x }}".repeat(12));
  const cache = new HtmlDocCache(root.nodes);
  const calls: string[] = [];
  const textToDoc = async (text: string): Promise<Doc> => {
    calls.push(text);
    return text;
  };
  const inputs = [
    `<p>${ids[0]} ${ids[0]}</p>`,
    `<p>${ids[1]} ${ids[2]}</p>`,
    `<p>${ids[10]} ${ids[11]}</p>`,
    `<p>literal ${ids[1]} ${ids[2]}</p>`,
  ];
  for (const input of inputs) expect(await cache.format(input, textToDoc, "css")).toBe(input);
  expect(await cache.format(inputs[0], textToDoc, "strict")).toBe(inputs[0]);
  expect(calls).toHaveLength(5);
  const reused = `<p>${ids[2]} ${ids[2]}</p>`;
  expect(await cache.format(reused, textToDoc, "css")).toBe(reused);
  expect(calls).toHaveLength(5);
});

test("leaves embedded content and attribute constructs uncached", async () => {
  const root = parse('<div title="{{ a }}" {{ b }}>{{ c }}</div>');
  const ids = Object.keys(root.nodes);
  const cache = new HtmlDocCache(root.nodes);
  let calls = 0;
  const textToDoc = async (text: string): Promise<Doc> => {
    calls += 1;
    return text;
  };
  const inputs = [
    `<div title="${ids[0]}">text</div>`,
    `<div ${ids[1]}>text</div>`,
    ...["script", "style", "pre", "textarea", "title", "template"].map(
      (tag) => `<${tag}>${ids[2]}</${tag}>`,
    ),
  ];
  for (const input of inputs) {
    await cache.format(input, textToDoc, "css");
    await cache.format(input, textToDoc, "css");
  }
  expect(calls).toBe(inputs.length * 2);
});

function observingPlugin(calls: string[]): Plugin<DjangoNode> {
  const base = plugin.printers["django-html"];
  const embed: Printer<DjangoNode>["embed"] = (path, options) => {
    const callback = base.embed!(path, options);
    // Prettier's embed contract allows a callback or an immediate Doc.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    if (typeof callback !== "function") return callback;
    return (textToDoc, print, embedPath, embedOptions) =>
      callback(
        (text, nextOptions) => {
          calls.push(text);
          return textToDoc(text, nextOptions);
        },
        print,
        embedPath,
        embedOptions,
      );
  };
  return { ...plugin, printers: { "django-html": { ...base, embed } } };
}

test.each<Options>([
  {},
  { printWidth: 30, tabWidth: 4, singleQuote: true },
  { printWidth: 50, useTabs: true, htmlWhitespaceSensitivity: "strict" },
  { htmlWhitespaceSensitivity: "ignore", singleAttributePerLine: true, endOfLine: "crlf" },
])("repeated blocks retain distinct values and options: %j", async (settings) => {
  const blocks = Array.from(
    { length: 40 },
    (_, index) =>
      `{% panel %}<p class="long-class-name" data-x="another-value">{{ value_${index} }}</p>{% endpanel %}`,
  );
  const calls: string[] = [];
  const observed = observingPlugin(calls);
  const options: Options = { ...settings, parser: "django-html", plugins: [observed] };
  const formatted = await format(blocks.join("\n"), options);
  expect(calls.length).toBeLessThan(10);
  const expected = [];
  for (const block of blocks) expected.push(await format(block, options));
  expect(formatted).toBe(expected.join(""));
  expect(await format(formatted, options)).toBe(formatted);
});

test("block sequence planning leaves same-line and blank-line gaps on the HTML path", () => {
  const block = "{% panel %}<p>{{ value }}</p>{% endpanel %}";
  for (const gap of ["", " ", "\n\n", "\ntext\n"]) {
    const plan = analyzeDocument(parse(block + gap + block));
    expect(plan.containers.get("root")?.blockSequence).toBeUndefined();
  }
  const plan = analyzeDocument(parse(block + "\r\n  " + block));
  expect(plan.containers.get("root")?.blockSequence).toHaveLength(2);
});

test("concurrent formatting calls do not reuse another document's Docs or options", async () => {
  const source = (value: string) =>
    `{% panel %}<p class="long-class-name">{{ ${value} }}</p>{% endpanel %}\n`.repeat(20);
  const results = await Promise.all(
    [25, 80, 120].map((printWidth) =>
      format(source(`value_${printWidth}`), {
        parser: "django-html",
        plugins: [plugin],
        printWidth,
      }),
    ),
  );
  for (const [index, printWidth] of [25, 80, 120].entries()) {
    expect(results[index]).toBe(
      await format(source(`value_${printWidth}`), {
        parser: "django-html",
        plugins: [plugin],
        printWidth,
      }),
    );
  }
});
