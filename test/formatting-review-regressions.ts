import { format } from "prettier";
import { describe, expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

// Intentionally failing regressions. See docs/formatting-review.md for findings,
// observed output, affected code, and existing coverage gaps. Do not update these
// expectations to the current formatter output or mark the tests as expected failures.
const formatTemplate = (source: string) =>
  format(source, { parser: "django-html", plugins: [DjangoPlugin] });

describe("F01: unquoted attribute values", () => {
  test.each([
    ["expression", "{{value}}", "{{ value }}"],
    ["interpolated text", "pre{{value}}post", "pre{{ value }}post"],
    [
      "conditional value",
      "{% if x %}yes{% else %}no{% endif %}",
      "{% if x %}yes{% else %}no{% endif %}",
    ],
  ])("retains the %s instead of leaking attribute markers", async (_name, value, expected) => {
    await expect(formatTemplate(`<div data-x=${value}></div>`)).resolves.toBe(
      `<div data-x="${expected}"></div>\n`,
    );
  });
});

test("F02: a conditional attribute adjacent to the element name is not lost", async () => {
  const output = await formatTemplate("<input{% if x %} disabled{% endif %}>");
  expect(output).toContain("{% if x %}");
  expect(output).toContain("disabled");
  expect(output).toContain("{% endif %}");
  expect(output).not.toMatch(/dj\d+/);
  expect(await formatTemplate(output)).toBe(output);
});

describe("F03: attribute marker collisions after HTML normalization", () => {
  test.each(["dj0=''", 'dj0 = ""'])("preserves the real attribute %s", async (attribute) => {
    await expect(formatTemplate(`<div ${attribute} {{attrs}}></div>`)).resolves.toBe(
      '<div dj0="" {{ attrs }}></div>\n',
    );
  });
});

describe("F04: significant template-block whitespace in block-flow HTML", () => {
  test.each([
    "a{% if x %}b{% endif %}c",
    "<div>a{% if x %}b{% endif %}c</div>",
    "<div>{% for x in xs %}{{ x }},{% endfor %}</div>",
  ])("does not introduce spaces into rendered text: %s", async (source) => {
    await expect(formatTemplate(source)).resolves.toBe(`${source}\n`);
  });
});

test("F05: whitespace-only blocks retain their literal body", async () => {
  const source = "<div>one{% if x %} {% endif %}two</div>";
  // With x=true this must still render 'one two', not 'onetwo'.
  await expect(formatTemplate(source)).resolves.toBe(`${source}\n`);
});

test("F06: filter blocks retain the exact input passed to the filter", async () => {
  const source = "{% filter length %}abc{% endfilter %}";
  // Adding indentation or line breaks changes the filter result from 3.
  await expect(formatTemplate(source)).resolves.toContain(source);
});

describe("F07: standalone tags embedded in inline text", () => {
  test.each(['{% include "part.html" %}', '{% url "view" as target %}'])(
    "does not add rendered whitespace around %s",
    async (tag) => {
      const source = `<span>a${tag}b</span>`;
      await expect(formatTemplate(source)).resolves.toBe(`${source}\n`);
    },
  );
});

describe("F08: standalone tags inside embedded-language string literals", () => {
  test.each([
    ["JavaScript", "<script>const text = \"{% include 'part.html' %}\";</script>"],
    ["CSS", "<style>.x { content: \"{% include 'part.html' %}\"; }</style>"],
  ])("does not insert literal newlines into a %s string", async (_name, source) => {
    await expect(formatTemplate(source)).resolves.toContain("\"{% include 'part.html' %}\"");
  });
});

test("F09: a standalone tag inside a JavaScript expression does not trigger semicolon insertion", async () => {
  const source = '<script>const x = {{value}}{% include "suffix" %};</script>';
  // A suffix template containing '+ 1' is part of the initializer, not a statement.
  const output = await formatTemplate(source);
  expect(output).toContain('{{ value }}{% include "suffix" %};');
  expect(await formatTemplate(output)).toBe(output);
});

test("F10: adjacent inline elements containing standalone tags stay adjacent", async () => {
  const source = '<span>{% include "a" %}</span><span>{% include "b" %}</span>';
  const output = await formatTemplate(source);
  // A line break between these elements renders an extra word separator.
  expect(output).toContain("</span><span>");
  expect(await formatTemplate(output)).toBe(output);
});

test("F11: a non-rendering comment block between inline siblings adds no separator", async () => {
  const source = "<span>a</span>{% comment %}hidden{% endcomment %}<span>b</span>";
  await expect(formatTemplate(source)).resolves.toBe(`${source}\n`);
});

describe("F12: multiple HTML attributes must not pad protected inline content", () => {
  test.each(["{{ value }}", "{# hidden #}"])("preserves adjacency around %s", async (body) => {
    const source = `<span class="a" title="b">${body}</span>`;
    await expect(formatTemplate(source)).resolves.toBe(`${source}\n`);
  });
});

describe("F13: Prettier ignore directive grammar", () => {
  test.each(["<!--prettier-ignore-->", "<!--\nprettier-ignore\n-->"])(
    "honors the valid directive %j for Django tokens too",
    async (directive) => {
      await expect(formatTemplate(`${directive}\n<div>{{value}}</div>`)).resolves.toContain(
        "<div>{{value}}</div>",
      );
    },
  );
});

describe("F14: Prettier ignore target scope", () => {
  test("ignores the entire following text node, not just its first Django construct", async () => {
    const source = "<!-- prettier-ignore -->{{first}} {{second}}";
    await expect(formatTemplate(source)).resolves.toContain("{{first}} {{second}}");
  });

  test.each(["some text", "<!-- another comment -->"])(
    "does not skip %s and ignore an unrelated later element",
    async (intervening) => {
      const source = `<!-- prettier-ignore -->${intervening}<div title="{{value}}"></div>`;
      await expect(formatTemplate(source)).resolves.toContain('title="{{ value }}"');
    },
  );
});

test("F15: comment blocks only close on the exact endcomment token", async () => {
  const source = "{% comment %}{% endcomment note %}ignored{% endcomment %}";
  await expect(formatTemplate(source)).resolves.toBe(`${source}\n`);
});

test("F16: comment terminator scanning respects the Django lexer's verbatim state", async () => {
  const source = "{% comment %}{% verbatim %}{% endcomment %}{% endverbatim %}{% endcomment %}";
  await expect(formatTemplate(source)).resolves.toBe(`${source}\n`);
});

describe("F17: self-closing django-components tags", () => {
  test.each(["component", "slot"])(
    "accepts a self-closing %s inside another block",
    async (tag) => {
      const source = `{% if x %}{% ${tag} "card" / %}{% endif %}`;
      const output = await formatTemplate(source);
      expect(output).toBe(`{% if x %}\n  {% ${tag} "card" / %}\n{% endif %}\n`);
      expect(await formatTemplate(output)).toBe(output);
    },
  );
});

test("F18: a CMS placeholder without 'or' is standalone", async () => {
  const source = '{% if x %}{% placeholder "content" %}{% endif %}';
  const output = await formatTemplate(source);
  expect(output).toBe('{% if x %}\n  {% placeholder "content" %}\n{% endif %}\n');
  expect(await formatTemplate(output)).toBe(output);
});

describe("F19: django-waffle branch support", () => {
  test.each(["switch", "sample"])("accepts else inside %s", async (tag) => {
    const source = `{% ${tag} "feature" %}yes{% else %}no{% end${tag} %}`;
    const output = await formatTemplate(source);
    expect(output).toBe(`{% ${tag} "feature" %}\n  yes\n{% else %}\n  no\n{% end${tag} %}\n`);
    expect(await formatTemplate(output)).toBe(output);
  });
});

test("F20: comment tag notes retain quoted whitespace", async () => {
  const source = '{% comment "keep  these  spaces" %}hidden{% endcomment %}';
  await expect(formatTemplate(source)).resolves.toBe(`${source}\n`);
});

describe("F21: preformatted content nested inside an HTML template element", () => {
  test.each(["pre", "textarea"])("preserves original token spelling inside <%s>", async (tag) => {
    const body = `<${tag}>{{value}}</${tag}>`;
    await expect(formatTemplate(`<template>${body}</template>`)).resolves.toContain(body);
  });
});

test("F22: leading blank lines before a standalone tag are removed on the first pass", async () => {
  const output = await formatTemplate('\n\n{% include "part.html" %}\n');
  expect(await formatTemplate(output)).toBe(output);
});

test("F23: title content containing a standalone tag is idempotent", async () => {
  const source = '<title>{{a}}{% include "part.html" %}{{b}}</title>';
  const output = await formatTemplate(source);
  expect(await formatTemplate(output)).toBe(output);
});

describe("F24: line-ending normalization must preserve Django lexical meaning", () => {
  test("recognizes an expression containing CR but no LF through the public formatter", async () => {
    await expect(formatTemplate("{{\rvalue}}")).resolves.toBe("{{ value }}\n");
  });

  test("accepts an if tag containing CR but no LF", async () => {
    const output = await formatTemplate("{% if\rx %}yes{% endif %}");
    expect(output).toBe("{% if x %}\n  yes\n{% endif %}\n");
    expect(await formatTemplate(output)).toBe(output);
  });

  test("does not activate literal LF-spanning delimiters when CR output is requested", async () => {
    const output = await format("{{\nvalue}}", {
      parser: "django-html",
      plugins: [DjangoPlugin],
      endOfLine: "cr",
    });
    // Django's non-DOTALL lexer excludes LF, not CR. This must remain literal text.
    expect(output).not.toMatch(/{{[^\n]*?}}/);
  });
});
