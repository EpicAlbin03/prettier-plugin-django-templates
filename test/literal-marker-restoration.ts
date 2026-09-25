import { format } from "prettier";
import { expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";
import { InternalMarkerAllocator } from "../src/internal-markers.js";

const replacements = ["$&", "$$", "$'", "$`"];

test.each(replacements)("restores %s literally", (replacement) => {
  const markers = new InternalMarkerAllocator("");
  const marker = markers.allocate("temporary-run");
  expect(markers.restore(`before${marker}after${marker}`, marker, replacement)).toBe(
    `before${replacement}after${replacement}`,
  );
});

test.each(replacements)(
  "preserves replacement sequences in template content: %s",
  async (value) => {
    for (const source of [
      `{% verbatim %}${value}{% endverbatim %}`,
      `<!-- prettier-ignore-start -->${value}<!-- prettier-ignore-end -->`,
      `<pre>{{ "${value}" }}</pre>`,
    ]) {
      const options = { parser: "django-html", plugins: [DjangoPlugin] };
      const formatted = await format(source, options);
      expect(formatted).toContain(source);
      expect(await format(formatted, options)).toBe(formatted);
    }
  },
);
