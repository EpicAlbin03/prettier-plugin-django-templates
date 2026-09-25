import { format } from "prettier";
import { expect, test, vi } from "vitest";
import * as DjangoPlugin from "../src/index.js";
import { InternalMarkerAllocator } from "../src/internal-markers.js";

test("reserves the shared node dictionary once per document, not once per sibling block", async () => {
  const reserve = vi.spyOn(InternalMarkerAllocator.prototype, "reserve");
  try {
    const source = "{% panel %}<p>{{ value }}</p>{% endpanel %}\n".repeat(100);
    const options = { parser: "django-html", plugins: [DjangoPlugin] };
    const formatted = await format(source, options);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(await format(formatted, options)).toBe(formatted);
    expect(reserve).toHaveBeenCalledTimes(2);
  } finally {
    reserve.mockRestore();
  }
});
