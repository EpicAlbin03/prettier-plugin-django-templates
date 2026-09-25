import type {
  DjangoNode,
  RootNode,
  TemplateBlockNode,
  TemplateTagNode,
  RawBlockNode,
} from "./ast.js";
import {
  scanHtmlHostContexts,
  BLOCK_FLOW_ELEMENTS,
  isInlineHtmlElement,
  type HtmlHostContextIndex,
} from "./html-host-context.js";
import {
  getExpressionOnlyLines,
  getInlineBlockText,
  getTranslationBlockText,
} from "./template-text.js";
import {
  ANY_MARKER_SOURCE,
  ATTRIBUTE_MARKER_SOURCE,
  BLOCK_MARKER_SOURCE,
  INLINE_MARKER_SOURCE,
  PROTECTED_MARKER_SOURCE,
  containsBlockMarker,
  escapeMarkerForRegExp,
  InternalMarkerAllocator,
  markerEntries,
} from "./internal-markers.js";
import {
  isBranchTag,
  startsDocumentFlowAfterExpression,
  startsDocumentFlowAfterTag,
} from "./tags.js";

function hasHtmlMarkup(content: string): boolean {
  return scanHtmlHostContexts(content).tags.length > 0;
}

function findInlineOnlyStandaloneElements(
  node: TemplateBlockNode | { html: string; nodes: Readonly<Record<string, DjangoNode>> },
  segment: string,
): Array<{ index: number; marker: string; text: string }> {
  const matches: Array<{ index: number; marker: string; text: string }> = [];
  const { tags } = scanHtmlHostContexts(segment);
  for (let index = 0; index < tags.length - 1; index += 1) {
    const opening = tags[index];
    const closing = tags[index + 1];
    if (
      opening.closing ||
      opening.selfClosing ||
      opening.depth !== 0 ||
      !closing.closing ||
      closing.name !== opening.name
    )
      continue;
    const marker = segment.slice(opening.end, closing.start);
    const child = node.nodes[marker];
    if (child?.type === "template-tag" && child.role === "standalone") {
      matches.push({
        index: opening.start,
        marker,
        text: segment.slice(opening.start, closing.end),
      });
      index += 1;
    }
  }
  return matches;
}

function splitTopLevelInlineOnlyStandaloneElements(
  node: TemplateBlockNode | { html: string; nodes: Readonly<Record<string, DjangoNode>> },
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
  node: TemplateBlockNode | { html: string; nodes: Readonly<Record<string, DjangoNode>> },
): string[] {
  const splitStandaloneTemplateTags = !hasHtmlMarkup(node.html);
  const splitters = markerEntries(node.html, node.nodes)
    .map(({ id }) => node.nodes[id])
    .filter(
      (entry): entry is TemplateTagNode =>
        entry.type === "template-tag" &&
        entry.hostContext === "document-flow" &&
        (isBranchTag(entry.keyword) ||
          ((splitStandaloneTemplateTags || node.html.startsWith(entry.id)) &&
            entry.role === "standalone" &&
            entry.protectedMarkerKind === "block")),
    );

  if (splitters.length === 0) {
    return [node.html];
  }

  const pattern = new RegExp(
    `(${splitters.map((entry) => escapeMarkerForRegExp(entry.id)).join("|")})`,
  );
  return node.html.split(pattern).filter(Boolean);
}

function isSingleElementStandaloneTag(
  node: TemplateBlockNode | { html: string; nodes: Readonly<Record<string, DjangoNode>> },
  segment: string,
): boolean {
  const preserved = segment.trimEnd();
  const [match] = findInlineOnlyStandaloneElements(node, preserved);
  return Boolean(match && match.index === 0 && match.text === preserved);
}

