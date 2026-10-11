import { protectHtmlComments, type HtmlCommentRange } from "./comment-preservation.js";
import {
  isInlineHtmlElement,
  scanHtmlHostContexts,
  type HtmlHostContext,
} from "./html-host-context.js";
import { InternalMarkerAllocator } from "./internal-markers.js";
import {
  findRawBodyEnd,
  IGNORE_REGION_DELIMITERS,
  type IgnoreRegionDelimiter,
} from "./template-regions.js";
import {
  getExpectedEndNames,
  getStandaloneFlow,
  getTagRole,
  hasExactRawBodyEnd,
  isPermittedBranch,
  isRawBodyTag,
} from "./tags.js";
import type {
  CommentNode,
  ExpressionNode,
  IgnoreRegionNode,
  ProtectedMarkerKind,
  RawBlockNode,
  RawBlockDetails,
} from "./ast.js";

import type { RootNode } from "./ast.js";
import {
  finishDocument,
  type DraftRoot,
  type DraftBlock as TemplateBlockNode,
  type DraftTag as TemplateTagNode,
  type DraftNode as DjangoNode,
} from "./ast-builders.js";

type TokenType = "Text" | "Expression" | "Comment" | "Tag" | "RawBlock" | "IgnoreRegion";

interface TokenBase {
  type: TokenType;
  raw: string;
  content: string;
  start: number;
  end: number;
  hostContext: HtmlHostContext;
  inPreformatted: boolean;
  inInlineFlow: boolean;
}

interface TextToken extends TokenBase {
  type: "Text";
}

interface ExpressionToken extends TokenBase {
  type: "Expression";
}

interface CommentToken extends TokenBase {
  type: "Comment";
}

interface IgnoreRegionToken extends TokenBase {
  type: "IgnoreRegion";
  closed: boolean;
}

interface TagToken extends TokenBase {
  type: "Tag";
  name: string;
  args: string;
  role: TemplateTagNode["role"];
}

interface RawBlockToken extends TokenBase {
  type: "RawBlock";
  details: Exclude<RawBlockDetails, { kind: "source" }>;
}

type Token =
  | TextToken
  | ExpressionToken
  | CommentToken
  | IgnoreRegionToken
  | TagToken
  | RawBlockToken;

function readUntil(text: string, start: number, endToken: string): number {
  const end = text.indexOf(endToken, start);
  if (end === -1) {
    return text.length;
  }
  return end + endToken.length;
}

function findNextSpecial(text: string, from: number, pattern: RegExp): number {
  pattern.lastIndex = from;
  return pattern.exec(text)?.index ?? text.length;
}

function createTextToken(
  text: string,
  start: number,
  end: number,
  state: Pick<TokenBase, "hostContext" | "inPreformatted" | "inInlineFlow">,
): TextToken {
  return {
    type: "Text",
    raw: text,
    content: text,
    start,
    end,
    ...state,
  };
}

function normalizeTemplateTagContent(content: string): string {
  const trimmed = content.trim();
  // Most tags already use single ASCII spaces. Quoted whitespace only makes
  // this check conservative; the quote-aware path still handles it below.
  if (!/[^\S ]| {2}/.test(trimmed)) return trimmed;
  let normalized = "";
  let pendingSpace = false;
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const char of trimmed) {
    if (quote) {
      normalized += char;

      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }

      continue;
    }

    if (char === '"' || char === "'") {
      if (pendingSpace && normalized) {
        normalized += " ";
      }
      pendingSpace = false;
      quote = char;
      normalized += char;
      continue;
    }

    if (/\s/.test(char)) {
      pendingSpace = normalized.length > 0;
      continue;
    }

    if (pendingSpace && normalized) {
      normalized += " ";
    }
    pendingSpace = false;
    normalized += char;
  }

  return normalized;
}

function createTagToken(
  raw: string,
  start: number,
  end: number,
  state: Pick<TokenBase, "hostContext" | "inPreformatted" | "inInlineFlow">,
): TagToken {
  const content = normalizeTemplateTagContent(raw.slice(2, -2));
  const [name = ""] = content.split(/\s+/, 1);
  const args = content.slice(name.length).trimStart();

  return {
    type: "Tag",
    raw,
    content,
    name,
    args,
    role: getTagRole(name, args),
    start,
    end,
    ...state,
  };
}

