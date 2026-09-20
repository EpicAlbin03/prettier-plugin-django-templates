import { format, formatWithCursor, type Options } from "prettier";
import { describe, expect, test } from "vitest";
import type { DjangoNode, RootNode } from "../src/ast.js";
import * as DjangoPlugin from "../src/index.js";
import { parse } from "../src/parser.js";

const prettierOptions: Options = {
  parser: "django-html",
  plugins: [DjangoPlugin],
};

function nodesOfType<T extends DjangoNode["type"]>(
  root: RootNode,
  type: T,
): Array<Extract<DjangoNode, { type: T }>> {
  return Object.values(root.nodes).filter(
    (node): node is Extract<DjangoNode, { type: T }> => node.type === type,
  );
}

function sourceSlice(source: string, node: DjangoNode): string {
  return source.slice(
    DjangoPlugin.parsers["django-html"].locStart(node),
    DjangoPlugin.parsers["django-html"].locEnd(node),
  );
}

describe("source locations", () => {
  test("direct AST spans remain tied to constructs after differently sized replacements", async () => {
    const source =
      "prefix {{ first_value|default:'a much longer fallback' }} / {# note #} / {% include 'card.html' %} / {{ z }} suffix";
    const root = parse(source);
    const expressions = nodesOfType(root, "expression");
    const comment = nodesOfType(root, "comment")[0];
    const include = nodesOfType(root, "template-tag").find((node) => node.keyword === "include")!;

    expect(sourceSlice(source, root)).toBe(source);
    expect(expressions.map((node) => sourceSlice(source, node))).toEqual([
      "{{ first_value|default:'a much longer fallback' }}",
      "{{ z }}",
    ]);
    expect(sourceSlice(source, comment)).toBe("{# note #}");
    expect(sourceSlice(source, include)).toBe("{% include 'card.html' %}");
    expect(expressions[1].sourceStart).toBe(source.indexOf("{{ z }}"));
    expect(expressions[1]).not.toHaveProperty("index");
    expect(expressions[1]).not.toHaveProperty("protectedBufferStart");
  });

  test("nested blocks span their complete original opening through closing tags", async () => {
    const source =
      "before {% if user %}<div>{% for item in items %}{{ item }}{% endfor %}</div>{% endif %} after";
    const root = parse(source);
    const blocks = nodesOfType(root, "template-block");
    const ifBlock = blocks.find((node) => node.start.keyword === "if")!;
    const forBlock = blocks.find((node) => node.start.keyword === "for")!;

    expect(sourceSlice(source, ifBlock)).toBe(
      "{% if user %}<div>{% for item in items %}{{ item }}{% endfor %}</div>{% endif %}",
    );
    expect(sourceSlice(source, forBlock)).toBe("{% for item in items %}{{ item }}{% endfor %}");
    expect(sourceSlice(source, ifBlock.start)).toBe("{% if user %}");
    expect(sourceSlice(source, ifBlock.end)).toBe("{% endif %}");
  });

  test("uses JavaScript UTF-16 offsets before and inside constructs", async () => {
    const source = "😀 café {{ emoji_😀|default:'雪' }} tail {% include '雪.html' %}";
    const root = parse(source);
    const expression = nodesOfType(root, "expression")[0];
    const include = nodesOfType(root, "template-tag").find((node) => node.keyword === "include")!;

    expect(expression.sourceStart).toBe(source.indexOf("{{"));
    expect(expression.sourceEnd).toBe(source.indexOf("}}") + 2);
    expect(sourceSlice(source, expression)).toBe("{{ emoji_😀|default:'雪' }}");
    expect(include.sourceStart).toBe(source.indexOf("{% include"));
    expect(sourceSlice(source, include)).toBe("{% include '雪.html' %}");
  });

  test("nested unmatched starts retain protected content and original source spans", async () => {
    const source =
      "{% if outer %}\n<div>{{ value }}</div>\n{% for item in items %}\n<span>{{ item }}</span>";
    const root = parse(source);
    const starts = nodesOfType(root, "template-tag").filter(
      (node) => node.keyword === "if" || node.keyword === "for",
    );
    const expressions = nodesOfType(root, "expression");
    const [ifStart, forStart] = starts;

    expect(sourceSlice(source, ifStart)).toBe("{% if outer %}");
    expect(sourceSlice(source, forStart)).toBe("{% for item in items %}");
    expect(expressions.map((node) => sourceSlice(source, node))).toEqual([
      "{{ value }}",
      "{{ item }}",
    ]);
    expect(root.content).toBe(
      `${ifStart.id}\n<div>${expressions[0].id}</div>\n${forStart.id}\n<span>${expressions[1].id}</span>`,
    );
    expect(await format(source, prettierOptions)).toBe(
      "{% if outer %}\n<div>{{ value }}</div>\n{% for item in items %}\n<span>{{ item }}</span>\n",
    );
  });

  test("preserved malformed regions and unmatched raw starts retain sensible spans", async () => {
    const unclosedIgnore = "x <!-- prettier-ignore-start --> <div   class=x>";
    const ignoreRoot = parse(unclosedIgnore);
    const ignore = nodesOfType(ignoreRoot, "ignore-region")[0];
    expect(ignore.sourceEnd).toBe(unclosedIgnore.length);
    expect(sourceSlice(unclosedIgnore, ignore)).toBe(
      "<!-- prettier-ignore-start --> <div   class=x>",
    );

    const unclosedRaw = "lead {% verbatim named %} {{ untouched }}";
    const rawRoot = parse(unclosedRaw);
    const rawBlock = nodesOfType(rawRoot, "raw-block")[0];
    expect(sourceSlice(unclosedRaw, rawBlock)).toBe("{% verbatim named %} {{ untouched }}");
    expect(nodesOfType(rawRoot, "expression")).toHaveLength(0);
  });
});

describe("cursor and range formatting with source spans", () => {
  test.each([
    ["before", 5, 5],
    ["within", 14, 14],
    ["after", 60, 60],
  ])(
    "preserves the exact cursor offset %s template constructs",
    async (_label, cursorOffset, expectedCursorOffset) => {
      const source =
        "<span>{{ first_value_with_a_long_name }}</span> tail {{ x }} <strong>after</strong>";
      const result = await formatWithCursor(source, { ...prettierOptions, cursorOffset });

      expect(result.formatted).toBe(
        "<span>{{ first_value_with_a_long_name }}</span> tail {{ x }}\n<strong>after</strong>\n",
      );
      expect(result.cursorOffset).toBe(expectedCursorOffset);
    },
  );

  test("range formatting preserves a later construct after an earlier replacement", async () => {
    const source =
      '<div><i>{{ first_value_with_a_long_name }}</i></div>\n<section><div   class="card">{{ later }}</div></section>';
    const rangeStart = source.indexOf("<section>");
    const result = await format(source, {
      ...prettierOptions,
      rangeStart,
      rangeEnd: source.length,
    });

    expect(result).toBe(source);
  });

  test("range formatting conservatively preserves an exactly selected nested block", async () => {
    const source =
      "<main>{% if outer %}<div>{% for item in items %}<b>{{ item }}</b>{% endfor %}</div>{% endif %}</main>";
    const rangeStart = source.indexOf("{% for");
    const rangeEnd = source.indexOf("{% endfor %}") + "{% endfor %}".length;
    const result = await format(source, { ...prettierOptions, rangeStart, rangeEnd });

    expect(result).toBe(source);
  });
});
