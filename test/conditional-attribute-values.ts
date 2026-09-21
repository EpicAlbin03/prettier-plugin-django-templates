import { format } from "prettier";
import { expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";

const options = { parser: "django-html", plugins: [DjangoPlugin] };

test.each(['"', "'"])(
  "retains literal whitespace inside %s conditional attributes",
  async (quote) => {
    for (const value of ["a\n  b", "a \n\t b", "a\n\n    b", "a\n  {{ value }}\n b"]) {
      const attribute = `data-x=${quote}${value}${quote}`;
      const source = `<div {% if x %}${attribute}{% endif %}>x</div>`;
      const formatted = await format(source, options);
      expect(formatted).toContain(attribute);
      expect(await format(formatted, options)).toBe(formatted);
    }
  },
);
