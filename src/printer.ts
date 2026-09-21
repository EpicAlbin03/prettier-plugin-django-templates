import type { AstPath, Doc, Options, Printer } from "prettier";
import { doc } from "prettier";
import { scanHtmlHostContexts } from "./html-host-context.js";
import {
  ANY_MARKER_SOURCE,
  ATTRIBUTE_MARKER_SOURCE,
  BLOCK_MARKER_SOURCE,
  containsBlockMarker,
  escapeMarkerForRegExp,
  INLINE_MARKER_SOURCE,
  InternalMarkerAllocator,
  PROTECTED_MARKER_SOURCE,
} from "./internal-markers.js";
import {
  getStartTagFormatting,
  isBranchTag,
  startsDocumentFlowAfterExpression,
  startsDocumentFlowAfterTag,
} from "./tags.js";
import type {
  RootNode,
  TemplateBlockNode,
  DjangoNode,
  ExpressionNode,
  RawBlockNode,
  TemplateTagNode,
} from "./ast.js";

const { builders, printer, utils } = doc;
const { mapDoc } = utils;
const { printDocToString } = printer;

function markerEntries(
  value: string,
  nodes: Record<string, DjangoNode>,
): Array<{ id: string; index: number }> {
  const entries: Array<{ id: string; index: number }> = [];
  for (const match of value.matchAll(new RegExp(ANY_MARKER_SOURCE, "g"))) {
    if (nodes[match[0]]) {
      entries.push({ id: match[0], index: match.index });
    }
  }
  return entries;
}

function containsProtectedNodeMarker(value: string, nodes: Record<string, DjangoNode>): boolean {
  return markerEntries(value, nodes).length > 0;
}

function replaceProtectedMarkersInString(
  currentDoc: string,
  nodes: Record<string, DjangoNode>,
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

function hasHtmlMarkup(content: string): boolean {
  return /<(?!!--)[A-Za-z/!][^>]*>/.test(content);
}

function findHtmlTagEnd(content: string, tagStart: number): number | undefined {
  let quote: '"' | "'" | undefined;
  for (let cursor = tagStart + 1; cursor < content.length; cursor += 1) {
    const char = content[cursor];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return cursor;
    }
  }

  return undefined;
}

function getHtmlFragmentBalance(content: string) {
  const stack: string[] = [];
  const unexpectedClosings: string[] = [];
  const rawTextElements = new Set(["script", "style", "textarea", "title", "template"]);
  let cursor = 0;

  while (cursor < content.length) {
    const currentRawElement = stack.at(-1);
    if (currentRawElement && rawTextElements.has(currentRawElement)) {
      const rawEnd = new RegExp(`</${currentRawElement}\\s*>`, "gi");
      rawEnd.lastIndex = cursor;
      const match = rawEnd.exec(content);
      if (!match) {
        break;
      }
      stack.pop();
      cursor = match.index + match[0].length;
      continue;
    }

    const tagStart = content.indexOf("<", cursor);
    if (tagStart === -1) {
      break;
    }
    if (content.startsWith("<!--", tagStart)) {
      const commentEnd = content.indexOf("-->", tagStart + 4);
      if (commentEnd === -1) {
        return undefined;
      }
      cursor = commentEnd + 3;
      continue;
    }
    if (content.startsWith("<!", tagStart) || content.startsWith("<?", tagStart)) {
      const declarationEnd = findHtmlTagEnd(content, tagStart);
      if (declarationEnd === undefined) {
        return undefined;
      }
      cursor = declarationEnd + 1;
      continue;
    }

    const tagEnd = findHtmlTagEnd(content, tagStart);
    if (tagEnd === undefined) {
      return undefined;
    }

    const tagText = content.slice(tagStart, tagEnd + 1);
    const tag = tagText.match(/^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)/);
    if (!tag) {
      cursor = tagStart + 1;
      continue;
    }

    const closing = tag[1] === "/";
    const name = tag[2].toLowerCase();
    if (closing) {
      if (stack.at(-1) !== name) {
        unexpectedClosings.push(name);
      } else {
        stack.pop();
      }
    } else if (!/\/\s*>$/.test(tagText) && !HTML_VOID_ELEMENTS.has(name)) {
      stack.push(name);
    }
    cursor = tagEnd + 1;
  }

  return { unclosed: stack, unexpectedClosings };
}

function isBalancedTopLevelHtml(content: string): boolean {
  const balance = getHtmlFragmentBalance(content);
  return Boolean(
    balance && balance.unclosed.length === 0 && balance.unexpectedClosings.length === 0,
  );
}

function findInlineOnlyStandaloneElements(
  node: TemplateBlockNode | { content: string; nodes: Record<string, DjangoNode> },
  segment: string,
): Array<{ index: number; marker: string; text: string }> {
  const matches: Array<{ index: number; marker: string; text: string }> = [];
  const markerPattern = new RegExp(`^(${PROTECTED_MARKER_SOURCE})`);
  let cursor = 0;

  while (cursor < segment.length) {
    const tagStart = segment.indexOf("<", cursor);
    if (tagStart === -1) {
      break;
    }
    if (segment.startsWith("<!--", tagStart)) {
      const commentEnd = segment.indexOf("-->", tagStart + 4);
      cursor = commentEnd === -1 ? segment.length : commentEnd + 3;
      continue;
    }

    const openEnd = findHtmlTagEnd(segment, tagStart);
    if (openEnd === undefined) {
      break;
    }
    const openText = segment.slice(tagStart, openEnd + 1);
    const openTag = openText.match(/^<\s*([A-Za-z][A-Za-z0-9:-]*)/);
    if (!openTag || /\/\s*>$/.test(openText)) {
      cursor = openEnd + 1;
      continue;
    }

    const markerMatch = segment.slice(openEnd + 1).match(markerPattern);
    if (!markerMatch) {
      cursor = openEnd + 1;
      continue;
    }
    const marker = markerMatch[1];
    const closeStart = openEnd + 1 + marker.length;
    const closeEnd = findHtmlTagEnd(segment, closeStart);
    if (closeEnd === undefined) {
      cursor = openEnd + 1;
      continue;
    }
    const closeText = segment.slice(closeStart, closeEnd + 1);
    const closeTag = closeText.match(/^<\s*\/\s*([A-Za-z][A-Za-z0-9:-]*)\s*>$/);
    const child = node.nodes[marker];
    if (
      closeTag?.[1].toLowerCase() === openTag[1].toLowerCase() &&
      child?.type === "template-tag" &&
      child.role === "standalone" &&
      isBalancedTopLevelHtml(segment.slice(0, tagStart))
    ) {
      matches.push({ index: tagStart, marker, text: segment.slice(tagStart, closeEnd + 1) });
      cursor = closeEnd + 1;
      continue;
    }

    cursor = openEnd + 1;
  }

  return matches;
}

