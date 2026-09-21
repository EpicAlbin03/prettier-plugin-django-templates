import { format } from "prettier";
import { describe, expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";
import { parse } from "../src/parser.js";

const formatTemplate = (source: string) =>
  format(source, { parser: "django-html", plugins: [DjangoPlugin] });

describe("Django syntax in HTML comments", () => {
  test.each([
    "<!-- {% if x %} --><div>x</div>{% endif %}",
    "{% if x %}<div>x</div><!-- {% endif %} -->",
    "<!-- {% if x %} -->x<!-- {% else %} -->y<!-- {% endif %} -->",
    "<!-- {% if x %}{{value}}{% else %}other{% endif %} -->",
    "{% if x %}<!-- {% else %} -->other{% endif %}",
    "<!-- {% if x %}{{value}}{% endif %}",
  ])("parses and preserves blocks across comment boundaries: %s", async (source) => {
    const root = parse(source);
    expect(Object.values(root.nodes).filter((node) => node.type === "template-block")).toHaveLength(
      1,
    );
    const output = await formatTemplate(source);
    expect(output).toBe(source);
    expect(await formatTemplate(output)).toBe(output);
  });

  test.each([
    ["<!-- {{value}} -->", "expression"],
    ["<!-- {# template comment #} -->", "comment"],
    ['<!-- {% include "card.html" %} -->', "template-tag"],
  ])("recognizes enclosed constructs: %s", async (source, type) => {
    expect(Object.values(parse(source).nodes)).toEqual([
      expect.objectContaining({ type, sourceStart: 5, sourceEnd: source.length - 4 }),
    ]);
    const output = await formatTemplate(source);
    expect(output).toBe(source);
    expect(await formatTemplate(output)).toBe(output);
  });

  test.each(["<!-- {% endif %} -->", "<!-- {% else %} -->", "<!-- {% endif %}"])(
    "validates active tags instead of hiding them: %s",
    (source) => expect(() => parse(source)).toThrow("No start tag found"),
  );

  test.each(["verbatim", "comment"])(
    "keeps %s bodies opaque inside HTML comments",
    async (name) => {
      const source = `<!-- {% ${name} %} -->{% endif %}{{ untouched }}{% end${name} %}`;
      expect(Object.values(parse(source).nodes)).toEqual([
        expect.objectContaining({ type: "raw-block", keyword: name }),
      ]);
      expect(await formatTemplate(source)).toBe(source);
      expect(await formatTemplate(await formatTemplate(source))).toBe(source);
    },
  );

  test.each(["verbatim", "comment"])(
    "does not scan HTML comments inside %s bodies",
    async (name) => {
      const source = `{% ${name} %}<!-- {% endif %} -->{% end${name} %}`;
      expect(Object.values(parse(source).nodes)).toHaveLength(1);
      const output = await formatTemplate(source);
      expect(output).toContain(source);
      expect(await formatTemplate(output)).toBe(output);
    },
  );

  test.each([
    "<!-- prettier-ignore-start -->{% endif %}<!-- prettier-ignore-end -->",
    "{# prettier-ignore-start #}{% endif %}{# prettier-ignore-end #}",
  ])("retains explicit ignore regions: %s", async (region) => {
    const source = `<!-- ${region} -->`;
    expect(Object.values(parse(source).nodes)).toEqual([
      expect.objectContaining({ type: "ignore-region" }),
    ]);
    expect(await formatTemplate(source)).toBe(source);
    expect(await formatTemplate(await formatTemplate(source))).toBe(source);
  });
});
