import type { Doc } from "prettier";
import type { DjangoNode } from "./ast.js";
import { markerEntries, PROTECTED_MARKER_SOURCE } from "./internal-markers.js";

export function containsProtectedNodeMarker(
  value: string,
  nodes: Readonly<Record<string, DjangoNode>>,
): boolean {
  return markerEntries(value, nodes).length > 0;
}

export function replaceProtectedMarkersInString(
  currentDoc: string,
  nodes: Readonly<Record<string, DjangoNode>>,
  render: (
    id: string,
    context: {
      linePrefix: string;
      lineSuffix: string;
      hasNewlineBefore: boolean;
      hasProtectedMarkerOnNextLine: boolean;
    },
  ) => { doc: Doc; trimLeadingWhitespace?: boolean; trimFollowingWhitespace?: boolean },
): Doc {
  const parts: Doc[] = [];
  let cursor = 0;
  let trimFollowingWhitespace = false;

  for (const { id: matchedId, index: matchedIndex } of markerEntries(currentDoc, nodes)) {
    const lineStart = currentDoc.lastIndexOf("\n", matchedIndex - 1) + 1;
    const nextNewline = currentDoc.indexOf("\n", matchedIndex + matchedId.length);
    const lineEnd = nextNewline === -1 ? currentDoc.length : nextNewline;
    const linePrefix = currentDoc.slice(lineStart, matchedIndex);
    const lineSuffix = currentDoc.slice(matchedId.length + matchedIndex, lineEnd);
    const hasNewlineBefore = lineStart > 0;
    const hasProtectedMarkerOnNextLine = new RegExp(`^\\n${PROTECTED_MARKER_SOURCE}`).test(
      currentDoc.slice(matchedIndex + matchedId.length),
    );
    const rendered = render(matchedId, {
      linePrefix,
      lineSuffix,
      hasNewlineBefore,
      hasProtectedMarkerOnNextLine,
    });

    if (matchedIndex > cursor) {
      const between = currentDoc.slice(cursor, matchedIndex);
      if (!((rendered.trimLeadingWhitespace || trimFollowingWhitespace) && /^\s*$/.test(between))) {
        parts.push(between);
      }
    }

    parts.push(rendered.doc);
    trimFollowingWhitespace = Boolean(rendered.trimFollowingWhitespace);
    cursor = matchedIndex + matchedId.length;
  }

  if (cursor < currentDoc.length) {
    parts.push(currentDoc.slice(cursor));
  }
  return parts;
}
