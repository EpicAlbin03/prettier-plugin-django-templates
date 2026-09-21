import { format } from "prettier";
import { expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const formatTemplate = (source: string) =>
  format(source, { parser: "django-html", plugins: [DjangoPlugin] });

test.each([
  ["else", "{% if x %}yes{% else %}no{% endif %}"],
  ["elif", "{% if x %}yes{% elif y %}maybe{% else %}no{% endif %}"],
  ["empty", "{% for x in xs %}{{ x }}{% empty %}none{% endfor %}"],
  ["inline markup", "{% if x %}<b>yes</b>{% else %}<em>no</em>{% endif %}"],
  ["nested branches", "{% if outer %}{% if x %}yes{% else %}no{% endif %}{% endif %}"],
  ["significant spaces", "{% if x %} yes {% else %} no {% endif %}"],
  ["existing newlines", "{% if x %}yes\n{% else %}\nno{% endif %}"],
])(
  "preserves %s branch whitespace in inline HTML across repeated formatting",
  async (_name, block) => {
    const source = `<div><span>before${block}!</span></div><div>after</div>`;
    const formatted = await formatTemplate(source);

    expect(formatted).toContain(`before${block}!`);
    let previous = formatted;
    for (let pass = 0; pass < 3; pass += 1) {
      const next = await formatTemplate(previous);
      expect(next).toBe(formatted);
      previous = next;
    }
  },
);