function splitTopLevelInlineOnlyStandaloneElements(
  node: TemplateBlockNode | { content: string; nodes: Record<string, DjangoNode> },
  segments: string[],
): string[] {
  return segments.flatMap((segment) => {
    const parts: string[] = [];
    let cursor = 0;
    let previousPartWasSplitElement = false;
    for (const match of findInlineOnlyStandaloneElements(node, segment)) {
      if (match.index > cursor) {
        const between = segment.slice(cursor, match.index);
        if (!(previousPartWasSplitElement && /^\s*$/.test(between))) {
          parts.push(between);
          previousPartWasSplitElement = false;
        }
      }
      parts.push(match.text);
      previousPartWasSplitElement = true;
      cursor = match.index + match.text.length;
    }
    if (cursor < segment.length) {
      const trailing = segment.slice(cursor);
      if (!(previousPartWasSplitElement && /^\s*$/.test(trailing))) {
        parts.push(trailing);
      }
    }
    return parts.length > 0 ? parts : [segment];
  });
}

function splitAtTemplateTags(
  node: TemplateBlockNode | { content: string; nodes: Record<string, DjangoNode> },
): string[] {
  const splitStandaloneTemplateTags = !hasHtmlMarkup(node.content);
  const splitters = markerEntries(node.content, node.nodes)
    .map(({ id }) => node.nodes[id])
    .filter(
      (entry): entry is TemplateTagNode =>
        entry.type === "template-tag" &&
        !entry.inTag &&
        !entry.inAttribute &&
        (isBranchTag(entry.keyword) ||
          ((splitStandaloneTemplateTags || node.content.startsWith(entry.id)) &&
            entry.role === "standalone" &&
            entry.protectedMarkerKind === "block")),
    );

  if (splitters.length === 0) {
    return [node.content];
  }

  const pattern = new RegExp(
    `(${splitters.map((entry) => escapeMarkerForRegExp(entry.id)).join("|")})`,
  );
  return node.content.split(pattern).filter(Boolean);
}

function stripProtectedMarkerContext(value: string): string {
  return value
    .replace(new RegExp(BLOCK_MARKER_SOURCE, "g"), "")
    .replace(new RegExp(INLINE_MARKER_SOURCE, "g"), "")
    .replace(new RegExp(ATTRIBUTE_MARKER_SOURCE, "g"), "");
}

function isInlineOnlyChildContext(linePrefix: string, lineSuffix: string): boolean {
  const cleanPrefix = stripProtectedMarkerContext(linePrefix);
  const cleanSuffix = stripProtectedMarkerContext(lineSuffix);

  return /^\s*<[^/!][^>]*>\s*$/.test(cleanPrefix) && /^\s*<\/[^>]+>\s*$/.test(cleanSuffix);
}

function printDocumentFlowNode(
  renderedNode: Doc,
  linePrefix: string,
  lineSuffix: string,
  inlineWithNext = false,
  hasProtectedMarkerOnNextLine = false,
): Doc {
  if (isInlineOnlyChildContext(linePrefix, lineSuffix)) {
    return renderedNode;
  }

  const cleanPrefix = stripProtectedMarkerContext(linePrefix);
  const cleanSuffix = stripProtectedMarkerContext(lineSuffix);
  const hasContentBefore = /\S/.test(cleanPrefix);
  const hasContentAfter =
    !inlineWithNext &&
    (new RegExp(`${BLOCK_MARKER_SOURCE}|\\S`).test(lineSuffix) ||
      /\S/.test(cleanSuffix) ||
      hasProtectedMarkerOnNextLine);

  return [
    hasContentBefore ? builders.hardline : "",
    renderedNode,
    hasContentAfter ? builders.hardline : "",
  ];
}

function formatExpression(node: ExpressionNode): string {
  return `{{ ${node.content.trim()} }}`;
}

