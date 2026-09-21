import { format } from "prettier";
import { expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const formatTemplate = (source: string) =>
  format(source, { parser: "django-html", plugins: [DjangoPlugin] });

test.each([
  [
    "an unclosed conditional preformatted wrapper",
    "{% if enabled %}<pre>{% endif %}  a   {{value}}",
  ],
  [
    "a conditional closing wrapper without an opening",
    "{% if enabled %}</span>{% endif %}<div>after</div>",
  ],
  ["an unfinished conditional attribute", '{% if enabled %}<div title="unfinished{% endif %}'],
  ["an unfinished conditional declaration", "{% if enabled %}<!DOCTYPE html{% endif %}"],
  [
    "an unfinished comment following conditional HTML",
    "{% if enabled %}<div>{% endif %}<!-- unfinished",
  ],
  [
    "an unclosed conditional raw-text element",
    "{% if enabled %}<script>const value = 1;{% endif %}",
  ],
])("preserves %s rather than guessing its HTML context", async (_name, source) => {
  const expected = `${source}\n`;
  expect(await formatTemplate(source)).toBe(expected);
  expect(await formatTemplate(expected)).toBe(expected);
});

test.each(["", "\n"])(
  "preserves an unclosed HTML comment including its final newline: %j",
  async (ending) => {
    const source = `{% if enabled %}<!-- unfinished{% endif %}${ending}`;
    expect(await formatTemplate(source)).toBe(source);
  },
);

test("preserves conditional preformatted ranges nested inside a template block", async () => {
  const source =
    "{% block content %}\n  {% if enabled %}<pre>{% endif %}  a   {{value}}{% if enabled %}</pre>{% endif %}\n{% endblock %}\n";
  expect(await formatTemplate(source)).toBe(source);
  expect(await formatTemplate(await formatTemplate(source))).toBe(source);
});

test("keeps a multiline template block after an expression structurally indented", async () => {
  const source = "<div>{{ before }}{% if enabled %}\n<div>{{ inside }}</div>\n{% endif %}</div>";
  const expected =
    "<div>\n  {{ before }}\n  {% if enabled %}\n    <div>{{ inside }}</div>\n  {% endif %}\n</div>\n";
  expect(await formatTemplate(source)).toBe(expected);
  expect(await formatTemplate(expected)).toBe(expected);
});

test("does not compact an expression's following block when its element has multiple attributes", async () => {
  const source =
    '<div>{{ before }}{% if enabled %}<div class="a" title="b">{{ inside }}</div>{% endif %}</div>';
  const expected =
    '<div>\n  {{ before }}\n  {% if enabled %}\n    <div class="a" title="b">{{ inside }}</div>\n  {% endif %}\n</div>\n';
  expect(await formatTemplate(source)).toBe(expected);
  expect(await formatTemplate(expected)).toBe(expected);
});

test("treats less-than text as text before standalone-only elements", async () => {
  const source = "<3><span>{% custom_asset %}</span>";
  const expected = "<3>\n<span>{% custom_asset %}</span>\n";
  expect(await formatTemplate(source)).toBe(expected);
  expect(await formatTemplate(expected)).toBe(expected);
});
