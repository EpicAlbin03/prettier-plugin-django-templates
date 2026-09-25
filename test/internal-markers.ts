import { format } from "prettier";
import { describe, expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";
import {
  ATTRIBUTE_MARKER_SOURCE,
  BLOCK_MARKER_SOURCE,
  containsBlockMarker,
  escapeMarkerForRegExp,
  INLINE_MARKER_SOURCE,
  InternalMarkerAllocator,
  type InternalMarkerKind,
  TEMPORARY_RUN_MARKER_SOURCE,
} from "../src/internal-markers.js";

const formatTemplate = (source: string) =>
  format(source, { parser: "django-html", plugins: [DjangoPlugin] });

const markerSources: Array<[InternalMarkerKind, string]> = [
  ["inline", INLINE_MARKER_SOURCE],
  ["block", BLOCK_MARKER_SOURCE],
  ["attr", ATTRIBUTE_MARKER_SOURCE],
  ["temporary-run", TEMPORARY_RUN_MARKER_SOURCE],
];

describe("attribute marker collisions after HTML normalization", () => {
  test.each(["dj0=''", 'dj0 = ""'])("preserves the real attribute %s", async (attribute) => {
    await expect(formatTemplate(`<div ${attribute} {{attrs}}></div>`)).resolves.toBe(
      '<div dj0="" {{ attrs }}></div>\n',
    );
  });
});

describe("internal marker ownership", () => {
  test.each(markerSources)(
    "recognizes every generated %s marker through the authoritative syntax",
    (kind, source) => {
      const marker = new InternalMarkerAllocator("").allocate(kind);
      expect(marker).toMatch(new RegExp(`^(?:${source})$`));
      expect(containsBlockMarker(marker)).toBe(kind === "block");
    },
  );

  test("skips collisions in every active and historical representation", () => {
    const source = `DJ0X <!--DJ0--> dj0="" DJ_INLINE_RUN_0_X DJ_INLINE_RUN_0`;
    const allocator = new InternalMarkerAllocator(source);
    expect(allocator.allocate("inline")).toBe("DJ1X");
  });

  test("restores only allocated markers using escaped literal recognition", () => {
    const allocator = new InternalMarkerAllocator("");
    const marker = allocator.allocate("block");
    expect(allocator.restore(`${marker} ${marker}`, marker, "{% load static %}")).toBe(
      "{% load static %} {% load static %}",
    );
    expect(new RegExp(escapeMarkerForRegExp(marker)).test(marker)).toBe(true);
    expect(() => allocator.restore("DJ99X", "DJ99X", "value")).toThrow(
      "Cannot restore an internal marker that was not allocated.",
    );
  });
});
