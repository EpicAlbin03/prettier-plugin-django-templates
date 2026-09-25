import type {
  DraftNode as DjangoNode,
  DraftRoot as RootNode,
  DraftBlock as TemplateBlockNode,
} from "./ast-builders.js";
import { ANY_MARKER_SOURCE, InternalMarkerAllocator } from "./internal-markers.js";

interface SourceRange {
  start: number;
  end: number;
}

export interface HtmlCommentRange extends SourceRange {
  hasTemplateSyntax: boolean;
}

type Container = RootNode | TemplateBlockNode;

function firstAfter<T>(entries: T[], offset: number, boundary: (entry: T) => number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (boundary(entries[middle]) <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

// Expand crossing constructs, but not enclosing blocks: those can format around the comment.
// Sorted boundary indexes avoid rescanning the entire dictionary for every sibling comment.
function expandRange(
  range: SourceRange,
  byStart: DjangoNode[],
  byEnd: DjangoNode[],
  nodes: Record<string, DjangoNode>,
): void {
  let previousStart: number;
  let previousEnd: number;
  do {
    previousStart = range.start;
    previousEnd = range.end;
    for (
      let index = firstAfter(byEnd, range.start, (node) => node.sourceEnd);
      index < byEnd.length;
      index += 1
    ) {
      const node = byEnd[index];
      if (node.sourceEnd >= range.end) break;
      range.start = Math.min(range.start, node.sourceStart);
    }
    for (
      let index = firstAfter(byStart, range.start - 1, (node) => node.sourceStart);
      index < byStart.length;
      index += 1
    ) {
      const node = byStart[index];
      if (node.sourceStart >= range.end) break;
      range.end = Math.max(range.end, node.sourceEnd);
      if (node.type === "template-tag" && node.parentBlockId) {
        const parent = nodes[node.parentBlockId];
        if (
          parent.type === "template-block" &&
          (node.role === "branch" || node.id === parent.start.id || node.id === parent.end.id)
        ) {
          range.start = Math.min(range.start, parent.sourceStart);
          range.end = Math.max(range.end, parent.sourceEnd);
        }
      }
    }
  } while (range.start !== previousStart || range.end !== previousEnd);
}

function enclosingContainer(root: RootNode, range: SourceRange, byStart: DjangoNode[]): Container {
  const first = byStart[firstAfter(byStart, range.start - 1, (node) => node.sourceStart)];
  let parentId = first?.parentBlockId;
  while (parentId) {
    const parent = root.nodes[parentId];
    if (parent.type !== "template-block") break;
    if (parent.start.sourceEnd <= range.start && parent.end.sourceStart >= range.end) {
      return parent;
    }
    parentId = parent.parentBlockId;
  }
  return root;
}

export function protectHtmlComments(
  root: RootNode,
  comments: HtmlCommentRange[],
  allocator: InternalMarkerAllocator,
): void {
  const affected = comments.filter((comment) => comment.hasTemplateSyntax);
  if (affected.length === 0) return;

  const source = root.sourceText;
  const byStart = Object.values(root.nodes).sort((a, b) => a.sourceStart - b.sourceStart);
  const byEnd = [...byStart].sort((a, b) => a.sourceEnd - b.sourceEnd);
  const ranges: SourceRange[] = [];
  for (const comment of affected) {
    const previous = ranges.at(-1);
    if (previous && previous.start <= comment.start && previous.end >= comment.end) continue;
    const range = { start: comment.start, end: comment.end };
    let previousStart: number;
    let previousEnd: number;
    do {
      previousStart = range.start;
      previousEnd = range.end;
      expandRange(range, byStart, byEnd, root.nodes);
      // An expansion can encompass another HTML comment or template boundary. Close over
      // both kinds of ranges before handing any surrounding fragments to the HTML printer.
      for (
        let index = firstAfter(comments, range.start, (entry) => entry.end);
        index < comments.length;
        index += 1
      ) {
        const other = comments[index];
        if (other.start >= range.end) break;
        range.start = Math.min(range.start, other.start);
        range.end = Math.max(range.end, other.end);
      }
    } while (range.start !== previousStart || range.end !== previousEnd);
    ranges.push(range);
  }
  ranges.sort((a, b) => a.start - b.start);
  const merged: SourceRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push(range);
    }
  }

  const contentStart = source.search(/\S/);
  const contentEnd = source.trimEnd().length;
  const hasUnclosedEnding =
    (comments.at(-1)?.end === source.length && !source.endsWith("-->")) ||
    byStart.some(
      (node) =>
        node.sourceEnd === source.length &&
        ((node.type === "raw-block" && node.body === undefined) ||
          (node.type === "ignore-region" && !node.closed)),
    );
  const replacements = new Map<Container, DjangoNode[]>();
  for (const range of merged) {
    if (range.start <= contentStart && range.end >= contentEnd) {
      root.preserveOriginalText = true;
      return;
    }
    const container = enclosingContainer(root, range, byStart);
    // Keep validated nodes for source spans and structural inspection, but never embed hidden
    // fragments of comments. A complete source range is the only thing that will be printed.
    for (
      let index = firstAfter(byStart, range.start - 1, (node) => node.sourceStart);
      index < byStart.length;
      index += 1
    ) {
      const child = byStart[index];
      if (child.sourceStart >= range.end) break;
      if (child.sourceEnd <= range.end) child.preserveOriginalText = true;
    }
    const sourceText = source.slice(range.start, range.end);
    const id = allocator.allocate("inline");
    const preserved: DjangoNode = {
      type: "raw-block",
      id,
      content: sourceText,
      sourceText,
      body: range.end === source.length && hasUnclosedEnding ? undefined : sourceText,
      preserveOriginalText: true,
      preNewLines: 0,
      sourceStart: range.start,
      sourceEnd: range.end,
      protectedMarkerKind: "inline",
      hostContext: "document-flow",
    };
    root.nodes[id] = preserved;
    const entries = replacements.get(container) ?? [];
    entries.push(preserved);
    replacements.set(container, entries);
  }

  for (const [container, preserved] of replacements) {
    const entries: DjangoNode[] = [...preserved];
    let rangeIndex = 0;
    for (const match of container.html.matchAll(new RegExp(ANY_MARKER_SOURCE, "g"))) {
      const child = root.nodes[match[0]];
      if (!child) continue;
      while (preserved[rangeIndex] && preserved[rangeIndex].sourceEnd <= child.sourceStart) {
        rangeIndex += 1;
      }
      const covering = preserved[rangeIndex];
      if (
        !covering ||
        child.sourceStart < covering.sourceStart ||
        child.sourceEnd > covering.sourceEnd
      ) {
        entries.push(child);
      }
    }
    entries.sort((a, b) => a.sourceStart - b.sourceStart);
    let cursor = container.type === "root" ? 0 : container.start.sourceEnd;
    const end = container.type === "root" ? source.length : container.end.sourceStart;
    const parts: string[] = [];
    for (const child of entries) {
      parts.push(source.slice(cursor, child.sourceStart), child.id);
      cursor = child.sourceEnd;
    }
    parts.push(source.slice(cursor, end));
    container.html = parts.join("");
    if (container.type === "template-block") {
      container.childIds = entries.map((child) => child.id);
    }
  }
}