function findIgnoreRegionEnd(
  text: string,
  from: number,
  delimiter: IgnoreRegionDelimiter,
): { end: number; closed: boolean } {
  const closerStart = text.indexOf(delimiter.closer, from);
  return closerStart === -1
    ? { end: text.length, closed: false }
    : { end: closerStart + delimiter.closer.length, closed: true };
}

function tokenize(text: string) {
  // HTML context is irrelevant when no construct can produce a Django node.
  if (!/{[{#%]|<!-- prettier-ignore-start -->/.test(text)) {
    return {
      tokens: [
        createTextToken(text, 0, text.length, {
          hostContext: "document-flow",
          inPreformatted: false,
          inInlineFlow: false,
        }),
      ],
      preserveOriginalText: false,
      htmlComments: [],
    };
  }
  const hostContexts = scanHtmlHostContexts(text);
  const tokens: Token[] = [];
  const specialPattern = /{{|{#|{%|<!--/g;
  // Python's non-DOTALL dot excludes LF, but permits CR and Unicode line separators.
  const templatePattern = /{{[^\n]*?}}|{#[^\n]*?#}|{%[^\n]*?%}/y;
  let cursor = 0;
  let preserveOriginalText = false;
  let htmlComment: HtmlCommentRange | undefined;
  const htmlComments: HtmlCommentRange[] = [];

  while (cursor < text.length) {
    const hostContext = hostContexts.at(cursor);
    const tokenState = {
      hostContext,
      inPreformatted: hostContext === "document-flow" && hostContexts.isPreformattedAt(cursor),
      inInlineFlow:
        hostContext === "document-flow" &&
        (/^(script|style|title)$/.test(hostContexts.elementAt(cursor) ?? "") ||
          (isInlineHtmlElement(hostContexts.elementAt(cursor)) &&
            /\S/.test(text[cursor - 1] ?? ""))),
    };

    const ignoreDelimiter = IGNORE_REGION_DELIMITERS.find(({ opener }) =>
      text.startsWith(opener, cursor),
    );
    if (ignoreDelimiter) {
      if (htmlComment && cursor < htmlComment.end) {
        htmlComment.hasTemplateSyntax = true;
      }
      const { end, closed } = findIgnoreRegionEnd(
        text,
        cursor + ignoreDelimiter.opener.length,
        ignoreDelimiter,
      );
      const raw = text.slice(cursor, end);
      tokens.push({
        type: "IgnoreRegion",
        raw,
        content: raw,
        start: cursor,
        end,
        ...tokenState,
        closed,
      });
      cursor = end;
      continue;
    }

    if (text.startsWith("<!--", cursor)) {
      if (!htmlComment || cursor >= htmlComment.end) {
        htmlComment = {
          start: cursor,
          end: readUntil(text, cursor + 4, "-->"),
          hasTemplateSyntax: false,
        };
        htmlComments.push(htmlComment);
      }
      const end = Math.min(htmlComment.end, findNextSpecial(text, cursor + 4, specialPattern));
      const raw = text.slice(cursor, end);
      tokens.push(createTextToken(raw, cursor, end, tokenState));
      cursor = end;
      continue;
    }

    templatePattern.lastIndex = cursor;
    const templateMatch = templatePattern.exec(text);
    // Validate Django syntax even inside HTML comments; preserve only the affected
    // ranges after the complete template structure (including crossing blocks) is known.
    if (templateMatch && htmlComment && cursor < htmlComment.end) {
      htmlComment.hasTemplateSyntax = true;
    }
    if (!templateMatch && /^{[{#%]/.test(text.slice(cursor, cursor + 2))) {
      // Formatting literal delimiters could remove the LF that prevents Django recognition.
      // Preserve the document, but keep scanning so nested valid constructs are still parsed.
      preserveOriginalText = true;
      const end = findNextSpecial(text, cursor + 1, specialPattern);
      tokens.push(createTextToken(text.slice(cursor, end), cursor, end, tokenState));
      cursor = end;
      continue;
    }

    if (templateMatch && text.startsWith("{{", cursor)) {
      const end = cursor + templateMatch[0].length;
      const raw = text.slice(cursor, end);
      tokens.push({
        type: "Expression",
        raw,
        content: raw.slice(2, -2),
        start: cursor,
        end,
        ...tokenState,
      });
      cursor = end;
      continue;
    }

    if (templateMatch && text.startsWith("{#", cursor)) {
      const end = cursor + templateMatch[0].length;
      const raw = text.slice(cursor, end);
      tokens.push({
        type: "Comment",
        raw,
        content: raw.slice(2, -2),
        start: cursor,
        end,
        ...tokenState,
      });
      cursor = end;
      continue;
    }

    if (templateMatch && text.startsWith("{%", cursor)) {
      const end = cursor + templateMatch[0].length;
      const raw = text.slice(cursor, end);
      const tag = createTagToken(raw, cursor, end, tokenState);

      if (isRawBodyTag(tag.name)) {
        const openingContent = raw.slice(2, -2).trim();
        const blockEndInfo = findRawBodyEnd(text, end, tag.name, openingContent);
        if (blockEndInfo) {
          const blockRaw = text.slice(cursor, blockEndInfo.end);
          tokens.push({
            type: "RawBlock",
            raw: blockRaw,
            content: tag.content,
            details: {
              kind: "closed-template",
              keyword: tag.name,
              args: tag.args,
              body: text.slice(end, blockEndInfo.closingStart),
              endArgs: blockEndInfo.endArgs,
            },
            start: cursor,
            end: blockEndInfo.end,
            ...tokenState,
          });
          cursor = blockEndInfo.end;
          continue;
        }

        if (hasExactRawBodyEnd(tag.name) && tag.args) {
          // An exact-content raw body remains protected through EOF without its exact terminator.
          tokens.push({
            type: "RawBlock",
            raw: text.slice(cursor),
            content: tag.content,
            details: {
              kind: "unclosed-template",
              keyword: tag.name,
              args: tag.args,
              body: undefined,
              endArgs: undefined,
            },
            start: cursor,
            end: text.length,
            ...tokenState,
          });
          cursor = text.length;
          continue;
        }
      }

      tokens.push(tag);
      cursor = end;
      continue;
    }

    const next = findNextSpecial(text, cursor + 1, specialPattern);
    tokens.push(createTextToken(text.slice(cursor, next), cursor, next, tokenState));
    cursor = next;
  }

  return { tokens, preserveOriginalText, htmlComments };
}

function countPreNewLines(text: string, to: number): number {
  let count = 0;
  while (to > 0 && /\s/.test(text[to - 1])) {
    to -= 1;
    if (text[to] === "\n") count += 1;
  }
  return count;
}

function matchesEnd(start: TemplateTagNode, endName: string): boolean {
  return getExpectedEndNames(start.keyword).includes(endName);
}

function hasMatchingBranchParent(token: TagToken, stack: OpenBlock[]): boolean {
  return isPermittedBranch(stack.at(-1)?.start.keyword, token.name);
}

function actsAsEndTag(token: TagToken, expectedEndCounts: Map<string, number>): boolean {
  return token.role === "end" || (expectedEndCounts.get(token.name) ?? 0) > 0;
}

function shouldInlineStandalone(tag: TagToken): boolean {
  return tag.hostContext !== "document-flow" || getStandaloneFlow(tag.name, tag.args) === "inline";
}

function getStandaloneTagsWithLaterEnds(tokens: Token[]): Set<number> {
  const laterTagNames = new Set<string>();
  const matches = new Set<number>();

  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token.type !== "Tag") {
      continue;
    }

    if (
      token.role === "standalone" &&
      getTagRole(token.name) !== "start" &&
      getExpectedEndNames(token.name).some((endName) => laterTagNames.has(endName))
    ) {
      matches.add(index);
    }
    laterTagNames.add(token.name);
  }

  return matches;
}

function followsIgnoredRegionOrHtmlComment(tokens: Token[], index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const token = tokens[cursor];
    if (token.type === "Text" && /^\s*$/.test(token.raw)) {
      continue;
    }

    if (token.type === "IgnoreRegion") {
      return true;
    }

    return token.type === "Text" && token.raw.startsWith("<!--") && token.raw.endsWith("-->");
  }

  return false;
}

function protectedMarkerKindForToken(token: Token, forceBlock = false): ProtectedMarkerKind {
  // Block markers invite HTML layout whitespace even when their source is preserved.
  if (
    token.inPreformatted ||
    (token.inInlineFlow && token.type === "Tag" && token.role === "standalone")
  ) {
    return "inline";
  }
  if (token.hostContext === "start-tag") {
    return "attr";
  }

  if (forceBlock) {
    return "block";
  }

  if (token.type === "Tag" && token.role === "standalone" && !shouldInlineStandalone(token)) {
    return "block";
  }

  if (token.type === "IgnoreRegion" || token.type === "RawBlock") {
    return token.hostContext !== "document-flow" ? "inline" : "block";
  }

  return "inline";
}

interface OpenBlock {
  start: TemplateTagNode;
  parts: string[];
  childIds: string[];
}

export function parse(text: string): RootNode {
  const { tokens, preserveOriginalText, htmlComments } = tokenize(text);
  const standaloneTagsWithLaterEnds = getStandaloneTagsWithLaterEnds(tokens);
  const nodes: Record<string, DjangoNode> = {};
  const rootParts: string[] = [];
  const root: DraftRoot = {
    type: "root",
    id: "root",
    html: "",
    sourceText: text,
    preserveOriginalText,
    preNewLines: 0,
    sourceStart: 0,
    sourceEnd: text.length,
    nodes,
    protectedMarkerKind: "block",
    hostContext: "document-flow",
  };

  const markerAllocator = new InternalMarkerAllocator(text);
  const stack: OpenBlock[] = [];
  const expectedEndCounts = new Map<string, number>();
  const updateExpectedEnds = (keyword: string, change: 1 | -1) => {
    for (const endName of getExpectedEndNames(keyword)) {
      const nextCount = (expectedEndCounts.get(endName) ?? 0) + change;
      if (nextCount === 0) {
        expectedEndCounts.delete(endName);
      } else {
        expectedEndCounts.set(endName, nextCount);
      }
    }
  };
  const createId = (token: Token, forceBlock = false) =>
    markerAllocator.allocate(protectedMarkerKindForToken(token, forceBlock));
  const append = (value: string, childId?: string) => {
    const frame = stack.at(-1);
    (frame?.parts ?? rootParts).push(value);
    if (childId && frame) {
      frame.childIds.push(childId);
    }
  };

  // Track line breaks once instead of rescanning overlapping source slices at
  // every block closure (quadratic for deeply nested single-line templates).
  const leadingWhitespaceEnd = text.search(/\S/);
  let lastNewline = -1;
  let nextNewline = text.indexOf("\n");
  for (const [tokenIndex, token] of tokens.entries()) {
    while (nextNewline !== -1 && nextNewline < token.end) {
      lastNewline = nextNewline;
      nextNewline = text.indexOf("\n", nextNewline + 1);
    }
    if (token.type === "Text") {
      append(token.raw);
      continue;
    }

    const rawPreNewLines =
      token.start === leadingWhitespaceEnd ? 0 : countPreNewLines(text, token.start);
    const preNewLines =
      rawPreNewLines > 1 && followsIgnoredRegionOrHtmlComment(tokens, tokenIndex)
        ? rawPreNewLines - 1
        : rawPreNewLines;

    const base = {
      id: createId(token),
      sourceText: token.raw,
      preserveOriginalText: token.inPreformatted,
      preNewLines,
      sourceStart: token.start,
      sourceEnd: token.end,
      protectedMarkerKind: protectedMarkerKindForToken(token),
      hostContext: token.hostContext,
    };

    if (token.type === "Expression") {
      const node: ExpressionNode = { ...base, type: "expression", content: token.content };
      nodes[node.id] = node;
      append(node.id, node.id);
      continue;
    }

    if (token.type === "Comment") {
      const node: CommentNode = { ...base, type: "comment", content: token.content };
      nodes[node.id] = node;
      append(node.id, node.id);
      continue;
    }

    if (token.type === "IgnoreRegion") {
      const node: IgnoreRegionNode = {
        ...base,
        type: "ignore-region",
        content: token.raw,
        closed: token.closed,
      };
      nodes[node.id] = node;
      append(node.id, node.id);
      continue;
    }

    if (token.type === "RawBlock") {
      const node: RawBlockNode = {
        ...base,
        ...token.details,
        type: "raw-block",
        content: token.raw,
      };
      nodes[node.id] = node;
      append(node.id, node.id);
      continue;
    }

    const node: TemplateTagNode = {
      ...base,
      type: "template-tag",
      content: token.content,
      keyword: token.name,
      role: token.role,
    };
    if (token.role === "branch") {
      if (!hasMatchingBranchParent(token, stack)) {
        throw new Error(`No start tag found for template branch tag "{% ${node.content} %}".`);
      }

      nodes[node.id] = node;
      append(node.id, node.id);
      continue;
    }

    if (actsAsEndTag(token, expectedEndCounts)) {
      const endNode = node;
      endNode.role = "end";
      nodes[endNode.id] = endNode;

      const frame = stack.at(-1);
      if (
        !frame ||
        (!matchesEnd(frame.start, token.name) &&
          !stack.some((open) => matchesEnd(open.start, token.name)))
      ) {
        throw new Error(`No start tag found for template end tag "{% ${endNode.content} %}".`);
      }
      if (!matchesEnd(frame.start, token.name)) {
        throw new Error(
          `Unexpected template end tag "{% ${endNode.content} %}" while "{% ${frame.start.content} %}" is still open.`,
        );
      }

      stack.pop();
      updateExpectedEnds(frame.start.keyword, -1);
      const content = frame.parts.join("");
      const blockText = text.slice(frame.start.sourceStart, token.end);
      const blockId = markerAllocator.allocate(
        protectedMarkerKindForToken(token, frame.start.hostContext === "document-flow"),
      );
      const blockNode: TemplateBlockNode = {
        type: "template-block",
        id: blockId,
        html: content,
        sourceText: blockText,
        preNewLines: frame.start.preNewLines,
        sourceStart: frame.start.sourceStart,
        sourceEnd: token.end,
        nodes,
        protectedMarkerKind:
          frame.start.hostContext === "start-tag"
            ? "attr"
            : frame.start.hostContext === "attribute-value" || frame.start.preserveOriginalText
              ? "inline"
              : "block",
        preserveOriginalText: frame.start.preserveOriginalText,
        start: frame.start,
        end: endNode,
        childIds: frame.childIds,
        containsNewLines: lastNewline >= frame.start.sourceStart,
        hostContext: frame.start.hostContext,
      };
      const parentBlockHasHtmlMarkup = scanHtmlHostContexts(content).tags.length > 0;
      const context = {
        host: blockNode.hostContext,
        hasHtmlMarkup: parentBlockHasHtmlMarkup,
      };
      frame.start.parentBlock = { id: blockId, relationship: "start", context };
      endNode.parentBlock = { id: blockId, relationship: "end", context };
      for (const childId of frame.childIds) {
        nodes[childId].parentBlock = { id: blockId, relationship: "content", context };
      }
      nodes[blockId] = blockNode;
      append(blockId, blockId);
      continue;
    }

    nodes[node.id] = node;
    if (token.role === "standalone" && !standaloneTagsWithLaterEnds.has(tokenIndex)) {
      append(node.id, node.id);
      continue;
    }

    stack.push({ start: node, parts: [], childIds: [] });
    updateExpectedEnds(node.keyword, 1);
  }

  for (const frame of stack) {
    rootParts.push(frame.start.id);
    for (const part of frame.parts) {
      rootParts.push(part);
    }
  }

  root.html = rootParts.join("");
  if (!preserveOriginalText) {
    protectHtmlComments(root, htmlComments, markerAllocator);
  }
  return finishDocument(root);
}
