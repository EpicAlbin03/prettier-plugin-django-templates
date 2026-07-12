export type InternalMarkerKind = "inline" | "block" | "attr" | "temporary-run";

export const INLINE_MARKER_SOURCE = String.raw`DJ\d+X`;
export const BLOCK_MARKER_SOURCE = String.raw`<!--DJ\d+-->`;
export const ATTRIBUTE_MARKER_SOURCE = String.raw`dj\d+=""`;
const TEMPORARY_RUN_MARKER_PREFIX = "DJ_INLINE_RUN_";
export const TEMPORARY_RUN_MARKER_SOURCE = `${TEMPORARY_RUN_MARKER_PREFIX}\\d+_X`;
export const PROTECTED_MARKER_SOURCE = `(?:${BLOCK_MARKER_SOURCE}|${INLINE_MARKER_SOURCE})`;

export function escapeMarkerForRegExp(marker: string): string {
  return marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function containsBlockMarker(value: string): boolean {
  return new RegExp(BLOCK_MARKER_SOURCE).test(value);
}

function legacyTemporaryRunMarkerFor(id: number): string {
  return `${TEMPORARY_RUN_MARKER_PREFIX}${id}`;
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
  readonly #source: string;
  readonly #allocated = new Set<string>();
  #nextId = 0;

  constructor(completeOriginalSource: string) {
    this.#source = completeOriginalSource;
  }

  allocate(kind: InternalMarkerKind): string {
    while (true) {
      const id = this.#nextId;
      this.#nextId += 1;
      const representations: InternalMarkerKind[] = ["inline", "block", "attr", "temporary-run"];
      const candidates = representations
        .map((candidateKind) => markerFor(id, candidateKind))
        // The old printer token is included so every historical representation is skipped too.
        .concat(legacyTemporaryRunMarkerFor(id));

      if (
        candidates.some(
          (candidate) => this.#source.includes(candidate) || this.#allocated.has(candidate),
        )
      ) {
        continue;
      }

      const marker = markerFor(id, kind);
      this.#allocated.add(marker);
      return marker;
    }
  }

  reserve(markers: Iterable<string>): void {
    for (const marker of markers) {
      this.#allocated.add(marker);
    }
  }

  restore(value: string, marker: string, replacement: string): string {
    if (!this.#allocated.has(marker)) {
      throw new Error("Cannot restore an internal marker that was not allocated.");
    }

    return value.replace(new RegExp(escapeMarkerForRegExp(marker), "g"), replacement);
  }
}
