import type { DjangoNode } from "./ast.js";
export type InternalMarkerKind = "inline" | "block" | "attr" | "temporary-run";

export const INLINE_MARKER_SOURCE = String.raw`DJ\d+X`;
export const BLOCK_MARKER_SOURCE = String.raw`<!--DJ\d+-->`;
export const ATTRIBUTE_MARKER_SOURCE = String.raw`dj\d+=""`;
const TEMPORARY_RUN_MARKER_PREFIX = "DJ_INLINE_RUN_";
export const TEMPORARY_RUN_MARKER_SOURCE = `${TEMPORARY_RUN_MARKER_PREFIX}\\d+_X`;
export const PROTECTED_MARKER_SOURCE = `(?:${BLOCK_MARKER_SOURCE}|${INLINE_MARKER_SOURCE})`;
export const ANY_MARKER_SOURCE = `(?:${BLOCK_MARKER_SOURCE}|${INLINE_MARKER_SOURCE}|${ATTRIBUTE_MARKER_SOURCE})`;

export function escapeMarkerForRegExp(marker: string): string {
  return marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function containsBlockMarker(value: string): boolean {
  return new RegExp(BLOCK_MARKER_SOURCE).test(value);
}

function markerFor(id: number, kind: InternalMarkerKind): string {
  switch (kind) {
    case "block":
      return `<!--DJ${id}-->`;
    case "attr":
      return `dj${id}=""`;
    case "temporary-run":
      return `${TEMPORARY_RUN_MARKER_PREFIX}${id}_X`;
    default:
      return `DJ${id}X`;
  }
}

/** Allocates parser and printer markers that cannot occur in user-controlled source. */
export class InternalMarkerAllocator {
  readonly #allocated = new Set<string>();
  readonly #unavailableIds = new Set<number>();
  #nextId = 0;

  constructor(completeOriginalSource: string) {
    this.#reserveIdsFrom(completeOriginalSource);
  }

  #reserveIdsFrom(value: string): void {
    const markerPattern = /DJ(\d+)X|<!--DJ(\d+)-->|dj(\d+)=""|DJ_INLINE_RUN_(\d+)(?:_X)?/g;
    for (const match of value.matchAll(markerPattern)) {
      const id = match.slice(1).find((part) => part !== undefined);
      if (id !== undefined) {
        this.#unavailableIds.add(Number(id));
      }
    }
  }

  allocate(kind: InternalMarkerKind): string {
    while (this.#unavailableIds.has(this.#nextId)) {
      this.#nextId += 1;
    }

    const id = this.#nextId;
    this.#nextId += 1;
    this.#unavailableIds.add(id);
    const marker = markerFor(id, kind);
    this.#allocated.add(marker);
    return marker;
  }

  reserve(markers: Iterable<string>): void {
    for (const marker of markers) {
      this.#allocated.add(marker);
      this.#reserveIdsFrom(marker);
    }
  }

  restore(value: string, marker: string, replacement: string): string {
    if (!this.#allocated.has(marker)) {
      throw new Error("Cannot restore an internal marker that was not allocated.");
    }

    return value.replace(new RegExp(escapeMarkerForRegExp(marker), "g"), () => replacement);
  }
}

export function markerEntries(
  value: string,
  nodes: Readonly<Record<string, DjangoNode>>,
): Array<{ id: string; index: number }> {
  const entries: Array<{ id: string; index: number }> = [];
  for (const match of value.matchAll(new RegExp(ANY_MARKER_SOURCE, "g"))) {
    if (nodes[match[0]]) {
      entries.push({ id: match[0], index: match.index });
    }
  }
  return entries;
}
