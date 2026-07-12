import type { AstPath, Doc, Options, Printer } from "prettier";
import { doc } from "prettier";
import {
  ATTRIBUTE_MARKER_SOURCE,
  BLOCK_MARKER_SOURCE,
  escapeMarkerForRegExp,
  INLINE_MARKER_SOURCE,
  InternalMarkerAllocator,
  PROTECTED_MARKER_SOURCE,
} from "./internal-markers.js";
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

function getProtectedMarkerIds(
  node: TemplateBlockNode | { nodes: Record<string, DjangoNode> },
): string[] {
  return Object.keys(node.nodes).sort((left, right) => right.length - left.length);
}

function replaceProtectedMarkersInString(
  currentDoc: string,
  ids: string[],
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

  while (cursor < currentDoc.length) {
    let matchedId: string | undefined;
    let matchedIndex = currentDoc.length;

    for (const id of ids) {
      const index = currentDoc.indexOf(id, cursor);
      if (index !== -1 && index < matchedIndex) {
        matchedId = id;
        matchedIndex = index;
      }
    }

    if (!matchedId) {
      parts.push(currentDoc.slice(cursor));
      break;
    }

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

  return parts;
}

function hasHtmlMarkup(content: string): boolean {
  return /<(?!!--)[A-Za-z/!][^>]*>/.test(content);
}

function getPreservedSingleLineHtmlSegment(
  node: TemplateBlockNode | { content: string; nodes: Record<string, DjangoNode> },
  segment: string,
): string | undefined {
  const trimmedSegment = segment.trimEnd();
  if (trimmedSegment.includes("\n")) {
    return undefined;
  }

  const match = trimmedSegment.match(/^<([A-Za-z][^\s/>]*)(?<attrs>[^>]*)>(?<body>[^<]*)<\/\1>$/);
  if (!match?.groups) {
    return undefined;
  }

  const attrAssignments = (match.groups.attrs.match(/=\s*"[^"]*"/g) ?? []).length;
  if (attrAssignments > 1) {
    return undefined;
  }

  const bodyProtectedMarkers = match.groups.body.match(new RegExp(INLINE_MARKER_SOURCE, "g")) ?? [];
  if (bodyProtectedMarkers.length !== 1 || match.groups.body.trim() !== bodyProtectedMarkers[0]) {
    return undefined;
  }

  const segmentNodes = Object.values(node.nodes).filter((entry) =>
    trimmedSegment.includes(entry.id),
  );
  return segmentNodes.every((entry) => entry.protectedMarkerKind === "inline")
    ? trimmedSegment
    : undefined;
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

function isBalancedTopLevelHtml(content: string): boolean {
  const stack: string[] = [];
  const rawTextElements = new Set(["script", "style", "template"]);
  let cursor = 0;

  while (cursor < content.length) {
    if (content.startsWith("<!--", cursor)) {
      const commentEnd = content.indexOf("-->", cursor + 4);
      if (commentEnd === -1) {
        return false;
      }
      cursor = commentEnd + 3;
      continue;
    }

    const currentRawElement = stack.at(-1);
    if (currentRawElement && rawTextElements.has(currentRawElement)) {
      const rawEnd = new RegExp(`</${currentRawElement}\\s*>`, "gi");
      rawEnd.lastIndex = cursor;
      const match = rawEnd.exec(content);
      if (!match) {
        return false;
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
        return false;
      }
      cursor = commentEnd + 3;
      continue;
    }
    if (content.startsWith("<!", tagStart) || content.startsWith("<?", tagStart)) {
      const declarationEnd = content.indexOf(">", tagStart + 2);
      if (declarationEnd === -1) {
        return false;
      }
      cursor = declarationEnd + 1;
      continue;
    }

    const tagEnd = findHtmlTagEnd(content, tagStart);
    if (tagEnd === undefined) {
      return false;
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
        return false;
      }
      stack.pop();
    } else if (!/\/\s*>$/.test(tagText) && !HTML_VOID_ELEMENTS.has(name)) {
      stack.push(name);
    }
    cursor = tagEnd + 1;
  }

  return stack.length === 0;
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
  const splitters = Object.values(node.nodes)
    .filter(
      (entry): entry is TemplateTagNode =>
        entry.type === "template-tag" &&
        !entry.inTag &&
        !entry.inAttribute &&
        (["else", "elif", "empty", "plural"].includes(entry.keyword) ||
          ((splitStandaloneTemplateTags || node.content.startsWith(entry.id)) &&
            entry.role === "standalone" &&
            entry.protectedMarkerKind === "block")),
    )
    .filter((entry) => node.content.includes(entry.id));

  if (splitters.length === 0) {
    return [node.content];
  }

  const pattern = new RegExp(
    `(${splitters.map((entry) => escapeMarkerForRegExp(entry.id)).join("|")})`,
  );
  return node.content.split(pattern).filter(Boolean);
}

function surroundingTemplateBlock(node: DjangoNode): TemplateBlockNode | undefined {
  return Object.values(node.nodes).find(
    (entry): entry is TemplateBlockNode =>
      entry.type === "template-block" && entry.content.includes(node.id),
  );
}

function parentTemplateBlock(node: DjangoNode): TemplateBlockNode | undefined {
  return Object.values(node.nodes).find(
    (entry): entry is TemplateBlockNode =>
      entry.type === "template-block" &&
      (entry.content.includes(node.id) || entry.end.id === node.id),
  );
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

function printExpression(node: ExpressionNode): Doc {
  const expression = formatExpression(node);
  if (node.preNewLines > 1) {
    return builders.group([builders.trim, builders.hardline, expression]);
  }
  return expression;
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

function printTemplateTag(node: TemplateTagNode): Doc {
  const templateTag = `{% ${node.content.trim()} %}`;
  const block = surroundingTemplateBlock(node);

  if (node.keyword === "html_attrs") {
    return [builders.trim, templateTag];
  }

  if (
    ["else", "elif", "empty", "plural"].includes(node.keyword) &&
    block &&
    !block.inTag &&
    !block.inAttribute
  ) {
    return [builders.dedent(builders.hardline), templateTag, builders.hardline];
  }

  if (node.preNewLines > 1) {
    const block = parentTemplateBlock(node);
    const standaloneNeedsSpacing =
      node.role === "standalone" &&
      (node.protectedMarkerKind !== "block" || !block || !hasHtmlMarkup(block.content));
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
  if (preserved.includes("\n")) {
    return false;
  }

  const [match] = findInlineOnlyStandaloneElements(node, preserved);
  return Boolean(match && match.index === 0 && match.text === preserved);
}

function getWhitespaceSensitiveInlineElementDoc(
  node: TemplateBlockNode | { content: string; nodes: Record<string, DjangoNode> },
  segment: string,
): Doc | undefined {
  const preserved = segment.trimEnd();
  if (preserved.includes("\n") || preserved.includes("\r")) {
    return undefined;
  }

  const match = preserved.match(/^<([A-Za-z][^\s/>]*)(?:[^>]*)>([\s\S]*)<\/\1>$/);
  if (!match || BLOCK_FLOW_ELEMENTS.has(match[1].toLowerCase())) {
    return undefined;
  }

  const ids = getProtectedMarkerIds(node);
  const unsafeBlockIds = ids.filter((id) => {
    const child = node.nodes[id];
    const markerIndex = preserved.indexOf(id);
    const followingContent = preserved.slice(markerIndex + id.length);
    return (
      child?.type === "template-block" &&
      markerIndex !== -1 &&
      !hasSafeSingleBlockElementBody(child) &&
      /^\S/.test(followingContent) &&
      !followingContent.startsWith("</")
    );
  });
  if (unsafeBlockIds.length === 0) {
    return undefined;
  }

  const parts: Doc[] = [];
  let cursor = 0;
  while (cursor < preserved.length) {
    let matchedId: string | undefined;
    let matchedIndex = preserved.length;
    for (const id of ids) {
      const index = preserved.indexOf(id, cursor);
      if (index !== -1 && index < matchedIndex) {
        matchedId = id;
        matchedIndex = index;
      }
    }

    if (!matchedId) {
      parts.push(preserved.slice(cursor));
      break;
    }
    parts.push(preserved.slice(cursor, matchedIndex));
    const child = node.nodes[matchedId];
    parts.push(child.type === "expression" ? formatExpression(child) : child.originalText);
    cursor = matchedIndex + matchedId.length;
  }

  return parts;
}

function getSingleElementStandaloneTagDoc(
  node: TemplateBlockNode | { content: string; nodes: Record<string, DjangoNode> },
  segment: string,
): Doc | undefined {
  const preserved = segment.trimEnd();
  if (preserved.includes("\n")) {
    return undefined;
  }

  const [match] = findInlineOnlyStandaloneElements(node, preserved);
  const child = match ? node.nodes[match.marker] : undefined;
  if (
    !match ||
    match.index !== 0 ||
    match.text !== preserved ||
    child?.type !== "template-tag" ||
    child.protectedMarkerKind !== "block"
  ) {
    return undefined;
  }

  const markerIndex = preserved.indexOf(match.marker);
  return [
    preserved.slice(0, markerIndex),
    printTemplateTag(child),
    preserved.slice(markerIndex + match.marker.length),
  ];
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

  let content = segment;
  for (const id of getProtectedMarkerIds(node)) {
    content = content.split(id).join("");
  }

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
  let followsQuotedLineBreak = false;

  for (const char of content.replace(/\r\n/g, "\n")) {
    if (quote) {
      if (char === "\n") {
        current = `${current.trimEnd()} `;
        followsQuotedLineBreak = true;
        continue;
      }

      if (followsQuotedLineBreak && /[\t ]/.test(char)) {
        continue;
      }

      followsQuotedLineBreak = false;
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
  const ids = getProtectedMarkerIds(block);
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
    while (cursor < attribute.length) {
      let matchedId: string | undefined;
      let matchedIndex = attribute.length;

      for (const id of ids) {
        const index = attribute.indexOf(id, cursor);
        if (index !== -1 && index < matchedIndex) {
          matchedId = id;
          matchedIndex = index;
        }
      }

      if (!matchedId) {
        docs.push(attribute.slice(cursor));
        break;
      }

      if (matchedIndex > cursor) {
        docs.push(attribute.slice(cursor, matchedIndex));
      }
      docs.push(path.call(print, "nodes", matchedId));
      cursor = matchedIndex + matchedId.length;
    }
  }

  return docs;
}

function getCompactSingleElementBlockDoc(block: TemplateBlockNode): Doc | undefined {
  if (block.originalText.includes("\n") || block.originalText.includes("\r")) {
    return undefined;
  }

  const preserved = getPreservedSingleLineHtmlSegment(block, block.content);
  if (!preserved) {
    return undefined;
  }

  const marker = preserved.match(new RegExp(INLINE_MARKER_SOURCE))?.[0];
  if (!marker || block.nodes[marker]?.type !== "expression") {
    return undefined;
  }

  const markerIndex = preserved.indexOf(marker);
  return [
    printTemplateTag(block.start),
    preserved.slice(0, markerIndex),
    formatExpression(block.nodes[marker] as ExpressionNode),
    preserved.slice(markerIndex + marker.length),
    printTemplateTag(block.end),
  ];
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
  "details",
  "dialog",
  "div",
  "dl",
  "fieldset",
  "figure",
  "footer",
  "form",
  "header",
  "hgroup",
  "main",
  "menu",
  "nav",
  "ol",
  "section",
  "table",
  "ul",
]);

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
  marker: string,
): boolean {
  const markerIndex = container.content.indexOf(marker);
  if (markerIndex === -1) {
    return false;
  }

  const previousMarker = container.content
    .slice(0, markerIndex)
    .match(new RegExp(`(${INLINE_MARKER_SOURCE})\\s*$`))?.[1];
  return previousMarker ? container.nodes[previousMarker]?.type === "expression" : false;
}

function isInsideHtmlElement(content: string, marker: string): boolean {
  const markerIndex = content.indexOf(marker);
  if (markerIndex === -1) {
    return false;
  }

  const stack: string[] = [];
  const tags = content
    .slice(0, markerIndex)
    .matchAll(/<\/?([A-Za-z][A-Za-z0-9:-]*)(?:\s[^<>]*?)?\s*\/?>/g);

  for (const tag of tags) {
    const text = tag[0];
    const name = tag[1].toLowerCase();
    if (text.startsWith("</")) {
      const matchingIndex = stack.lastIndexOf(name);
      if (matchingIndex !== -1) {
        stack.length = matchingIndex;
      }
    } else if (!text.endsWith("/>") && !HTML_VOID_ELEMENTS.has(name)) {
      stack.push(name);
    }
  }

  return stack.length > 0;
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
      return printExpression(node);
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
): Doc | undefined {
  if (!isStandaloneBlockLikeNode(currentNode)) {
    return undefined;
  }

  const index = container.content.indexOf(currentNode.id);
  if (index === -1) {
    return undefined;
  }

  const before = container.content.slice(0, index);

  const previousMatch = before.match(new RegExp(`(${PROTECTED_MARKER_SOURCE})(?<gap>\\s*)$`));
  const previousId = previousMatch?.[1];
  const previousNode = previousId ? container.nodes[previousId] : undefined;

  if (hasHtmlMarkup(container.content)) {
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
): boolean {
  if (
    currentNode.type !== "template-tag" ||
    currentNode.role !== "standalone" ||
    currentNode.protectedMarkerKind !== "block"
  ) {
    return false;
  }

  const index = container.content.indexOf(currentNode.id);
  if (index === -1) {
    return false;
  }

  const after = container.content.slice(index + currentNode.id.length);
  const match = after.match(new RegExp(`^(?<gap>[ \\t]+)(?<next>${PROTECTED_MARKER_SOURCE})`));
  const nextId = match?.groups?.next;
  const nextNode = nextId ? container.nodes[nextId] : undefined;

  return (
    Boolean(match?.groups?.gap) &&
    nextNode?.type === "template-tag" &&
    nextNode.role === "standalone" &&
    nextNode.protectedMarkerKind === "block"
  );
}

function restoreInlineProtectedMarkerRuns(
  currentDoc: string,
  container: TemplateBlockNode | { content: string; nodes: Record<string, DjangoNode> },
): string {
  const lines = container.content.replace(/\r\n/g, "\n").split("\n");
  let restored = currentDoc;

  for (const line of lines) {
    const protectedMarkers = line.match(new RegExp(PROTECTED_MARKER_SOURCE, "g")) ?? [];
    if (protectedMarkers.length < 2 || !/[ \t]/.test(line)) {
      continue;
    }

    for (let index = 0; index < protectedMarkers.length - 1; index += 1) {
      const left = escapeMarkerForRegExp(protectedMarkers[index]);
      const right = escapeMarkerForRegExp(protectedMarkers[index + 1]);
      restored = restored.replace(
        new RegExp(`${left}\\s*\\n\\s*${right}`, "g"),
        `${protectedMarkers[index]} ${protectedMarkers[index + 1]}`,
      );
    }
  }

  return restored;
}

function isInsideInlineHtmlElement(value: string, offset: number): boolean {
  const stack: string[] = [];
  for (const tag of value
    .slice(0, offset)
    .matchAll(/<\/?([A-Za-z][A-Za-z0-9:-]*)(?:\s[^<>]*?)?\s*\/?>/g)) {
    const text = tag[0];
    const name = tag[1].toLowerCase();
    if (text.startsWith("</")) {
      const matchingIndex = stack.lastIndexOf(name);
      if (matchingIndex !== -1) {
        stack.length = matchingIndex;
      }
    } else if (!text.endsWith("/>") && !HTML_VOID_ELEMENTS.has(name)) {
      stack.push(name);
    }
  }

  const currentElement = stack.at(-1);
  return Boolean(currentElement && !BLOCK_FLOW_ELEMENTS.has(currentElement));
}

// This legacy generic pass handles unrelated document-flow boundaries. Whitespace-sensitive inline
// flow is built as a Doc above and deliberately excluded from this post-render normalization.
function normalizeAdjacentDocumentFlowConstructs(value: string): string {
  const inAttributeValue = Array.from<boolean>({ length: value.length }).fill(false);
  let quote: '"' | "'" | undefined;
  let inTag = false;

  for (let index = 0; index < value.length; index += 1) {
    inAttributeValue[index] = quote !== undefined;
    const char = value[index];

    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === "<" && /[A-Za-z!/]/.test(value[index + 1] ?? "")) {
      inTag = true;
    } else if (char === ">") {
      inTag = false;
    } else if ((char === '"' || char === "'") && inTag) {
      quote = char;
    }
  }

  return value.replace(
    /%}(?={% (?!end|else|elif|empty|plural))|\}\}(?={% if\b)/g,
    (boundary, offset: number) =>
      inAttributeValue[offset] || isInsideInlineHtmlElement(value, offset)
        ? boundary
        : `${boundary}\n`,
  );
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
      (match, indent, open, _tagName, body, close, trail) => {
        if ((open.match(/\s+\S+=/g) ?? []).length <= 1) {
          return match;
        }

        return `${indent}${open}\n${indent}  ${body}\n${indent}${close}${trail}`;
      },
    );
}

function prepareSegmentForHtml(
  segment: string,
  ids: string[],
  markerAllocator: InternalMarkerAllocator,
): {
  segment: string;
  beforeReplacements: Array<{ token: string; value: string }>;
  afterReplacements: Array<{ token: string; value: string }>;
} {
  const beforeReplacements: Array<{ token: string; value: string }> = [];
  const afterReplacements: Array<{ token: string; value: string }> = [];

  let prepared = segment.replace(
    new RegExp(`((${PROTECTED_MARKER_SOURCE})(?:[ \\t]+${PROTECTED_MARKER_SOURCE})+)`, "g"),
    (run) => {
      if (run.includes("<!--DJ")) {
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
      (match, open, _tagName, body, close, trail) =>
        (open.match(/\s+\S+=/g) ?? []).length > 1 ? `${open}\n  ${body}\n${close}${trail}` : match,
    );

  prepared = prepared.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (match, _openTag, body) => {
      if (ids.some((id) => body.includes(id)) || /\{[%#{]/.test(body)) {
        return match;
      }

      return match;
    },
  );

  return { segment: prepared, beforeReplacements, afterReplacements };
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

    const ids = getProtectedMarkerIds(node);
    if (typeof options.originalText !== "string") {
      throw new TypeError("Prettier did not provide the complete original source.");
    }
    const markerAllocator = new InternalMarkerAllocator(options.originalText);
    markerAllocator.reserve(ids);
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
        const preservedSegment = getPreservedSingleLineHtmlSegment(node, segment);
        const whitespaceSensitiveInlineDoc = getWhitespaceSensitiveInlineElementDoc(node, segment);
        const singleElementStandaloneTagDoc = getSingleElementStandaloneTagDoc(node, segment);
        const preparedSegment = prepareSegmentForHtml(segment, ids, markerAllocator);
        const doc = node.nodes[segment]
          ? segment
          : (whitespaceSensitiveInlineDoc ??
            singleElementStandaloneTagDoc ??
            preservedSegment ??
            (await textToDoc(preparedSegment.segment, {
              ...options,
              parser: "html",
            })));

        let ignoreDoc = false;

        return mapDoc(doc, (currentDoc) => {
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
          if (!ids.some((id) => currentString.includes(id))) {
            ignoreDoc = false;
            let plainDoc: Doc = currentDoc;
            for (const replacement of preparedSegment.afterReplacements) {
              if (typeof plainDoc === "string") {
                plainDoc = plainDoc.split(replacement.token).join(replacement.value);
              } else {
                plainDoc = mapDoc(plainDoc, (docPart) =>
                  typeof docPart === "string"
                    ? docPart.split(replacement.token).join(replacement.value)
                    : docPart,
                );
              }
            }
            return plainDoc;
          }

          currentDoc = normalizeHtmlAroundProtectedMarkers(
            restoreInlineProtectedMarkerRuns(currentDoc, node),
          );

          let replacedDoc = replaceProtectedMarkersInString(currentDoc, ids, (id, context) => {
            const currentNode = node.nodes[id];
            if (ignoreDoc) {
              return { doc: currentNode.originalText };
            }

            const followsInlineExpressionInElement =
              currentNode.type === "template-block" &&
              hasSafeSingleBlockElementBody(currentNode) &&
              hasAdjacentInlineExpressionBefore(node, id) &&
              isInsideHtmlElement(node.content, id);
            const compactNestedBlock = followsInlineExpressionInElement
              ? getCompactSingleElementBlockDoc(currentNode)
              : undefined;
            const rendered = compactNestedBlock ?? path.call(print, "nodes", id);
            const leadingSpacing = getStandaloneLeadingSpacing(node, currentNode);
            const markerIndex = node.content.indexOf(id);
            const sourceGapBefore = node.content.slice(0, markerIndex).match(/\s*$/)?.[0];
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
              const inlineWithNext = shouldInlineWithFollowingProtectedMarker(node, currentNode);
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
                (currentNode.type === "template-tag" && currentNode.keyword === "html_attrs"),
            };
          });

          for (const replacement of preparedSegment.afterReplacements) {
            if (typeof replacedDoc === "string") {
              replacedDoc = replacedDoc
                .split(`${replacement.token};`)
                .join(replacement.value)
                .split(replacement.token)
                .join(replacement.value);
            } else {
              replacedDoc = mapDoc(replacedDoc, (docPart) => {
                if (typeof docPart !== "string") {
                  return docPart;
                }

                return docPart
                  .split(`${replacement.token};`)
                  .join(replacement.value)
                  .split(replacement.token)
                  .join(replacement.value);
              });
            }
          }

          return replacedDoc;
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
      options as Parameters<typeof printDocToString>[1],
    );

    const preservedReplacements: Array<{ token: string; value: string }> = [];
    let protectedFormatted = formatted;
    for (const child of Object.values(node.nodes)) {
      const preservedText =
        child.type === "raw-block"
          ? getRawBlockText(child)
          : child.type === "ignore-region"
            ? child.originalText
            : undefined;
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
