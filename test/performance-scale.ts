import { format, type Options } from "prettier";
import { describe, expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";
import { parse } from "../src/parser.js";

const prettierOptions: Options = {
  parser: "django-html",
  plugins: [DjangoPlugin],
};

async function expectIdempotent(source: string): Promise<string> {
  const first = await format(source, prettierOptions);
  expect(await format(first, prettierOptions)).toBe(first);
  return first;
}

describe("generated scale coverage", () => {
  test("protects thousands of expressions while retaining source spans", async () => {
    const count = 2_000;
    const source = Array.from({ length: count }, (_, index) => `{{ value_${index} }}`).join(" ");
    const root = parse(source);
    const expressions = Object.values(root.nodes).filter((node) => node.type === "expression");

    expect(expressions).toHaveLength(count);
    expect(root.html).not.toContain("{{");
    expect(root.html.length).toBeLessThan(source.length * 2);
    expect(expressions[0]).not.toHaveProperty("nodes");
    expect(expressions.at(-1)?.sourceStart).toBe(source.lastIndexOf("{{"));
    expect(source.slice(expressions.at(-1)?.sourceStart, expressions.at(-1)?.sourceEnd)).toBe(
      `{{ value_${count - 1} }}`,
    );
  });

  test("formats dense expressions correctly and idempotently", async () => {
    const count = 1_000;
    const source = `<div>${"<span>{{ value }}</span>".repeat(count)}</div>`;
    const formatted = await expectIdempotent(source);

    expect(formatted.match(/{{ value }}/g)).toHaveLength(count);
    expect(formatted.match(/<span>/g)).toHaveLength(count);
  });

  test("formats more than a thousand constructs in sibling custom blocks", async () => {
    const blockCount = 400;
    const source = Array.from(
      { length: blockCount },
      (_, index) => `{% panel %}<p>{{ value_${index} }}</p>{% endpanel %}`,
    ).join("\n");
    const formatted = await expectIdempotent(source);

    expect(formatted.match(/{% panel %}/g)).toHaveLength(blockCount);
    expect(formatted.match(/{% endpanel %}/g)).toHaveLength(blockCount);
    expect(formatted.match(/{{ value_\d+ }}/g)).toHaveLength(blockCount);
  });

  test("keeps deep and large malformed inputs deterministic", async () => {
    const depth = 80;
    const nested = `${"{% if value %}".repeat(depth)}{{ value }}${"{% endif %}".repeat(depth)}`;
    const nestedRoot = parse(nested);
    expect(
      Object.values(nestedRoot.nodes).filter((node) => node.type === "template-block"),
    ).toHaveLength(depth);

    const malformed = `${"{% if value %}\n".repeat(1_000)}{{ tail }}`;
    const first = parse(malformed);
    const second = parse(malformed);
    expect(first.html).toBe(second.html);
    expect(Object.values(first.nodes).filter((node) => node.type === "template-tag")).toHaveLength(
      1_000,
    );
    expect(first.html).not.toContain("{% if value %}");
  });

  test("formats marker-heavy attribute values idempotently", async () => {
    const count = 500;
    const source = `<div title="${Array.from(
      { length: count },
      (_, index) => `{{ value_${index} }}`,
    ).join(" ")}">content</div>`;
    const formatted = await expectIdempotent(source);
    expect(formatted.match(/{{ value_\d+ }}/g)).toHaveLength(count);
  });
});
