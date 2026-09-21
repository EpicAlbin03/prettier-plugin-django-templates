import { doc, format, type Doc, type Options, type Plugin, type Printer } from "prettier";
import { describe, expect, test } from "vitest";
import type { DjangoNode, RootNode } from "../src/ast.js";
import { analyzeDocument, getDocumentPlan } from "../src/formatting-plan.js";
import { scanHtmlHostContexts } from "../src/html-host-context.js";
import * as plugin from "../src/index.js";
import { parse } from "../src/parser.js";

const options: Options = { parser: "django-html", plugins: [plugin] };

function astSnapshot(root: RootNode): string {
  return JSON.stringify([root, ...Object.values(root.nodes)], (key, value) =>
    key === "nodes" ? Object.keys(root.nodes) : value,
  );
}

function plannedSnapshot(root: RootNode): string {
  const plan = analyzeDocument(root);
  return JSON.stringify({
    containers: [...plan.containers].map(([id, layout]) => ({
      id,
      html: layout.node.html,
      body: layout.body,
      segments: layout.preparedSegments,
      boundaries: layout.boundaries,
      markers: [...layout.markerContexts],
      preserved: layout.preserved,
    })),
    preserved: [...plan.preserved],
  });
}

function observingPlugin(root: RootNode, reverse: boolean, rootDocs: Doc[]): Plugin<DjangoNode> {
  const base = plugin.printers["django-html"];
  const embed: Printer<DjangoNode>["embed"] = (path, options) => {
    const callback = base.embed!(path, options);
    // Prettier's embed contract allows either a callback or an immediate Doc.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    if (typeof callback !== "function") return callback;
    return async (...args) => {
      const result = await callback(...args);
      if (args[2].node.type === "root" && result !== undefined) rootDocs.push(result);
      return result;
    };
  };
  return {
    ...plugin,
    parsers: { "django-html": { ...plugin.parsers["django-html"], parse: () => root } },
    printers: {
      "django-html": {
        ...base,
        embed,
        getVisitorKeys(node, excluded) {
          const keys = base.getVisitorKeys!(node, excluded);
          return reverse ? [...keys].reverse() : keys;
        },
      },
    },
  };
}

describe("immutable source and document analysis", () => {
  test("source text always agrees with UTF-16 spans, independently of normalized spelling", () => {
    const source = '😀 {%  if   x %}{{value}}{#note#}{% include  "card.html" %}{%endif%}';
    const root = parse(source);
    for (const node of [root, ...Object.values(root.nodes)]) {
      expect(node.sourceText).toBe(source.slice(node.sourceStart, node.sourceEnd));
      expect(Object.isFrozen(node)).toBe(true);
    }
    expect(Object.isFrozen(root.nodes)).toBe(true);
    const block = Object.values(root.nodes).find((node) => node.type === "template-block")!;
    expect(Object.isFrozen(block.childIds)).toBe(true);
    expect(block.start.content).toBe("if x");
    expect(block.start.sourceText).toBe("{%  if   x %}");
    expect(block.html).not.toContain("{{value}}");
  });

  test.each([
    "{% if wrap %}<pre>{% endif %}  {{value}}\n{% if wrap %}</pre>{% endif %}<div>{{tail}}</div>",
    '<span data-label="<div>">a{%if x%}{{value}}{%else%}b{%endif%}</span>',
    '<!-- prettier-ignore -->{%if x%}<div   class="x">{{value}}</div>{%endif%}<p>{{tail}}</p>',
    '<!-- prettier-ignore --><section>{%if x%}<div   class="x">{{value}}</div>{%endif%}</section><p>{{tail}}</p>',
    "{% blocktranslate %}Hello {% if x %}<b>{{value}}</b>{% endif %}{% endblocktranslate %}",
    "{% if x %}<div>{% else %}</div>{% endif %}<span>{{tail}}</span>",
  ])(
    "analysis and embedding do not mutate the AST or depend on visit order: %s",
    async (source) => {
      const root = parse(source);
      const before = astSnapshot(root);
      const planned = plannedSnapshot(root);
      const docs: Doc[] = [];
      const first = await format(source, {
        ...options,
        plugins: [observingPlugin(root, false, docs)],
      });
      const capturedPlan = getDocumentPlan(root);
      const reverse = await format(source, {
        ...options,
        plugins: [observingPlugin(root, true, docs)],
      });
      expect(reverse).toBe(first);
      expect(await format(first, options)).toBe(first);
      expect(astSnapshot(root)).toBe(before);
      expect(plannedSnapshot(root)).toBe(planned);
      expect(capturedPlan.containers.size).toBe(getDocumentPlan(root).containers.size);
      expect(docs).toHaveLength(2);
    },
  );

  test("conditional preservation is an explicit plan-owned span, not a synthetic AST child", () => {
    const source =
      "{% if wrap %}<pre>{% endif %}  {{value}}\n{% if wrap %}</pre>{% endif %}<div>{{tail}}</div>";
    const root = parse(source);
    const before = Object.keys(root.nodes);
    const plan = analyzeDocument(root);
    const spans = [...plan.preserved].filter(([id]) => !root.nodes[id]);
    expect(spans).toHaveLength(1);
    const [id, span] = spans[0];
    expect(span.reason).toBe("conditional-html");
    expect(span.text).toBe(source.slice(span.sourceStart, span.sourceEnd));
    expect(plan.containers.get("root")!.node.html).toContain(id);
    expect(root.html).not.toContain(id);
    expect(Object.keys(root.nodes)).toEqual(before);
  });
});

