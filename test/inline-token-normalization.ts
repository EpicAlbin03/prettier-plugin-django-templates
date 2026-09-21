import { format } from "prettier";
import { expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const options = { parser: "django-html", plugins: [DjangoPlugin], printWidth: 120 };

test.each([
  [
    "<title>{%block title%} {%endblock%}</title>",
    "<title>{% block title %} {% endblock %}</title>",
  ],
  [
    "<span>a{%if x%}b{%else%}c{%endif%}d</span>",
    "<span>a{% if x %}b{% else %}c{% endif %}d</span>",
  ],
  [
    "<span>{%if x%} {%for y in ys%}{{y}}{%endfor%}  {%endif%}</span>",
    "<span>{% if x %} {% for y in ys %}{{ y }}{% endfor %}  {% endif %}</span>",
  ],
  [
    "<span>{%if x%}\n  a\n {%else%}b\n{%endif%}</span>",
    "<span>{% if x %}\n  a\n {% else %}b\n{% endif %}</span>",
  ],
  [
    "<span>{%if x%}{% verbatim %}{{raw}}{%if y%}{% endverbatim %}{%endif%}</span>",
    "<span>{% if x %}{% verbatim %}{{raw}}{%if y%}{% endverbatim %}{% endif %}</span>",
  ],
  [
    "<span>{%if x%}{% blocktrans %} Hello {{name}} {% endblocktrans %}{%endif%}</span>",
    "<span>{% if x %}{% blocktrans %} Hello {{name}} {% endblocktrans %}{% endif %}</span>",
  ],
])("normalizes inline tokens without changing literal body text: %s", async (source, expected) => {
  const formatted = await format(source, options);
  expect(formatted.trimEnd()).toBe(expected);
  expect(await format(formatted, options)).toBe(formatted);
});