function getWhitespaceSensitiveInlineBody(
  node: TemplateBlockNode | { html: string; nodes: Readonly<Record<string, DjangoNode>> },
  segment: string,
): { start: number; end: number } | undefined {
  const preserved = segment.trimEnd();
  const { tags } = scanHtmlHostContexts(preserved);
  const [opening, closing] = tags;
  if (
    tags.length !== 2 ||
    opening.start !== 0 ||
    opening.closing ||
    !closing.closing ||
    closing.end !== preserved.length ||
    closing.name !== opening.name ||
    BLOCK_FLOW_ELEMENTS.has(opening.name) ||
    /^(script|style|pre|textarea)$/.test(opening.name)
  )
    return undefined;

  const body = preserved.slice(opening.end, closing.start);
  if (/[\r\n]/.test(body)) {
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

  return { start: opening.end, end: closing.start };
}

function isInlineComment(
  child: DjangoNode | undefined,
  htmlCommentEnds: ReadonlyMap<number, number>,
): boolean {
  return (
    child?.type === "comment" ||
    (child?.type === "raw-block" &&
      child.preserveOriginalText === true &&
      htmlCommentEnds.get(child.sourceStart) === child.sourceEnd)
  );
}

function isStandaloneFlowTag(child: DjangoNode | undefined): boolean {
  return (
    child?.type === "template-tag" &&
    child.role === "standalone" &&
    child.protectedMarkerKind === "block"
  );
}

function isStandaloneDocumentFlowTemplateTag(
  node: TemplateBlockNode | { html: string; nodes: Readonly<Record<string, DjangoNode>> },
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
  node: TemplateBlockNode | { html: string; nodes: Readonly<Record<string, DjangoNode>> },
  segment: string | undefined,
): boolean {
  return Boolean(segment && node.nodes[segment]?.type === "template-block");
}

function segmentHasRenderableText(
  node: TemplateBlockNode | { html: string; nodes: Readonly<Record<string, DjangoNode>> },
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
  node: RootNode | { html: string; nodes: Readonly<Record<string, DjangoNode>> },
): string[] | undefined {
  const match = node.html.match(new RegExp(`^(${BLOCK_MARKER_SOURCE})`));
  if (!match) {
    return undefined;
  }

  const [firstId] = match;
  const firstNode = node.nodes[firstId];
  const rest = node.html.slice(firstId.length);
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

type Container = RootNode | TemplateBlockNode;
type Balance = ReturnType<typeof scanHtmlHostContexts>["balance"];

/** Structural facts are cached per document, never recomputed during embedding. */
class HtmlStructure {
  readonly #segments = new Map<Container, string[]>();
  readonly #expanded = new Map<Container, string>();
  readonly #balances = new Map<Container, Balance[]>();
  readonly #expandedBalances = new Map<Container, Balance[]>();
  readonly #ambiguous = new Map<Container, boolean>();

  segments(node: Container): string[] {
    let segments = this.#segments.get(node);
    if (!segments) {
      segments = splitAtTemplateTags(node);
      this.#segments.set(node, segments);
    }
    return segments;
  }

  expand(node: Container, segment: string): string {
    return segment.replace(new RegExp(ANY_MARKER_SOURCE, "g"), (id) => {
      const child = node.nodes[id];
      if (child?.type !== "template-block" || child.hostContext !== "document-flow") return id;
      let expanded = this.#expanded.get(child);
      if (expanded === undefined) {
        expanded = this.expand(child, child.html);
        this.#expanded.set(child, expanded);
      }
      return expanded;
    });
  }

  balances(node: Container, includeChildren = false): Balance[] {
    const cache = includeChildren ? this.#expandedBalances : this.#balances;
    let balances = cache.get(node);
    if (!balances) {
      balances = this.segments(node).map((segment) => {
        // Attribute markers touching a tag name still represent attributes, not its spelling.
        const html = (includeChildren ? this.expand(node, segment) : segment).replace(
          new RegExp(ATTRIBUTE_MARKER_SOURCE, "g"),
          (id) => (node.nodes[id] ? ` ${id}` : id),
        );
        return scanHtmlHostContexts(html).balance;
      });
      cache.set(node, balances);
    }
    return balances;
  }

  unbalanced(node: Container, includeChildren = false): boolean {
    return this.balances(node, includeChildren).some(isUnbalanced);
  }

  children(node: Container): TemplateBlockNode[] {
    return markerEntries(node.html, node.nodes).flatMap(({ id }) => {
      const child = node.nodes[id];
      return child.type === "template-block" && child.hostContext === "document-flow"
        ? [child]
        : [];
    });
  }

  ambiguous(node: Container): boolean {
    const cached = this.#ambiguous.get(node);
    if (cached !== undefined) return cached;
    const balances = this.balances(node);
    // Openings in one branch cannot balance closings in another branch.
    const result =
      (balances.length > 1 &&
        balances.some((balance) => balance && balance.unclosed.length > 0) &&
        balances.some((balance) => balance && balance.unexpectedClosings.length > 0)) ||
      this.children(node).some((child) => this.ambiguous(child));
    this.#ambiguous.set(node, result);
    return result;
  }

  unbalancedChild(node: Container): boolean {
    return this.children(node).some(
      (child) => this.unbalanced(child) || this.unbalanced(child, true),
    );
  }
}

function isUnbalanced(balance: Balance): boolean {
  return !balance || balance.unclosed.length > 0 || balance.unexpectedClosings.length > 0;
}

function hasUnbalancedPreservedHtml(node: Container): boolean {
  return markerEntries(node.html, node.nodes).some(({ id }) => {
    const child = node.nodes[id];
    return (
      child.type === "raw-block" &&
      child.preserveOriginalText &&
      isUnbalanced(scanHtmlHostContexts(child.sourceText).balance)
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
  structure: HtmlStructure,
): { html: string; nodes: RawBlockNode[] } | undefined {
  const ranges: Array<{ start: number; end: number; sourceStart: number; sourceEnd: number }> = [];
  const openElements: string[] = [];
  let rangeStart: { index: number; sourceStart: number } | undefined;

  for (const { id, index } of markerEntries(node.html, node.nodes)) {
    const child = node.nodes[id];
    if (child.type !== "template-block" || child.hostContext !== "document-flow") {
      continue;
    }

    for (const balance of structure.balances(child, true)) {
      if (!balance) {
        return undefined;
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
          return undefined;
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
    return undefined;
  }

  let html = node.html;
  const nodes: RawBlockNode[] = [];
  for (const range of ranges.reverse()) {
    const sourceText = source.slice(range.sourceStart, range.sourceEnd);
    const id = markerAllocator.allocate("inline");
    nodes.push({
      type: "raw-block",
      id,
      content: sourceText,
      sourceText,
      body: sourceText,
      preNewLines: 0,
      sourceStart: range.sourceStart,
      sourceEnd: range.sourceEnd,
      protectedMarkerKind: "inline",
      hostContext: "document-flow",
    });
    html = html.slice(0, range.start) + id + html.slice(range.end);
  }
  return { html, nodes };
}

function hasStandaloneBlockDelimiters(block: TemplateBlockNode, source: string): boolean {
  const delimiters = [
    block.start,
    ...block.childIds.flatMap((id) => {
      const child = block.nodes[id];
      return child.type === "template-tag" && child.role === "branch" ? [child] : [];
    }),
    block.end,
  ];
  // Structural printing introduces breaks around every delimiter. Only allow it
  // when those breaks already exist, so inline branch text stays adjacent.
  return delimiters.every((tag) => {
    const lineStart = source.lastIndexOf("\n", tag.sourceStart - 1) + 1;
    const nextLine = source.indexOf("\n", tag.sourceEnd);
    const lineEnd = nextLine === -1 ? source.length : nextLine;
    return (
      /^[ \t\r]*$/.test(source.slice(lineStart, tag.sourceStart)) &&
      /^[ \t\r]*$/.test(source.slice(tag.sourceEnd, lineEnd))
    );
  });
}

function hasSafeSingleBlockElementBody(block: TemplateBlockNode): boolean {
  const html = block.html.trim();
  const { tags } = scanHtmlHostContexts(html);
  const [opening, closing] = tags;
  return (
    tags.length === 2 &&
    opening.start === 0 &&
    !opening.closing &&
    closing.closing &&
    closing.end === html.length &&
    closing.name === opening.name &&
    BLOCK_FLOW_ELEMENTS.has(opening.name) &&
    block.nodes[html.slice(opening.end, closing.start).trim()]?.type === "expression"
  );
}

function adaptHtmlProjection(node: Container, html: string): string {
  const context = scanHtmlHostContexts(html);
  const entries = markerEntries(html, node.nodes);
  const commentEnds = new Set(context.comments.map((comment) => comment.end));
  const insertions = new Map<number, string>();
  let tagIndex = 0;
  for (const [index, entry] of entries.entries()) {
    while (context.tags[tagIndex] && context.tags[tagIndex].end <= entry.index) tagIndex += 1;
    const tag = context.tags[tagIndex];
    const previousTag = context.tags[tagIndex - 1];
    const child = node.nodes[entry.id];
    if (
      child.protectedMarkerKind === "attr" &&
      tag &&
      !tag.closing &&
      entry.index > tag.start &&
      entry.index < tag.end &&
      /^[A-Za-z][A-Za-z0-9:-]*$/.test(html.slice(tag.start + 1, entry.index))
    ) {
      insertions.set(entry.index, " ");
    }
    if (child.protectedMarkerKind === "block") {
      const previous = entries[index - 1];
      if (
        (previous &&
          node.nodes[previous.id].protectedMarkerKind === "block" &&
          previous.index + previous.id.length === entry.index) ||
        (previousTag?.closing && previousTag.end === entry.index) ||
        commentEnds.has(entry.index)
      )
        insertions.set(entry.index, "\n");
    }
  }
  const [opening, closing] = context.tags;
  if (
    context.tags.length === 2 &&
    opening.start === 0 &&
    !opening.closing &&
    closing.closing &&
    opening.name === closing.name &&
    !html.slice(closing.end).trim() &&
    !/^(pre|textarea)$/.test(opening.name) &&
    opening.attributes.filter((attribute) => attribute.includes("=")).length > 1 &&
    new RegExp(`^${INLINE_MARKER_SOURCE}$`).test(html.slice(opening.end, closing.start))
  ) {
    insertions.set(opening.end, "\n  ");
    insertions.set(closing.start, "\n");
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const [offset, value] of [...insertions].sort(([a], [b]) => a - b)) {
    parts.push(html.slice(cursor, offset), value);
    cursor = offset;
  }
  parts.push(html.slice(cursor));
  return parts.join("");
}

interface PreparedSegment {
  readonly segment: string;
  readonly beforeReplacements: readonly { readonly token: string; readonly value: string }[];
  readonly standaloneMarker?: string;
  readonly sensitiveBody?: { readonly start: number; readonly end: number };
}

function prepareSegmentForHtml(
  node: RootNode | TemplateBlockNode,
  segment: string,
  markerAllocator: InternalMarkerAllocator,
  markerContexts: ReadonlyMap<string, MarkerContext>,
): PreparedSegment {
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

  // Planned inline line breaks own these gaps. Hiding them from HTML prevents
  // its fill Docs from adding a second line break at narrow print widths.
  protectedSegment = protectedSegment.replace(
    new RegExp(`\\s+(${INLINE_MARKER_SOURCE})`, "g"),
    (gap, id: string) => (markerContexts.get(id)?.leadingLines ? id : gap),
  );

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

  prepared = adaptHtmlProjection(node, prepared);

  return {
    segment: prepared,
    beforeReplacements,
    standaloneMarker: standalone?.marker,
    sensitiveBody,
  };
}

interface SegmentBoundary {
  before: "none" | "line" | "trim-line";
  after: number;
}

function hasLeadingBlankLine(segment: string): boolean {
  const leadingWhitespace = segment.match(/^\s*/)?.[0] ?? "";
  return (leadingWhitespace.match(/\n/g) ?? []).length > 1;
}

function planSegmentBoundaries(
  node: TemplateBlockNode | { html: string; nodes: Readonly<Record<string, DjangoNode>> },
  segments: readonly string[],
): SegmentBoundary[] {
  const boundaries: SegmentBoundary[] = [];

  let previousContentSegment: string | undefined;
  for (const [index, segment] of segments.entries()) {
    const boundary: SegmentBoundary = { before: "none", after: 0 };
    const lastEntry = markerEntries(previousContentSegment ?? "", node.nodes).at(-1);
    const followsBlock =
      lastEntry &&
      node.nodes[lastEntry.id].type === "template-block" &&
      !previousContentSegment!.slice(lastEntry.index + lastEntry.id.length).trim();
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
      boundary.before = "trim-line";
    } else if (
      isStandaloneDocumentFlowTemplateTag(node, segment) &&
      (segmentHasRenderableText(node, segments[index - 1]) ||
        followsBlock ||
        (isStandaloneDocumentFlowTemplateTag(node, segments[index - 1]) &&
          previousTrimmedNode?.sourceEnd === node.nodes[segment]?.sourceStart))
    ) {
      boundary.before = "line";
    }

    if (segment.trim()) previousContentSegment = segment;

    const nextSegment = segments[index + 1];
    const nextEntry = markerEntries(nextSegment ?? "", node.nodes)[0];
    const immediatelyPrecedesBlock =
      nextEntry?.index === 0 && node.nodes[nextEntry.id].type === "template-block";
    if (
      isStandaloneDocumentFlowTemplateTag(node, segment) &&
      (segmentHasRenderableText(node, nextSegment) ||
        isTemplateBlockSegment(node, nextSegment) ||
        immediatelyPrecedesBlock)
    ) {
      boundary.after += 1;
      if (segmentHasRenderableText(node, nextSegment) && hasLeadingBlankLine(nextSegment)) {
        boundary.after += 1;
      }
    }
    boundaries.push(boundary);
  }

  return boundaries;
}

export interface PreservedSpan {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly text: string;
  readonly reason: "source" | "translation" | "inline" | "conditional-html" | "ignore";
}

interface MarkerContext {
  readonly breakBefore: boolean;
  readonly leadingLines: number;
  readonly inlineWithNext: boolean;
}

export interface ContainerPlan {
  readonly node: RootNode | TemplateBlockNode;
  readonly body:
    | { readonly kind: "expression-lines"; readonly lines: readonly (readonly string[])[] }
    | { readonly kind: "start-tag" | "html" };
  readonly markerContexts: ReadonlyMap<string, MarkerContext>;
  readonly segments: readonly string[];
  readonly boundaries: readonly Readonly<SegmentBoundary>[];
  readonly preparedSegments: readonly PreparedSegment[];
  readonly leadingStandaloneSplit?: readonly string[];
  readonly blockSequence?: readonly string[];
  readonly preserved?: PreservedSpan;
  readonly finalNewline: boolean;
}

export interface DocumentPlan {
  readonly containers: ReadonlyMap<string, ContainerPlan>;
  readonly preserved: ReadonlyMap<string, PreservedSpan>;
}

function ignoredSourceRanges(source: string, html: HtmlHostContextIndex, ordered: DjangoNode[]) {
  const ranges: Array<{ start: number; end: number }> = [];
  const elementEnds = new Map<number, number>();
  const stack: number[] = [];
  for (const [index, tag] of html.tags.entries()) {
    if (tag.selfClosing) elementEnds.set(index, tag.end);
    else if (!tag.closing) stack.push(index);
    else if (stack.length && html.tags[stack.at(-1)!].name === tag.name) {
      elementEnds.set(stack.pop()!, tag.end);
    }
  }
  let nodeIndex = 0;
  let tagIndex = 0;
  for (const comment of html.comments) {
    if ((ranges.at(-1)?.end ?? -1) > comment.start) continue;
    const commentText = source.slice(comment.start, comment.end);
    // Match Prettier's directive grammar and case-sensitive raw attribute names.
    const attributeIgnore = commentText
      .slice(4, -3)
      .trim()
      .match(/^prettier-ignore-attribute(?:\s+(.+))?$/s);
    if (commentText !== "<!-- prettier-ignore -->" && !attributeIgnore) continue;
    while (ordered[nodeIndex] && ordered[nodeIndex].sourceStart < comment.end) nodeIndex += 1;
    while (html.tags[tagIndex] && html.tags[tagIndex].start < comment.end) tagIndex += 1;
    const nextNode = ordered[nodeIndex];
    const nextTag = html.tags[tagIndex];
    if (attributeIgnore) {
      // Only the immediately preceding comment applies; intervening text,
      // template constructs, or another comment break the association.
      if (!nextTag || nextTag.closing || source.slice(comment.end, nextTag.start).trim()) continue;
      const names = attributeIgnore[1]?.split(/\s+/);
      for (const attribute of nextTag.attributeRanges) {
        if (!names || names.includes(attribute.name)) ranges.push(attribute);
      }
    } else if (nextTag && nextTag.start < (nextNode?.sourceStart ?? source.length)) {
      ranges.push({ start: nextTag.start, end: elementEnds.get(tagIndex) ?? nextTag.end });
    } else if (nextNode) ranges.push({ start: nextNode.sourceStart, end: nextNode.sourceEnd });
  }
  return ranges;
}

/**
 * Owns the HTML projection and all preservation decisions for a single document.
 * Input AST nodes are never changed. Temporary markers exist only in this plan;
 * their allocation is finished before Prettier starts embedding any child.
 */
export function analyzeDocument(root: RootNode): DocumentPlan {
  // With no Django constructs or marker-like literals, HTML owns the entire
  // document. There are no preservation decisions or projections to analyze.
  if (
    !root.preserveOriginalText &&
    Object.keys(root.nodes).length === 0 &&
    !new RegExp(ANY_MARKER_SOURCE).test(root.html)
  ) {
    return {
      containers: new Map([
        [
          root.id,
          {
            node: root,
            body: { kind: "html" },
            markerContexts: new Map(),
            segments: [root.html],
            boundaries: [{ before: "none", after: 0 }],
            preparedSegments: [{ segment: root.html, beforeReplacements: [] }],
            finalNewline: true,
          },
        ],
      ]),
      preserved: new Map(),
    };
  }
  const allocator = new InternalMarkerAllocator(root.sourceText);
  allocator.reserve(Object.keys(root.nodes));
  const nodes = { ...root.nodes };
  const containers = new Map<string, ContainerPlan>();
  const preserved = new Map<string, PreservedSpan>();
  const sourceContexts = scanHtmlHostContexts(root.sourceText);
  const htmlCommentEnds = new Map(sourceContexts.comments.map(({ start, end }) => [start, end]));
  const structure = new HtmlStructure();
  const safeInlineBodies = new Map<string, boolean>();
  const safeBody = (node: TemplateBlockNode) => {
    let safe = safeInlineBodies.get(node.id);
    if (safe === undefined) {
      safe = hasSafeSingleBlockElementBody(node);
      safeInlineBodies.set(node.id, safe);
    }
    return safe;
  };
  const preserve = (node: DjangoNode, text: string, reason: PreservedSpan["reason"]) => {
    const span = { sourceStart: node.sourceStart, sourceEnd: node.sourceEnd, text, reason };
    preserved.set(node.id, span);
    return span;
  };
  const ordered = [root, ...Object.values(nodes)].sort(
    (a, b) => a.sourceStart - b.sourceStart || b.sourceEnd - a.sourceEnd,
  );
  const ignored = ignoredSourceRanges(root.sourceText, sourceContexts, ordered);
  let ignoreIndex = 0;
  let preservedEnd = -1;
  for (const node of ordered) {
    while (ignored[ignoreIndex] && ignored[ignoreIndex].end <= node.sourceStart) ignoreIndex += 1;
    const ignoredRange = ignored[ignoreIndex];
    if (
      ignoredRange &&
      node.sourceStart >= ignoredRange.start &&
      node.sourceEnd <= ignoredRange.end
    ) {
      preserve(node, node.sourceText, "ignore");
    } else if (node.preserveOriginalText || node.sourceEnd <= preservedEnd) {
      preserve(node, node.sourceText, "source");
    } else {
      const translation = getTranslationBlockText(node);
      if (translation !== undefined) preserve(node, translation, "translation");
      else if (
        node.type === "template-block" &&
        node.hostContext === "document-flow" &&
        isInlineHtmlElement(sourceContexts.elementAt(node.sourceStart)) &&
        !hasStandaloneBlockDelimiters(node, root.sourceText)
      )
        preserve(node, getInlineBlockText(node), "inline");
    }
    if (preserved.has(node.id)) preservedEnd = Math.max(preservedEnd, node.sourceEnd);
  }
  // Blocks are inserted by the parser on closure (children before parents). Analyze
  // that order explicitly, independent of Prettier's embedding traversal order.
  const originals = Object.values(nodes).filter(
    (node): node is TemplateBlockNode => node.type === "template-block",
  );
  originals.sort((a, b) => a.sourceEnd - a.sourceStart - (b.sourceEnd - b.sourceStart));
  for (const original of [...originals, root]) {
    const node = { ...original, nodes };
    if (!preserved.has(node.id) && node.hostContext === "document-flow") {
      if (
        hasUnbalancedPreservedHtml(node) ||
        structure.ambiguous(original) ||
        ((node.type === "template-block" || structure.unbalancedChild(original)) &&
          structure.unbalanced(original)) ||
        (node.type === "template-block" && structure.unbalanced(original, true))
      ) {
        preserve(node, node.sourceText, "conditional-html");
      } else {
        const projection = protectConditionalHtmlWhitespace(
          node,
          allocator,
          root.sourceText,
          structure,
        );
        if (!projection) preserve(node, node.sourceText, "conditional-html");
        else {
          node.html = projection.html;
          for (const child of projection.nodes) nodes[child.id] = child;
        }
      }
    }
    const hostContexts = scanHtmlHostContexts(node.html);
    const entries = markerEntries(node.html, nodes);
    const markerContexts = new Map<string, MarkerContext>();
    for (const [index, entry] of entries.entries()) {
      const child = nodes[entry.id];
      // Synthetic ranges are plan-owned, never inserted into the parser's dictionary.
      if (!root.nodes[entry.id]) preserve(child, child.sourceText, "conditional-html");
      const previous = entries[index - 1];
      const next = entries[index + 1];
      let whitespaceStart = entry.index;
      while (whitespaceStart > 0 && /\s/.test(node.html[whitespaceStart - 1])) whitespaceStart -= 1;
      const betweenNext = next
        ? node.html.slice(entry.index + entry.id.length, next.index)
        : undefined;
      const previousId =
        previous?.index + previous?.id.length === whitespaceStart ? previous.id : undefined;
      const gapBefore = node.html.slice(whitespaceStart, entry.index);
      const previousNode = previousId ? nodes[previousId] : undefined;
      const keyword =
        child.type === "template-block"
          ? child.start.keyword
          : child.type === "template-tag"
            ? child.keyword
            : undefined;
      const documentFlowBreak =
        keyword !== undefined &&
        previousNode &&
        gapBefore === "" &&
        !preserved.has(previousNode.id) &&
        child.hostContext === "document-flow" &&
        sourceContexts.isDocumentFlowNormalizationSafeAt(child.sourceStart) &&
        !isInlineHtmlElement(sourceContexts.elementAt(child.sourceStart)) &&
        (previousNode.type === "expression"
          ? startsDocumentFlowAfterExpression(keyword)
          : (previousNode.type === "template-tag" || previousNode.type === "template-block") &&
            (previousNode.protectedMarkerKind !== "block" ||
              child.protectedMarkerKind !== "block") &&
            startsDocumentFlowAfterTag(keyword));
      const nextNode = next ? nodes[next.id] : undefined;
      // Template comments and protected HTML comments become inline text markers.
      // Preserve their line boundaries in document flow, but not inside inline HTML.
      const childIsComment = isInlineComment(child, htmlCommentEnds);
      const previousIsComment = isInlineComment(previousNode, htmlCommentEnds);
      const commentLineBreak =
        ((childIsComment && (previousNode?.type === "expression" || previousIsComment)) ||
          (child.type === "expression" && previousIsComment)) &&
        gapBefore.includes("\n") &&
        child.hostContext === "document-flow" &&
        sourceContexts.isDocumentFlowNormalizationSafeAt(child.sourceStart - 1) &&
        !isInlineHtmlElement(sourceContexts.elementAt(child.sourceStart));
      markerContexts.set(entry.id, {
        leadingLines: commentLineBreak
          ? Math.min(gapBefore.split("\n").length - 1, 2)
          : hostContexts.tags.length === 0 &&
              isStandaloneFlowTag(previousNode) &&
              (isStandaloneFlowTag(child) ||
                (child.type === "template-block" && child.protectedMarkerKind === "block"))
            ? Math.min(child.preNewLines, 2)
            : 0,
        inlineWithNext:
          /^[ \t]+$/.test(betweenNext ?? "") &&
          isStandaloneFlowTag(child) &&
          isStandaloneFlowTag(nextNode),
        breakBefore:
          Boolean(documentFlowBreak) ||
          (child.type === "template-block" &&
            safeBody(child) &&
            previousNode?.type === "expression" &&
            hostContexts.elementAt(entry.index) !== undefined &&
            !gapBefore.includes("\n")),
      });
    }
    const leadingStandaloneSplit =
      node.type === "root" ? splitLeadingStandaloneBlockTag(node) : undefined;
    const splitSegments = leadingStandaloneSplit ?? splitAtTemplateTags(node);
    const segments =
      node.type === "root"
        ? splitTopLevelInlineOnlyStandaloneElements(node, splitSegments)
        : splitSegments;
    const ending = entries.at(-1);
    // A sequence of block markers on separate lines needs no HTML parser. Keep
    // every other whitespace shape on the normal path, including blank lines.
    const blockSequence =
      ending &&
      /^[ \t\r\n]*$/.test(node.html.slice(ending.index + ending.id.length)) &&
      entries.every(({ id, index }, entryIndex) => {
        const child = nodes[id];
        const previous = entries[entryIndex - 1];
        const gap = node.html.slice(previous ? previous.index + previous.id.length : 0, index);
        return (
          child.type === "template-block" &&
          child.protectedMarkerKind === "block" &&
          (previous ? /^[ \t]*\r?\n[ \t]*$/.test(gap) : /^[ \t\r\n]*$/.test(gap))
        );
      })
        ? entries.map(({ id }) => id)
        : undefined;
    const endingNode =
      ending && /^\s*$/.test(node.html.slice(ending.index + ending.id.length))
        ? nodes[ending.id]
        : undefined;
    const unclosed =
      (endingNode?.type === "ignore-region" && !endingNode.closed) ||
      (endingNode?.type === "raw-block" && endingNode.body === undefined);
    const preservedSpan = preserved.get(node.id);
    const expressionLines = getExpressionOnlyLines(node);
    const body: ContainerPlan["body"] = expressionLines
      ? { kind: "expression-lines", lines: expressionLines }
      : {
          kind:
            node.type === "template-block" &&
            node.hostContext === "start-tag" &&
            node.containsNewLines
              ? "start-tag"
              : "html",
        };
    containers.set(node.id, {
      node,
      body,
      markerContexts,
      segments,
      boundaries: planSegmentBoundaries(node, segments),
      preparedSegments: segments.map((segment) =>
        prepareSegmentForHtml(node, segment, allocator, markerContexts),
      ),
      leadingStandaloneSplit,
      blockSequence,
      preserved: preservedSpan,
      finalNewline: preservedSpan
        ? preservedSpan.reason === "conditional-html" && !preservedSpan.text.endsWith("\n")
        : !unclosed,
    });
  }
  // Finalize opacity after conditional ranges are known. Descendants of a preserved
  // container must not be embedded, even if Prettier visits them before their parent.
  const opaqueSpans = [...preserved.values()].sort((a, b) => a.sourceStart - b.sourceStart);
  let opaqueIndex = 0;
  let opaqueEnd = -1;
  for (const original of ordered) {
    while (
      opaqueSpans[opaqueIndex] &&
      opaqueSpans[opaqueIndex].sourceStart <= original.sourceStart
    ) {
      opaqueEnd = Math.max(opaqueEnd, opaqueSpans[opaqueIndex].sourceEnd);
      opaqueIndex += 1;
    }
    const layout = containers.get(original.id);
    if (layout && !layout.preserved && original.sourceEnd <= opaqueEnd) {
      const span = preserve(original, original.sourceText, "source");
      containers.set(original.id, { ...layout, preserved: span });
    }
  }
  Object.freeze(nodes);
  for (const layout of containers.values()) Object.freeze(layout.node);
  return { containers, preserved };
}

const plans = new WeakMap<RootNode["nodes"], DocumentPlan>();

export function prepareDocument(root: RootNode): RootNode {
  plans.set(root.nodes, analyzeDocument(root));
  return root;
}

export function getDocumentPlan(node: RootNode | TemplateBlockNode): DocumentPlan {
  const plan = plans.get(node.nodes);
  if (!plan) throw new Error("Django printing requires document analysis before embedding.");
  return plan;
}