test("the root remains a composed Doc until Prettier chooses layout", async () => {
  const source =
    '{% if x %}<div class="long-class-name" data-label="another-long-value">{{value}}</div>{% endif %}';
  const root = parse(source);
  const docs: Doc[] = [];
  const observed = observingPlugin(root, false, docs);
  const wide = await format(source, { ...options, plugins: [observed], printWidth: 120 });
  const narrow = await format(source, {
    ...options,
    plugins: [observed],
    printWidth: 35,
    useTabs: true,
  });
  expect(wide).toContain('<div class="long-class-name" data-label="another-long-value">');
  expect(narrow).toContain('\n\t<div\n\t\tclass="long-class-name"');
  expect(await format(narrow, { ...options, printWidth: 35, useTabs: true })).toBe(narrow);
  for (const result of docs) {
    expect(result).not.toBeTypeOf("string");
    const groups: Doc[] = [];
    doc.utils.traverseDoc(result, (part) => {
      // A Doc's object members carry layout commands; strings and arrays do not.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof
      if (typeof part === "object" && !Array.isArray(part) && part.type === "group")
        groups.push(part);
    });
    expect(groups.length).toBeGreaterThan(0);
  }
});

test.each([
  '<span data-label="<div>">a{% if x %}b{% endif %}</span>',
  "<span data-label='<div title=\"x > y\">'>a{% if x %}b{% else %}c{% endif %}</span>",
  "<span><!-- <div> -->a{% if x %}b{% endif %}</span>",
])("one quote-aware scanner drives context and preservation: %s", async (source) => {
  const html = scanHtmlHostContexts(source);
  expect(html.tags.map((tag) => tag.name)).toEqual(["span", "span"]);
  expect(html.elementAt(source.indexOf("{% if"))).toBe("span");
  expect(html.balance).toEqual({ unclosed: [], unexpectedClosings: [] });
  const formatted = await format(source, options);
  expect(formatted).toContain("a{% if x %}b");
  expect(await format(formatted, options)).toBe(formatted);
});

test.each([
  ["{% load x %}{% custom %}{% another %}", "{% load x %}\n{% custom %}\n{% another %}\n"],
  [
    "{{x}}{% if y %}<div>{{y}}</div>{% endif %}",
    "{{ x }}\n{% if y %}\n  <div>{{ y }}</div>\n{% endif %}\n",
  ],
  ["<span>{{x}}{% if y %}z{% endif %}</span>", "<span>{{ x }}{% if y %}z{% endif %}</span>\n"],
  ["<pre>{{x}}{% if y %}z{% endif %}</pre>", "<pre>{{x}}{% if y %}z{% endif %}</pre>\n"],
])("Doc boundaries replace post-render whitespace repair: %s", async (source, expected) => {
  expect(await format(source, options)).toBe(expected);
  expect(await format(expected, options)).toBe(expected);
});

test("parallel documents keep their plans and allocated markers isolated", async () => {
  const sources = Array.from(
    { length: 20 },
    (_, index) => `DJ${index}X <span>{%if x%}{{value_${index}}}{%else%}other{%endif%}</span>`,
  );
  const results = await Promise.all(sources.map((source) => format(source, options)));
  for (const [index, result] of results.entries()) {
    expect(result).toContain(`DJ${index}X`);
    expect(result).toContain(`{{ value_${index} }}`);
    expect(await format(result, options)).toBe(result);
  }
});
