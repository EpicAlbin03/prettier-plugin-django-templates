import { format } from "prettier";
import { describe, expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";
import { parse } from "../src/parser.js";

const formatTemplate = (source: string) =>
  format(source, { parser: "django-html", plugins: [DjangoPlugin] });

// Django's template/base.py tag_re uses dot without DOTALL: only LF interrupts a match.
const djangoConstructs = (source: string) =>
  [...source.matchAll(/{%[^\n]*?%}|{{[^\n]*?}}|{#[^\n]*?#}/g)].map((match) => match[0]);

describe("Django lexer literal delimiters", () => {
  test.each([
    "{{\n user }}",
    "{#\n comment #}",
    "{%\n if x %}literal{%\n endif %}",
    "{{ user\n}}",
    "{{ user\r\n}}",
    "{{ unfinished",
    "{# unfinished",
    "{% unfinished",
    "<p>{{ title</p>",
    "<div>{{\n user }}</div>",
  ])("preserves literal syntax: %j", async (source) => {
    expect(Object.values(parse(source).nodes)).toEqual([]);
    const output = await formatTemplate(source);
    expect(output.trimEnd()).toBe(source.replaceAll("\r\n", "\n"));
    expect(djangoConstructs(output)).toEqual([]);
    expect(await formatTemplate(output)).toBe(output);
  });

  test.each([
    "{{\n {{user}} }}",
    "{{ {#active#}\n {{user}} }}",
    "{#\n {{user}} #}",
    "{%\n {% if x %}{{user}}{% endif %} %}",
    "{{ unfinished\n{% if x %}{{user}}{% endif %}",
  ])("recognizes one-line constructs inside literal delimiters: %j", async (source) => {
    const root = parse(source);
    expect(Object.values(root.nodes).filter((node) => node.type === "expression")).toHaveLength(1);
    const output = await formatTemplate(source);
    expect(output).toBe(source);
    expect(djangoConstructs(output)).toEqual(djangoConstructs(source));
    expect(await formatTemplate(output)).toBe(output);
  });

  test("still validates active end tags following a literal multiline opener", () => {
    expect(() => parse('{% comment "Hover\n comment/endcomment" %}{% endcomment %}')).toThrow(
      'No start tag found for template end tag "{% endcomment %}".',
    );
  });

  test.each(["\r", "\u2028", "\u2029"])("recognizes non-LF separators %j", (separator) => {
    expect(Object.values(parse(`{{${separator}user}}`).nodes)[0]?.type).toBe("expression");
  });

  test.each(["{# {% endverbatim %} #}", '{{ "{% endverbatim %}" }}', "{%\n endverbatim %}"])(
    "ignores non-tag raw-body terminators: %j",
    async (body) => {
      const source = `{% verbatim %}${body}{{ untouched }}{% endverbatim %}`;
      expect(Object.values(parse(source).nodes)).toHaveLength(1);
      expect(await formatTemplate(source)).toBe(`${source}\n`);
    },
  );

  test("does not close raw bodies with an LF-spanning end tag", async () => {
    const source = "{% verbatim %}{%\n endverbatim %}{{ untouched }}{% endverbatim %}";
    expect(Object.values(parse(source).nodes)).toHaveLength(1);
    expect(await formatTemplate(source)).toBe(`${source}\n`);
  });
});