function getExpressionOnlyBlockDoc(block: TemplateBlockNode): Doc | undefined {
  const lines = block.content.replace(/\r\n/g, "\n").split("\n");

  while (lines[0] !== undefined && /^\s*$/.test(lines[0])) {
    lines.shift();
  }
  while (lines.at(-1) !== undefined && /^\s*$/.test(lines.at(-1)!)) {
    lines.pop();
  }

  if (lines.length === 0) {
    return undefined;
  }

  const lineDocs: Doc[] = [];
  let expressionCount = 0;

  for (const line of lines) {
    if (/^\s*$/.test(line)) {
      lineDocs.push("");
      continue;
    }

    const markerPattern = new RegExp(INLINE_MARKER_SOURCE, "g");
    const markers = [...line.matchAll(markerPattern)];
    if (markers.length === 0 || !/^\s*$/.test(line.replace(markerPattern, ""))) {
      return undefined;
    }

    const lineDoc: Doc[] = [];
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

  return builders.join(builders.hardline, lineDocs);
}

function getRawBlockText(node: RawBlockNode): string {
  const args = node.args?.trim();
  const endArgs = node.endArgs?.trim();

  if (!node.keyword || node.body === undefined) {
    return node.originalText;
  }

  if (node.keyword === "verbatim" && args) {
    // Normalizing significant inner whitespace could make an earlier raw terminator match next pass.
    const openingEnd = node.originalText.indexOf("%}");
    const openingContent = node.originalText.slice(2, openingEnd).trim();
    if (openingContent !== `verbatim ${args}`) {
      return node.originalText;
    }
  }

  return `{% ${node.keyword}${args ? ` ${args}` : ""} %}${node.body}{% end${node.keyword}${endArgs ? ` ${endArgs}` : ""} %}`;
}

function printRawBlock(node: RawBlockNode): Doc {
  return getRawBlockText(node);
}

function getTranslationBlockText(node: DjangoNode): string | undefined {
  if (
    node.type !== "template-block" ||
    (node.start.keyword !== "blocktranslate" && node.start.keyword !== "blocktrans")
  ) {
    return undefined;
  }

  // Django uses body whitespace (and literal HTML) in gettext keys. Preserve even
  // trimmed bodies: HTML formatting can change more than Django's trimming removes.
  const body = node.originalText.slice(
    node.start.sourceEnd - node.sourceStart,
    node.end.sourceStart - node.sourceStart,
  );
  return `{% ${node.start.content.trim()} %}${body}{% ${node.end.content.trim()} %}`;
}

// Inline layout must preserve literal source gaps, not the spelling of Django tokens.
// Raw, ignored, preformatted, and translation bodies keep their existing stronger protection.
function getInlineBlockText(block: TemplateBlockNode): string {
  if (block.preserveOriginalText) {
    return block.originalText;
  }
  const translation = getTranslationBlockText(block);
  if (translation !== undefined) {
    return translation;
  }

  const parts: string[] = [];
  let cursor = block.sourceStart;
  for (const child of [block.start, ...block.childIds.map((id) => block.nodes[id]), block.end]) {
    parts.push(
      block.originalText.slice(cursor - block.sourceStart, child.sourceStart - block.sourceStart),
    );
    parts.push(
      child.preserveOriginalText
        ? child.originalText
        : child.type === "template-block"
          ? getInlineBlockText(child)
          : child.type === "template-tag"
            ? `{% ${child.content.trim()} %}`
            : child.type === "expression"
              ? formatExpression(child)
              : child.originalText,
    );
    cursor = child.sourceEnd;
  }
  return parts.join("");
}

const inlineBlockTexts = new WeakMap<DjangoNode, string>();

function printTemplateTag(node: TemplateTagNode): Doc {
  const templateTag = `{% ${node.content.trim()} %}`;

  if (getStartTagFormatting(node.keyword) === "trim-leading") {
    return [builders.trim, templateTag];
  }

  if (
    isBranchTag(node.keyword) &&
    node.parentBlockRelationship === "content" &&
    !node.parentBlockInTag &&
    !node.parentBlockInAttribute
  ) {
    return [builders.dedent(builders.hardline), templateTag, builders.hardline];
  }

  if (node.preNewLines > 1) {
    const hasParentBlock = node.parentBlockRelationship !== undefined;
    const standaloneNeedsSpacing =
      node.role === "standalone" &&
      (node.protectedMarkerKind !== "block" || !hasParentBlock || !node.parentBlockHasHtmlMarkup);
    if (standaloneNeedsSpacing) {
      return builders.group([builders.trim, builders.hardline, templateTag]);
    }
  }

  return templateTag;
}

function isSingleElementStandaloneTag(
  node: TemplateBlockNode | { content: string; nodes: Record<string, DjangoNode> },
  segment: string,
): boolean {
  const preserved = segment.trimEnd();
  const [match] = findInlineOnlyStandaloneElements(node, preserved);
  return Boolean(match && match.index === 0 && match.text === preserved);
}

function getWhitespaceSensitiveInlineBody(
  node: TemplateBlockNode | { content: string; nodes: Record<string, DjangoNode> },
  segment: string,
): { start: number; end: number } | undefined {
  const preserved = segment.trimEnd();
  const match = preserved.match(/^<([A-Za-z][^\s/>]*)/);
  const closing = preserved.match(/<\/([A-Za-z][^\s/>]*)\s*>$/);
  const openingEnd = findHtmlTagEnd(preserved, 0);
  if (
    !match ||
    openingEnd === undefined ||
    BLOCK_FLOW_ELEMENTS.has(match[1].toLowerCase()) ||
    /^(script|style|pre|textarea)$/i.test(match[1]) ||
    closing?.[1] !== match[1]
  ) {
    return undefined;
  }

  const body = preserved.slice(openingEnd + 1, preserved.length - closing[0].length);
  if (hasHtmlMarkup(body) || /[\r\n]/.test(body)) {
    return undefined;
  }

  const entries = markerEntries(preserved, node.nodes);
  const hasUnsafeBlock = entries.some(({ id, index }) => {
    const child = node.nodes[id];
    const followingIndex = index + id.length;
    return (
      child?.type === "template-block" &&
      !hasSafeSingleBlockElementBody(child) &&
      /\S/.test(preserved[followingIndex] ?? "") &&
      !preserved.startsWith("</", followingIndex)
    );
  });
  if (!hasUnsafeBlock) {
    return undefined;
  }

  return { start: openingEnd + 1, end: preserved.length - closing[0].length };
}

function isStandaloneDocumentFlowTemplateTag(
  node: TemplateBlockNode | { content: string; nodes: Record<string, DjangoNode> },
  segment: string | undefined,
): boolean {
  if (!segment) {
    return false;
  }

  const currentNode = node.nodes[segment];
  return (
    currentNode?.type === "template-tag" &&
    currentNode.role === "standalone" &&
    currentNode.protectedMarkerKind === "block"
  );
}

function isTemplateBlockSegment(
  node: TemplateBlockNode | { content: string; nodes: Record<string, DjangoNode> },
  segment: string | undefined,
): boolean {
  return Boolean(segment && node.nodes[segment]?.type === "template-block");
}

function segmentHasRenderableText(
  node: TemplateBlockNode | { content: string; nodes: Record<string, DjangoNode> },
  segment: string | undefined,
): boolean {
  if (!segment) {
    return false;
  }

  // Expressions render text, so their markers must count when deciding segment separators.
  const content = segment.replace(new RegExp(ANY_MARKER_SOURCE, "g"), (marker) =>
    node.nodes[marker] && node.nodes[marker].type !== "expression" ? "" : marker,
  );
  return /\S/.test(content);
}

function splitLeadingStandaloneBlockTag(
  node: RootNode | { content: string; nodes: Record<string, DjangoNode> },
): string[] | undefined {
  const match = node.content.match(new RegExp(`^(${BLOCK_MARKER_SOURCE})`));
  if (!match) {
    return undefined;
  }

  const [firstId] = match;
  const firstNode = node.nodes[firstId];
  const rest = node.content.slice(firstId.length);
  const trimmedRest = rest.trimEnd();
  const nextMatch = trimmedRest.match(new RegExp(`^(${BLOCK_MARKER_SOURCE})`));
  if (!nextMatch) {
    return undefined;
  }

  const nextNode = node.nodes[nextMatch[1]];

  if (
    firstNode?.type !== "template-tag" ||
    firstNode.keyword !== "load" ||
    firstNode.role !== "standalone" ||
    firstNode.protectedMarkerKind !== "block" ||
    nextNode?.type !== "template-block" ||
    trimmedRest !== nextMatch[1]
  ) {
    return undefined;
  }

  return [firstId, trimmedRest];
}

function hasLeadingBlankLine(segment: string): boolean {
  const leadingWhitespace = segment.match(/^\s*/)?.[0] ?? "";
  return (leadingWhitespace.match(/\n/g) ?? []).length > 1;
}

function joinSegments(
  node: TemplateBlockNode | { content: string; nodes: Record<string, DjangoNode> },
  segments: string[],
  mapped: Doc[],
): Doc {
  const docs: Doc[] = [];

  for (const [index, segment] of segments.entries()) {
    const previousTrimmedSegment = segments[index - 1]?.trim();
    const previousTrimmedNode = previousTrimmedSegment
      ? node.nodes[previousTrimmedSegment]
      : undefined;
    const previousIsSingleElement = isSingleElementStandaloneTag(node, segments[index - 1] ?? "");
    const currentIsSingleElement = isSingleElementStandaloneTag(node, segment);
    if (
      index > 0 &&
      (previousIsSingleElement ||
        (currentIsSingleElement && previousTrimmedNode?.type !== "template-tag"))
    ) {
      docs.push(builders.trim, builders.hardline);
    } else if (
      isStandaloneDocumentFlowTemplateTag(node, segment) &&
      (segmentHasRenderableText(node, segments[index - 1]) ||
        isTemplateBlockSegment(node, segments[index - 1]))
    ) {
      docs.push(builders.hardline);
    }

    docs.push(mapped[index]);

    const nextSegment = segments[index + 1];
    if (
      isStandaloneDocumentFlowTemplateTag(node, segment) &&
      (segmentHasRenderableText(node, nextSegment) || isTemplateBlockSegment(node, nextSegment))
    ) {
      docs.push(builders.hardline);
      if (segmentHasRenderableText(node, nextSegment) && hasLeadingBlankLine(nextSegment)) {
        docs.push(builders.hardline);
      }
    }
  }

  return docs;
}

function splitStartTagAttributes(content: string): string[] {
  const attributes: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (const char of content) {
    if (quote) {
      current += char;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        attributes.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    attributes.push(current);
  }

  return attributes;
}

function getStartTagTemplateBlockDoc(
  path: AstPath<DjangoNode>,
  print: (selector?: string | number | Array<string | number> | AstPath<DjangoNode>) => Doc,
  block: TemplateBlockNode,
): Doc {
  const docs: Doc[] = [];

  for (const attribute of splitStartTagAttributes(block.content)) {
    const attributeNode = block.nodes[attribute];
    if (attributeNode?.type === "template-tag" && attributeNode.role === "branch") {
      docs.push(builders.dedent([builders.hardline, path.call(print, "nodes", attribute)]));
      continue;
    }

    if (docs.length > 0) {
      docs.push(builders.hardline);
    }

    let cursor = 0;
    for (const { id, index } of markerEntries(attribute, block.nodes)) {
      if (index > cursor) {
        docs.push(attribute.slice(cursor, index));
      }
      docs.push(path.call(print, "nodes", id));
      cursor = index + id.length;
    }
    if (cursor < attribute.length) {
      docs.push(attribute.slice(cursor));
    }
  }

  return docs;
}

const HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const BLOCK_FLOW_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figure",
  "footer",
  "form",
  "head",
  "header",
  "hgroup",
  "html",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "section",
  "select",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

function expandTemplateHtml(node: RootNode | TemplateBlockNode, segment: string): string {
  return segment.replace(new RegExp(ANY_MARKER_SOURCE, "g"), (id) => {
    const child = node.nodes[id];
    if (child?.type === "template-block" && !child.inTag && !child.inAttribute) {
      return expandTemplateHtml(child, child.content);
    }
    return id;
  });
}

function getTemplateHtmlFragmentBalance(
  node: RootNode | TemplateBlockNode,
  segment: string,
  includeChildren = false,
) {
  // Start-tag constructs can touch the element name. They are attributes, not part of that name.
  const html = (includeChildren ? expandTemplateHtml(node, segment) : segment).replace(
    new RegExp(ATTRIBUTE_MARKER_SOURCE, "g"),
    (id) => (node.nodes[id] ? ` ${id}` : id),
  );
  return getHtmlFragmentBalance(html);
}

function hasUnbalancedHtml(node: RootNode | TemplateBlockNode, includeChildren = false): boolean {
  return splitAtTemplateTags(node).some((segment) => {
    const balance = getTemplateHtmlFragmentBalance(node, segment, includeChildren);
    return !balance || balance.unclosed.length > 0 || balance.unexpectedClosings.length > 0;
  });
}

function hasAmbiguousHtmlBranches(node: RootNode | TemplateBlockNode): boolean {
  const segments = splitAtTemplateTags(node);
  if (segments.length > 1) {
    const balances = segments.map((segment) => getTemplateHtmlFragmentBalance(node, segment));
    if (
      balances.some((balance) => balance && balance.unclosed.length > 0) &&
      balances.some((balance) => balance && balance.unexpectedClosings.length > 0)
    ) {
      // An opening in one branch cannot balance a closing in another. Its effects on
      // following content are ambiguous, even if concatenating all branches looks balanced.
      return true;
    }
  }
  return markerEntries(node.content, node.nodes).some(({ id }) => {
    const child = node.nodes[id];
    return (
      child.type === "template-block" &&
      !child.inTag &&
      !child.inAttribute &&
      hasAmbiguousHtmlBranches(child)
    );
  });
}

function hasUnbalancedHtmlChild(node: RootNode | TemplateBlockNode): boolean {
  return markerEntries(node.content, node.nodes).some(({ id }) => {
    const child = node.nodes[id];
    return (
      child.type === "template-block" &&
      !child.inTag &&
      !child.inAttribute &&
      (hasUnbalancedHtml(child) || hasUnbalancedHtml(child, true))
    );
  });
}

/**
 * Hiding a conditional <pre>, <textarea>, or inline wrapper from the HTML parser also
 * hides its whitespace context. Protect the entire affected range, not just its tags.
 * Block-flow wrappers need no such range: their balanced interior can still be formatted.
 */
function protectConditionalHtmlWhitespace(
  node: RootNode | TemplateBlockNode,
  markerAllocator: InternalMarkerAllocator,
  source: string,
): boolean {
  const ranges: Array<{ start: number; end: number; sourceStart: number; sourceEnd: number }> = [];
  const openElements: string[] = [];
  let rangeStart: { index: number; sourceStart: number } | undefined;

  for (const { id, index } of markerEntries(node.content, node.nodes)) {
    const child = node.nodes[id];
    if (child.type !== "template-block" || child.inTag || child.inAttribute) {
      continue;
    }

    for (const segment of splitAtTemplateTags(child)) {
      const balance = getTemplateHtmlFragmentBalance(child, segment, true);
      if (!balance) {
        return false;
      }
      const openings = balance.unclosed.filter((name) => !BLOCK_FLOW_ELEMENTS.has(name));
      const closings = balance.unexpectedClosings.filter((name) => !BLOCK_FLOW_ELEMENTS.has(name));
      if (openings.length > 0 && !rangeStart) {
        rangeStart = { index, sourceStart: child.sourceStart };
      }
      openElements.push(...openings);
      for (const name of closings) {
        const matchingIndex = openElements.lastIndexOf(name);
        if (matchingIndex === -1) {
          return false;
        }
        openElements.splice(matchingIndex, 1);
      }
    }

    if (rangeStart && openElements.length === 0) {
      ranges.push({
        start: rangeStart.index,
        end: index + id.length,
        sourceStart: rangeStart.sourceStart,
        sourceEnd: child.sourceEnd,
      });
      rangeStart = undefined;
    }
  }

  // Without a complete range, neither the remaining HTML nor its whitespace context is known.
  if (rangeStart) {
    return false;
  }

  for (const range of ranges.reverse()) {
    const originalText = source.slice(range.sourceStart, range.sourceEnd);
    const id = markerAllocator.allocate("inline");
    node.nodes[id] = {
      type: "raw-block",
      id,
      content: originalText,
      originalText,
      body: originalText,
      preNewLines: 0,
      sourceStart: range.sourceStart,
      sourceEnd: range.sourceEnd,
      protectedMarkerKind: "inline",
    };
    node.content = node.content.slice(0, range.start) + id + node.content.slice(range.end);
  }
  if (ranges.length > 0 && node.type === "template-block") {
    node.childIds = markerEntries(node.content, node.nodes).map(({ id }) => id);
  }
  return true;
}

function hasSafeSingleBlockElementBody(block: TemplateBlockNode): boolean {
  const match = block.content.match(
    new RegExp(`^\\s*<([A-Za-z][^\\s/>]*)(?:[^>]*)>\\s*(${INLINE_MARKER_SOURCE})\\s*<\\/\\1>\\s*$`),
  );
  if (!match || !BLOCK_FLOW_ELEMENTS.has(match[1].toLowerCase())) {
    return false;
  }

  return block.nodes[match[2]]?.type === "expression";
}

function hasAdjacentInlineExpressionBefore(
  container: TemplateBlockNode | { content: string; nodes: Record<string, DjangoNode> },
  previousId: string | undefined,
): boolean {
  return previousId ? container.nodes[previousId]?.type === "expression" : false;
}

function buildBlock(
  path: AstPath<DjangoNode>,
  print: (selector?: string | number | Array<string | number> | AstPath<DjangoNode>) => Doc,
  block: TemplateBlockNode,
  mapped: Doc,
  preserveMappedIndentation = false,
): Doc {
  if (/^\s*$/.test(block.content)) {
    return builders.group([
      path.call(print, "nodes", block.start.id),
      block.inTag || block.inAttribute ? builders.softline : "",
      path.call(print, "nodes", block.end.id),
    ]);
  }

  if (!block.inAttribute && (!block.inTag || block.containsNewLines)) {
    return builders.group([
      path.call(print, "nodes", block.start.id),
      preserveMappedIndentation
        ? [builders.hardline, mapped]
        : builders.indent([builders.hardline, mapped]),
      builders.hardline,
      path.call(print, "nodes", block.end.id),
    ]);
  }

  return builders.group([
    path.call(print, "nodes", block.start.id),
    mapped,
    path.call(print, "nodes", block.end.id),
  ]);
}

export const print: Printer<DjangoNode>["print"] = (path) => {
  const node = path.getNode();
  if (!node) {
    return "";
  }

  switch (node.type) {
    case "expression":
      return formatExpression(node);
    case "template-tag":
      return printTemplateTag(node);
    case "comment":
      return node.originalText;
    case "raw-block":
      return printRawBlock(node);
    case "ignore-region":
      return node.originalText;
    default:
      return node.originalText;
  }
};

function isStandaloneBlockLikeNode(
  node: DjangoNode | undefined,
): node is TemplateTagNode | TemplateBlockNode {
  if (!node) {
    return false;
  }

  if (node.type === "template-tag") {
    return node.role === "standalone" && node.protectedMarkerKind === "block";
  }

  return node.type === "template-block" && node.protectedMarkerKind === "block";
}

function getStandaloneLeadingSpacing(
  container: TemplateBlockNode | { content: string; nodes: Record<string, DjangoNode> },
  currentNode: DjangoNode,
  previousId: string | undefined,
  containerHasHtmlMarkup: boolean,
): Doc | undefined {
  if (!isStandaloneBlockLikeNode(currentNode)) {
    return undefined;
  }

  const previousNode = previousId ? container.nodes[previousId] : undefined;

  if (containerHasHtmlMarkup) {
    return undefined;
  }

  if (!isStandaloneBlockLikeNode(previousNode)) {
    return undefined;
  }

  if (previousNode.type === "template-block") {
    return undefined;
  }

  if (currentNode.preNewLines > 1) {
    return [builders.hardline, builders.hardline];
  }

  if (currentNode.preNewLines === 1) {
    return builders.hardline;
  }

  return previousNode.type === "template-tag" && previousNode.keyword === "extends"
    ? builders.hardline
    : undefined;
}

function shouldInlineWithFollowingProtectedMarker(
  container: TemplateBlockNode | { content: string; nodes: Record<string, DjangoNode> },
  currentNode: DjangoNode,
  nextId: string | undefined,
  gapAfter: string | undefined,
): boolean {
  if (
    currentNode.type !== "template-tag" ||
    currentNode.role !== "standalone" ||
    currentNode.protectedMarkerKind !== "block"
  ) {
    return false;
  }

  const nextNode = nextId ? container.nodes[nextId] : undefined;

  return (
    Boolean(gapAfter) &&
    nextNode?.type === "template-tag" &&
    nextNode.role === "standalone" &&
    nextNode.protectedMarkerKind === "block"
  );
}

function getInlineProtectedMarkerPairs(content: string): Set<string> {
  const pairs = new Set<string>();
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const protectedMarkers = line.match(new RegExp(PROTECTED_MARKER_SOURCE, "g")) ?? [];
    if (protectedMarkers.length < 2 || !/[ \t]/.test(line)) {
      continue;
    }
    for (let index = 0; index < protectedMarkers.length - 1; index += 1) {
      pairs.add(`${protectedMarkers[index]}\0${protectedMarkers[index + 1]}`);
    }
  }
  return pairs;
}

function restoreInlineProtectedMarkerRuns(currentDoc: string, pairs: Set<string>): string {
  const markers = [...currentDoc.matchAll(new RegExp(PROTECTED_MARKER_SOURCE, "g"))];
  const parts: string[] = [];
  let cursor = 0;

  for (let index = 0; index < markers.length - 1; index += 1) {
    const left = markers[index];
    const right = markers[index + 1];
    const gapStart = left.index + left[0].length;
    const gap = currentDoc.slice(gapStart, right.index);
    if (!/^\s*\n\s*$/.test(gap) || !pairs.has(`${left[0]}\0${right[0]}`)) {
      continue;
    }

    parts.push(currentDoc.slice(cursor, gapStart), " ");
    cursor = right.index;
  }

  parts.push(currentDoc.slice(cursor));
  return parts.join("");
}

function isInlineHtmlElement(name: string | undefined): boolean {
  return Boolean(name && !BLOCK_FLOW_ELEMENTS.has(name));
}

// This legacy generic pass handles unrelated document-flow boundaries. Whitespace-sensitive inline
// flow is built as a Doc above and deliberately excluded from this post-render normalization.
function normalizeAdjacentDocumentFlowConstructs(value: string): string {
  const hostContexts = scanHtmlHostContexts(value);

  return value.replace(/%}(?={% )|\}\}(?={% )/g, (boundary, offset: number) => {
    const nextKeyword = value.slice(offset + boundary.length).match(/^{%\s+(\S+)/)?.[1] ?? "";
    const isFormattingBoundary =
      boundary === "}}"
        ? startsDocumentFlowAfterExpression(nextKeyword)
        : startsDocumentFlowAfterTag(nextKeyword);

    return !isFormattingBoundary ||
      hostContexts.at(offset) !== "document-flow" ||
      !hostContexts.isDocumentFlowNormalizationSafeAt(offset) ||
      isInlineHtmlElement(hostContexts.elementAt(offset))
      ? boundary
      : `${boundary}\n`;
  });
}

function normalizeHtmlAroundProtectedMarkers(currentDoc: string): string {
  return currentDoc
    .replace(/(<[^/!][^<>]*?)\s*\n\s*>/g, "$1>")
    .replace(/<\/([^>\s]+)\s*\n\s*>/g, "</$1>")
    .replace(new RegExp(`(<\\/[^>]+>)(${BLOCK_MARKER_SOURCE})`, "g"), "$1\n$2")
    .replace(
      new RegExp(
        `^(?<indent>\\s*)(?<open><([A-Za-z][^\\s/>]*)(?:[^>]*)>)(?<body>${INLINE_MARKER_SOURCE})(?<close><\\/\\3>)(?<trail>\\s*)$`,
        "gm",
      ),
      (match, indent, open, tagName, body, close, trail) => {
        if (/^(pre|textarea)$/i.test(tagName) || (open.match(/\s+\S+=/g) ?? []).length <= 1) {
          return match;
        }

        return `${indent}${open}\n${indent}  ${body}\n${indent}${close}${trail}`;
      },
    );
}

function prepareSegmentForHtml(
  node: RootNode | TemplateBlockNode,
  segment: string,
  markerAllocator: InternalMarkerAllocator,
) {
  const beforeReplacements: Array<{ token: string; value: string }> = [];
  // Protect only the sensitive body or standalone construct. The surrounding HTML
  // must still reach Prettier so quote, spacing, width, and attribute options apply.
  let protectedSegment = segment;
  const sensitiveBody = getWhitespaceSensitiveInlineBody(node, segment);
  const standalone = isSingleElementStandaloneTag(node, segment)
    ? findInlineOnlyStandaloneElements(node, segment)[0]
    : undefined;
  const protectedRange =
    sensitiveBody ??
    (standalone
      ? {
          start: segment.indexOf(standalone.marker),
          end: segment.indexOf(standalone.marker) + standalone.marker.length,
        }
      : undefined);
  if (protectedRange) {
    const token = markerAllocator.allocate("inline");
    beforeReplacements.push({
      token,
      value: segment.slice(protectedRange.start, protectedRange.end),
    });
    protectedSegment =
      segment.slice(0, protectedRange.start) + token + segment.slice(protectedRange.end);
  }

  let prepared = protectedSegment.replace(
    new RegExp(`((${PROTECTED_MARKER_SOURCE})(?:[ \\t]+${PROTECTED_MARKER_SOURCE})+)`, "g"),
    (run) => {
      if (containsBlockMarker(run)) {
        return run;
      }

      const token = markerAllocator.allocate("temporary-run");
      beforeReplacements.push({ token, value: run });
      return token;
    },
  );

  prepared = prepared
    .replace(new RegExp(`(<[A-Za-z][^\\s/>]*)(${ATTRIBUTE_MARKER_SOURCE})`, "g"), "$1 $2")
    .replace(new RegExp(`(${BLOCK_MARKER_SOURCE})(${BLOCK_MARKER_SOURCE})`, "g"), "$1\n$2")
    .replace(new RegExp(`(<\\/[^>]+>)(${BLOCK_MARKER_SOURCE})`, "g"), "$1\n$2")
    .replace(
      new RegExp(
        `^(?<open><([A-Za-z][^\\s/>]*)(?:[^>]*)>)(?<body>${INLINE_MARKER_SOURCE})(?<close><\\/\\2>)(?<trail>\\s*)$`,
      ),
      (match, open, tagName, body, close, trail) =>
        !/^(pre|textarea)$/i.test(tagName) && (open.match(/\s+\S+=/g) ?? []).length > 1
          ? `${open}\n  ${body}\n${close}${trail}`
          : match,
    );

  return {
    segment: prepared,
    beforeReplacements,
    standaloneMarker: standalone?.marker,
    sensitiveBody,
  };
}

// Root and template blocks share this dictionary. Weak ownership keeps separate format
// calls isolated and releases the allocator with the AST, including all temporary markers.
const documentMarkerAllocators = new WeakMap<Record<string, DjangoNode>, InternalMarkerAllocator>();

function getDocumentMarkerAllocator(
  nodes: Record<string, DjangoNode>,
  originalText: string,
): InternalMarkerAllocator {
  let allocator = documentMarkerAllocators.get(nodes);
  if (!allocator) {
    allocator = new InternalMarkerAllocator(originalText);
    allocator.reserve(Object.keys(nodes));
    documentMarkerAllocators.set(nodes, allocator);
  }
  return allocator;
}

export const embed: Printer<DjangoNode>["embed"] = () => {
  return async (
    textToDoc: (text: string, options: Options) => Promise<Doc>,
    print: (selector?: string | number | Array<string | number> | AstPath<DjangoNode>) => Doc,
    path: AstPath<DjangoNode>,
    options: Options,
  ): Promise<Doc | undefined> => {
    const node = path.getNode();
    if (!node || (node.type !== "root" && node.type !== "template-block")) {
      return undefined;
    }

    if (node.preserveOriginalText) {
      return node.originalText;
    }

    const translationBlockText = getTranslationBlockText(node);
    if (translationBlockText !== undefined) {
      return translationBlockText;
    }

    // Prettier's public Options type leaves plugin-owned fields unknown, so validate this boundary.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    if (typeof options.originalText !== "string") {
      throw new TypeError("Prettier did not provide the complete original source.");
    }
    const markerAllocator = getDocumentMarkerAllocator(node.nodes, options.originalText);
    if (
      !node.inTag &&
      !node.inAttribute &&
      (hasAmbiguousHtmlBranches(node) ||
        ((node.type === "template-block" || hasUnbalancedHtmlChild(node)) &&
          hasUnbalancedHtml(node)) ||
        (node.type === "template-block" && hasUnbalancedHtml(node, true)) ||
        !protectConditionalHtmlWhitespace(node, markerAllocator, options.originalText))
    ) {
      node.preserveOriginalText = true;
      return node.type === "root" && !node.originalText.endsWith("\n")
        ? [node.originalText, builders.hardline]
        : node.originalText;
    }

    const hostContexts = scanHtmlHostContexts(node.content);
    const containerHasHtmlMarkup = hasHtmlMarkup(node.content);
    const inlineProtectedMarkerPairs = getInlineProtectedMarkerPairs(node.content);
    const sourceMarkerEntries = markerEntries(node.content, node.nodes);
    const markerContexts = new Map<
      string,
      {
        index: number;
        previousId?: string;
        nextId?: string;
        gapBefore: string;
        gapAfter?: string;
      }
    >();
    for (const [index, entry] of sourceMarkerEntries.entries()) {
      const previous = sourceMarkerEntries[index - 1];
      const next = sourceMarkerEntries[index + 1];
      let whitespaceStart = entry.index;
      while (whitespaceStart > 0 && /\s/.test(node.content[whitespaceStart - 1])) {
        whitespaceStart -= 1;
      }
      const gapBefore = node.content.slice(whitespaceStart, entry.index);
      const previousId =
        previous?.index + previous?.id.length === whitespaceStart ? previous.id : undefined;
      const betweenNext = next
        ? node.content.slice(entry.index + entry.id.length, next.index)
        : undefined;
      markerContexts.set(entry.id, {
        index: entry.index,
        previousId,
        nextId: next && /^[ \t]+$/.test(betweenNext ?? "") ? next.id : undefined,
        gapBefore,
        gapAfter: next && /^[ \t]+$/.test(betweenNext ?? "") ? betweenNext : undefined,
      });
    }
    if (node.type === "template-block") {
      const expressionOnlyBlockDoc = getExpressionOnlyBlockDoc(node);
      if (expressionOnlyBlockDoc) {
        return buildBlock(path, print, node, expressionOnlyBlockDoc, true);
      }

      if (node.inTag && !node.inAttribute && node.containsNewLines) {
        return buildBlock(path, print, node, getStartTagTemplateBlockDoc(path, print, node));
      }
    }

    const leadingStandaloneSplit =
      node.type === "root" ? splitLeadingStandaloneBlockTag(node) : undefined;
    if (
      leadingStandaloneSplit &&
      node.nodes[leadingStandaloneSplit[1]]?.type === "template-block"
    ) {
      return [
        path.call(print, "nodes", leadingStandaloneSplit[0]),
        builders.hardline,
        path.call(print, "nodes", leadingStandaloneSplit[1]),
        builders.hardline,
      ];
    }

    const splitSegments = leadingStandaloneSplit ?? splitAtTemplateTags(node);
    const segments =
      node.type === "root"
        ? splitTopLevelInlineOnlyStandaloneElements(node, splitSegments)
        : splitSegments;
    const mapped = await Promise.all(
      segments.map(async (segment) => {
        const preparedSegment = prepareSegmentForHtml(node, segment, markerAllocator);
        const doc = node.nodes[segment]
          ? segment
          : await textToDoc(preparedSegment.segment, {
              ...options,
              parser: "html",
              htmlWhitespaceSensitivity: preparedSegment.sensitiveBody
                ? "strict"
                : options.htmlWhitespaceSensitivity,
            });

        let ignoreDoc = false;

        return mapDoc(doc, (currentDoc) => {
          // A Prettier Doc is a documented union with strings as its only text representation.
          // oxlint-disable-next-line anti-slop/no-runtime-typeof
          if (typeof currentDoc !== "string") {
            return currentDoc;
          }

          if (currentDoc === "<!-- prettier-ignore -->") {
            ignoreDoc = true;
            return currentDoc;
          }

          for (const replacement of preparedSegment.beforeReplacements) {
            currentDoc = markerAllocator.restore(currentDoc, replacement.token, replacement.value);
          }

          const currentString = currentDoc;
          if (!containsProtectedNodeMarker(currentString, node.nodes)) {
            ignoreDoc = false;
            return currentDoc;
          }

          // Preformatted text can contain literal tag-like text as well as markers.
          // Do not run HTML/whitespace rewrites over a string containing preserved source.
          const containsPreservedSource = markerEntries(currentDoc, node.nodes).some(
            ({ id }) => node.nodes[id].preserveOriginalText,
          );
          if (!containsPreservedSource) {
            currentDoc = normalizeHtmlAroundProtectedMarkers(
              restoreInlineProtectedMarkerRuns(currentDoc, inlineProtectedMarkerPairs),
            );
          }

          return replaceProtectedMarkersInString(currentDoc, node.nodes, (id, context) => {
            const currentNode = node.nodes[id];
            // This construct is the entire element body, not a document-flow boundary.
            if (id === preparedSegment.standaloneMarker && currentNode.type === "template-tag") {
              return { doc: printTemplateTag(currentNode) };
            }
            const markerContext = markerContexts.get(id);
            const sourceMarkerIndex = markerContext?.index ?? -1;
            // Block layout whitespace becomes rendered text in inline HTML, with or
            // without branches. Keep the block's original whitespace in this context.
            const preserveInlineBlock =
              currentNode.type === "template-block" &&
              !currentNode.inTag &&
              !currentNode.inAttribute &&
              isInlineHtmlElement(hostContexts.elementAt(sourceMarkerIndex));
            if (ignoreDoc || currentNode.preserveOriginalText) {
              currentNode.preserveOriginalText = true;
              return { doc: currentNode.originalText };
            }
            if (preserveInlineBlock) {
              const text = getInlineBlockText(currentNode);
              inlineBlockTexts.set(currentNode, text);
              return { doc: text };
            }

            const followsInlineExpressionInElement =
              currentNode.type === "template-block" &&
              hasSafeSingleBlockElementBody(currentNode) &&
              hasAdjacentInlineExpressionBefore(node, markerContext?.previousId) &&
              hostContexts.elementAt(sourceMarkerIndex) !== undefined;
            const rendered = path.call(print, "nodes", id);
            const leadingSpacing = getStandaloneLeadingSpacing(
              node,
              currentNode,
              markerContext?.previousId,
              containerHasHtmlMarkup,
            );
            const sourceGapBefore = markerContext?.gapBefore;
            const restored =
              followsInlineExpressionInElement && !sourceGapBefore?.includes("\n")
                ? [builders.trim, builders.hardline, rendered]
                : leadingSpacing
                  ? [builders.trim, leadingSpacing, rendered]
                  : rendered;
            if (
              currentNode.type === "template-tag" &&
              currentNode.role === "standalone" &&
              currentNode.protectedMarkerKind === "block"
            ) {
              const inlineWithNext = shouldInlineWithFollowingProtectedMarker(
                node,
                currentNode,
                markerContext?.nextId,
                markerContext?.gapAfter,
              );
              return {
                doc: [
                  printDocumentFlowNode(
                    restored,
                    context.linePrefix,
                    context.lineSuffix,
                    inlineWithNext,
                    context.hasProtectedMarkerOnNextLine,
                  ),
                  inlineWithNext ? " " : "",
                ],
                trimLeadingWhitespace: Boolean(leadingSpacing),
                trimFollowingWhitespace: inlineWithNext,
              };
            }

            if (
              currentNode.type === "template-block" &&
              /<\/[^>]+>\s*$/.test(stripProtectedMarkerContext(context.linePrefix))
            ) {
              return {
                doc: printDocumentFlowNode(restored, context.linePrefix, context.lineSuffix),
                trimLeadingWhitespace: Boolean(leadingSpacing),
              };
            }

            return {
              doc: restored,
              trimLeadingWhitespace:
                Boolean(leadingSpacing) ||
                (currentNode.type === "template-tag" &&
                  getStartTagFormatting(currentNode.keyword) === "trim-leading"),
            };
          });
        });
      }),
    );

    const joined = joinSegments(node, segments, mapped);

    if (node.type === "template-block") {
      return buildBlock(path, print, node, joined);
    }

    const endingPreservedNode = Object.values(node.nodes).find((child) => {
      if (child.type !== "raw-block" && child.type !== "ignore-region") {
        return false;
      }

      const markerIndex = node.content.lastIndexOf(child.id);
      return markerIndex !== -1 && /^\s*$/.test(node.content.slice(markerIndex + child.id.length));
    });
    const endsWithUnclosedIgnoreRegion =
      endingPreservedNode?.type === "ignore-region" && !endingPreservedNode.closed;
    const endsWithUnclosedPreservedRegion =
      (endingPreservedNode?.type === "raw-block" && endingPreservedNode.body === undefined) ||
      endsWithUnclosedIgnoreRegion;
    const { formatted } = printDocToString(
      [joined, endsWithUnclosedPreservedRegion ? "" : builders.hardline],
      {
        printWidth: options.printWidth ?? 80,
        tabWidth: options.tabWidth ?? 2,
        useTabs: options.useTabs,
      },
    );

    const preservedReplacements: Array<{ token: string; value: string }> = [];
    let protectedFormatted = formatted;
    // Larger protected ranges can contain individual preserved fragments. Hide the range first.
    const preservedNodes = Object.values(node.nodes)
      .filter(
        (child) =>
          child.preserveOriginalText ||
          inlineBlockTexts.has(child) ||
          child.type === "raw-block" ||
          child.type === "ignore-region" ||
          getTranslationBlockText(child) !== undefined,
      )
      .sort((left, right) => right.originalText.length - left.originalText.length);
    for (const child of preservedNodes) {
      const preservedText =
        inlineBlockTexts.get(child) ??
        (child.preserveOriginalText
          ? child.originalText
          : child.type === "raw-block"
            ? getRawBlockText(child)
            : child.type === "ignore-region"
              ? child.originalText
              : getTranslationBlockText(child));
      if (!preservedText || !protectedFormatted.includes(preservedText)) {
        continue;
      }

      const token = markerAllocator.allocate("temporary-run");
      protectedFormatted = protectedFormatted.replace(preservedText, token);
      preservedReplacements.push({ token, value: preservedText });
    }

    let normalized = normalizeAdjacentDocumentFlowConstructs(protectedFormatted);

    for (const replacement of preservedReplacements) {
      normalized = markerAllocator.restore(normalized, replacement.token, replacement.value);
    }

    return normalized;
  };
};

export function getVisitorKeys(ast: DjangoNode | Record<string, DjangoNode>): string[] {
  if ("type" in ast) {
    return ast.type === "root" ? ["nodes"] : [];
  }

  return Object.values(ast)
    .filter((node) => node.type === "template-block")
    .map((node) => node.id);
}
