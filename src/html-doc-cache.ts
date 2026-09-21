import { doc, type Doc, type Options } from "prettier";
import type { DjangoNode } from "./ast.js";
import { INLINE_MARKER_SOURCE, markerEntries } from "./internal-markers.js";

type TextToDoc = (text: string, options: Options) => Promise<Doc>;

interface CachedHtmlDoc {
  readonly ids: readonly string[];
  readonly doc: Promise<Doc>;
}

/**
 * Reuses small HTML fragments within one formatting call, before Django Docs are
 * substituted. Marker lengths and repeated-marker relationships are part of the
 * key: changing either can change Prettier's layout. No normalized text is ever
 * sent to Prettier; the first fragment is parsed exactly as supplied.
 */
export class HtmlDocCache {
  readonly #nodes: Readonly<Record<string, DjangoNode>>;
  readonly #entries = new Map<string, CachedHtmlDoc>();

  constructor(nodes: Readonly<Record<string, DjangoNode>>) {
    this.#nodes = nodes;
  }

  async format(
    text: string,
    textToDoc: TextToDoc,
    sensitivity: Options["htmlWhitespaceSensitivity"],
  ): Promise<Doc> {
    const options: Options = { parser: "html", htmlWhitespaceSensitivity: sensitivity };
    // Embedded languages and attribute markers may split or rewrite identifiers.
    // Leave those paths alone, along with large/unique fragments.
    if (
      text.length > 4_096 ||
      /<(?:!|\?|\s*(?:script|style|pre|textarea|title|template)(?=[\s/>]))/i.test(text)
    ) {
      return textToDoc(text, options);
    }
    const entries = markerEntries(text, this.#nodes);
    if (
      entries.length === 0 ||
      entries.some(({ id }) => {
        const node = this.#nodes[id];
        return node.type !== "expression" || node.hostContext !== "document-flow";
      })
    ) {
      return textToDoc(text, options);
    }

    const ids: string[] = [];
    const positions = new Map<string, number>();
    const parts: Array<string | number> = [sensitivity ?? "css"];
    let cursor = 0;
    for (const { id, index } of entries) {
      let position = positions.get(id);
      if (position === undefined) {
        position = ids.length;
        positions.set(id, position);
        ids.push(id);
      }
      parts.push(text.slice(cursor, index), position, id.length);
      cursor = index + id.length;
    }
    parts.push(text.slice(cursor));
    const key = JSON.stringify(parts);
    const cached = this.#entries.get(key);
    if (!cached) {
      const result = textToDoc(text, options);
      // Bound retained Docs even for documents with many different fragments.
      if (this.#entries.size < 128) this.#entries.set(key, { ids, doc: result });
      return result;
    }

    const replacements = new Map(cached.ids.map((id, index) => [id, ids[index]]));
    const groupIds = new Map<symbol, symbol>();
    const freshGroupId = (id: symbol) => {
      let fresh = groupIds.get(id);
      if (!fresh) {
        fresh = Symbol(id.description);
        groupIds.set(id, fresh);
      }
      return fresh;
    };
    const markers = new RegExp(INLINE_MARKER_SOURCE, "g");
    return doc.utils.mapDoc(await cached.doc, (part) => {
      // Strings are the only text leaves in Prettier's documented Doc union.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof
      if (typeof part === "string") {
        return part.replace(markers, (id) => replacements.get(id) ?? id);
      }
      // Cached groups must not share break decisions with another occurrence.
      if (!Array.isArray(part)) {
        if (part.type === "group" && part.id) return { ...part, id: freshGroupId(part.id) };
        if (part.type === "if-break" || part.type === "indent-if-break") {
          // SAFETY: Prettier's builders accept a symbol groupId, but its published
          // Doc declarations omit that field on IfBreak and IndentIfBreak.
          const conditional = part as typeof part & { groupId?: symbol };
          if (conditional.groupId) {
            return { ...conditional, groupId: freshGroupId(conditional.groupId) };
          }
        }
      }
      return part;
    });
  }
}
