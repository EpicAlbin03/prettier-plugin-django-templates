import type { DjangoNode, ExpressionNode, RawBlockNode, TemplateBlockNode } from "./ast.js";
import { INLINE_MARKER_SOURCE } from "./internal-markers.js";

export function formatExpression(node: ExpressionNode): string {
  return `{{ ${node.content.trim()} }}`;
}

export function getExpressionOnlyBlockLines(block: TemplateBlockNode): string[][] | undefined {
  const lines = block.html.replace(/\r\n/g, "\n").split("\n");

  while (lines[0] !== undefined && /^\s*$/.test(lines[0])) {
    lines.shift();
  }
  while (lines.at(-1) !== undefined && /^\s*$/.test(lines.at(-1)!)) {
    lines.pop();
  }

  if (lines.length === 0) {
    return undefined;
  }

  const lineDocs: string[][] = [];
  let expressionCount = 0;

  for (const line of lines) {
    if (/^\s*$/.test(line)) {
      lineDocs.push([]);
      continue;
    }

    const markerPattern = new RegExp(INLINE_MARKER_SOURCE, "g");
    const markers = [...line.matchAll(markerPattern)];
    if (markers.length === 0 || !/^\s*$/.test(line.replace(markerPattern, ""))) {
      return undefined;
    }

    const lineDoc: string[] = [];
    let cursor = 0;
    for (const marker of markers) {
      const id = marker[0];
      const expression = block.nodes[id];
      if (expression?.type !== "expression") {
        return undefined;
      }

      lineDoc.push(line.slice(cursor, marker.index), formatExpression(expression));
      cursor = marker.index + id.length;
      expressionCount += 1;
    }
    lineDoc.push(line.slice(cursor).trimEnd());
    lineDocs.push(lineDoc);
  }

  if (expressionCount < 2) {
    return undefined;
  }

  return lineDocs;
}

export function getRawBlockText(node: RawBlockNode): string {
  const args = node.args?.trim();
  const endArgs = node.endArgs?.trim();

  if (!node.keyword || node.body === undefined) {
    return node.sourceText;
  }

  if (node.keyword === "verbatim" && args) {
    // Normalizing significant inner whitespace could make an earlier raw terminator match next pass.
    const openingEnd = node.sourceText.indexOf("%}");
    const openingContent = node.sourceText.slice(2, openingEnd).trim();
    if (openingContent !== `verbatim ${args}`) {
      return node.sourceText;
    }
  }

  return `{% ${node.keyword}${args ? ` ${args}` : ""} %}${node.body}{% end${node.keyword}${endArgs ? ` ${endArgs}` : ""} %}`;
}

export function getTranslationBlockText(node: DjangoNode): string | undefined {
  if (
    node.type !== "template-block" ||
    (node.start.keyword !== "blocktranslate" && node.start.keyword !== "blocktrans")
  ) {
    return undefined;
  }

  // Django uses body whitespace (and literal HTML) in gettext keys. Preserve even
  // trimmed bodies: HTML formatting can change more than Django's trimming removes.
  const body = node.sourceText.slice(
    node.start.sourceEnd - node.sourceStart,
    node.end.sourceStart - node.sourceStart,
  );
  return `{% ${node.start.content.trim()} %}${body}{% ${node.end.content.trim()} %}`;
}

// Inline layout must preserve literal source gaps, not the spelling of Django tokens.
// Raw, ignored, preformatted, and translation bodies keep their existing stronger protection.
export function getInlineBlockText(block: TemplateBlockNode): string {
  if (block.preserveOriginalText) {
    return block.sourceText;
  }
  const translation = getTranslationBlockText(block);
  if (translation !== undefined) {
    return translation;
  }

  const parts: string[] = [];
  let cursor = block.sourceStart;
  for (const child of [block.start, ...block.childIds.map((id) => block.nodes[id]), block.end]) {
    parts.push(
      block.sourceText.slice(cursor - block.sourceStart, child.sourceStart - block.sourceStart),
    );
    parts.push(
      child.preserveOriginalText
        ? child.sourceText
        : child.type === "template-block"
          ? getInlineBlockText(child)
          : child.type === "template-tag"
            ? `{% ${child.content.trim()} %}`
            : child.type === "expression"
              ? formatExpression(child)
              : child.type === "comment"
                ? `{# ${child.content.trim()} #}`
                : child.sourceText,
    );
    cursor = child.sourceEnd;
  }
  return parts.join("");
}
