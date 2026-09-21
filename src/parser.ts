import { scanHtmlHostContexts } from "./html-host-context.js";
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
  TemplateBlockNode,
  CommentNode,
  DjangoNode,
  ExpressionNode,
  IgnoreRegionNode,
  ProtectedMarkerKind,
  RawBlockNode,
  RootNode,
  TemplateTagNode,
} from "./ast.js";

const NOT_FOUND = -1;

type TokenType = "Text" | "Expression" | "Comment" | "Tag" | "RawBlock" | "IgnoreRegion";

interface TokenBase {
  type: TokenType;
  raw: string;
  content: string;
  start: number;
  end: number;
  inAttribute: boolean;
  inTag: boolean;
  inPreformatted: boolean;
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
  role: "start" | "branch" | "end" | "standalone";
}

interface RawBlockToken extends TokenBase {
  type: "RawBlock";
  name: string;
  args: string;
  body?: string;
  endArgs?: string;
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
  state: Pick<TokenBase, "inAttribute" | "inTag" | "inPreformatted">,
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
  state: Pick<TokenBase, "inAttribute" | "inTag" | "inPreformatted">,
): TagToken {
  const content = normalizeTemplateTagContent(raw.slice(2, -2));
  const [name = "", ...rest] = content.split(/\s+/);

  return {
    type: "Tag",
    raw,
    content,
    name,
    args: rest.join(" "),
    role: getTagRole(name),
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
  const hostContexts = scanHtmlHostContexts(text);
  const tokens: Token[] = [];
  const specialPattern = /{{|{#|{%|<!--/g;
  // Python's non-DOTALL dot excludes LF, but permits CR and Unicode line separators.
  const templatePattern = /{{[^\n]*?}}|{#[^\n]*?#}|{%[^\n]*?%}/y;
  let cursor = 0;
  let preserveOriginalText = false;
  let htmlCommentEnd = 0;

  while (cursor < text.length) {
    const hostContext = hostContexts.at(cursor);
    const tokenState = {
      inAttribute: hostContext === "attribute-value",
      inTag: hostContext !== "document-flow",
      inPreformatted: hostContext === "document-flow" && hostContexts.isPreformattedAt(cursor),
    };

    const ignoreDelimiter = IGNORE_REGION_DELIMITERS.find(({ opener }) =>
      text.startsWith(opener, cursor),
    );
    if (ignoreDelimiter) {
      preserveOriginalText ||= cursor < htmlCommentEnd;
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
      if (cursor >= htmlCommentEnd) {
        htmlCommentEnd = readUntil(text, cursor + 4, "-->");
      }
      const end = Math.min(htmlCommentEnd, findNextSpecial(text, cursor + 4, specialPattern));
      const raw = text.slice(cursor, end);
      tokens.push(createTextToken(raw, cursor, end, tokenState));
      cursor = end;
      continue;
    }

    templatePattern.lastIndex = cursor;
    const templateMatch = templatePattern.exec(text);
    // HTML comments protect formatting, not Django syntax. A block may cross their edges,
    // so avoid passing fragments of that comment to the HTML printer while still validating it.
    preserveOriginalText ||= Boolean(templateMatch) && cursor < htmlCommentEnd;
    if (!templateMatch && /^{[{#%]/.test(text.slice(cursor, cursor + 2))) {
      // Formatting literal delimiters could remove the LF that prevents Django recognition.
      // Preserve the document, but keep scanning so nested valid constructs are still parsed.
      preserveOriginalText = true;
      const end = findNextSpecial(text, cursor + 1, specialPattern);
      tokens.push(createTextToken(text.slice(cursor, end), cursor, end, tokenState));
      cursor = end;
      continue;
    }

    if (text.startsWith("{{", cursor)) {
      const end = cursor + templateMatch![0].length;
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

    if (text.startsWith("{#", cursor)) {
      const end = cursor + templateMatch![0].length;
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

    if (text.startsWith("{%", cursor)) {
      const end = cursor + templateMatch![0].length;
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
            name: tag.name,
            args: tag.args,
            body: text.slice(end, blockEndInfo.closingStart),
            endArgs: blockEndInfo.endArgs,
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
            name: tag.name,
            args: tag.args,
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

  return { tokens, preserveOriginalText };
}

function countPreNewLines(text: string, to: number): number {
  let from = to;
  while (from > 0 && /\s/.test(text[from - 1])) {
    from -= 1;
  }

  const segment = text.slice(from, to);
  if (!/^\s*$/.test(segment)) {
    return 0;
  }

  return segment.split("\n").length - 1;
}

function normalizeRaw(token: Token): string {
  if (token.inPreformatted) {
    return token.raw;
  }
  switch (token.type) {
    case "Expression":
      return `{{ ${token.content.trim()} }}`;
    case "Comment":
      return `{# ${token.content.trim()} #}`;
    case "Tag":
      return `{% ${token.content.trim()} %}`;
    case "RawBlock":
    case "IgnoreRegion":
      return token.raw;
    default:
      return token.raw;
  }
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
  return tag.inAttribute || tag.inTag || getStandaloneFlow(tag.name, tag.args) === "inline";
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
  if (token.inPreformatted) {
    return "inline";
  }
  if (token.inTag && !token.inAttribute) {
    return "attr";
  }

  if (forceBlock) {
    return "block";
  }

  if (token.type === "Tag" && token.role === "standalone" && !shouldInlineStandalone(token)) {
    return "block";
  }

  if (token.type === "IgnoreRegion" || token.type === "RawBlock") {
    return token.inTag || token.inAttribute ? "inline" : "block";
  }

  return "inline";
}

interface OpenBlock {
  start: TemplateTagNode;
  parts: string[];
  childIds: string[];
}

export function parse(text: string): RootNode {
  const { tokens, preserveOriginalText } = tokenize(text);
  const standaloneTagsWithLaterEnds = getStandaloneTagsWithLaterEnds(tokens);
  const nodes: Record<string, DjangoNode> = {};
  const rootParts: string[] = [];
  const root: RootNode = {
    type: "root",
    id: "root",
    content: "",
    originalText: text,
    preserveOriginalText,
    preNewLines: 0,
    sourceStart: 0,
    sourceEnd: text.length,
    nodes,
    protectedMarkerKind: "block",
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

  for (const [tokenIndex, token] of tokens.entries()) {
    if (token.type === "Text") {
      append(token.raw);
      continue;
    }

    const rawPreNewLines = countPreNewLines(text, token.start);
    const preNewLines =
      rawPreNewLines > 1 && followsIgnoredRegionOrHtmlComment(tokens, tokenIndex)
        ? rawPreNewLines - 1
        : rawPreNewLines;

    if (token.type === "Expression") {
      const id = createId(token);
      const node: ExpressionNode = {
        type: "expression",
        id,
        content: token.content,
        originalText: normalizeRaw(token),
        preserveOriginalText: token.inPreformatted,
        preNewLines,
        sourceStart: token.start,
        sourceEnd: token.end,
        protectedMarkerKind: protectedMarkerKindForToken(token),
        inTag: token.inTag,
        inAttribute: token.inAttribute,
      };
      nodes[id] = node;
      append(id, id);
      continue;
    }

    if (token.type === "Comment") {
      const id = createId(token);
      const node: CommentNode = {
        type: "comment",
        id,
        content: token.content,
        originalText: normalizeRaw(token),
        preserveOriginalText: token.inPreformatted,
        preNewLines,
        sourceStart: token.start,
        sourceEnd: token.end,
        protectedMarkerKind: protectedMarkerKindForToken(token),
        inTag: token.inTag,
        inAttribute: token.inAttribute,
      };
      nodes[id] = node;
      append(id, id);
      continue;
    }

    if (token.type === "IgnoreRegion") {
      const id = createId(token, !token.inTag && !token.inAttribute);
      const node: IgnoreRegionNode = {
        type: "ignore-region",
        id,
        content: token.raw,
        originalText: token.raw,
        preserveOriginalText: token.inPreformatted,
        preNewLines,
        sourceStart: token.start,
        sourceEnd: token.end,
        protectedMarkerKind: protectedMarkerKindForToken(token, !token.inTag && !token.inAttribute),
        inTag: token.inTag,
        inAttribute: token.inAttribute,
        closed: token.closed,
      };
      nodes[id] = node;
      append(id, id);
      continue;
    }

    if (token.type === "RawBlock") {
      const id = createId(token, !token.inTag && !token.inAttribute);
      const node: RawBlockNode = {
        type: "raw-block",
        id,
        content: token.raw,
        originalText: token.raw,
        preserveOriginalText: token.inPreformatted,
        preNewLines,
        sourceStart: token.start,
        sourceEnd: token.end,
        protectedMarkerKind: protectedMarkerKindForToken(token, !token.inTag && !token.inAttribute),
        inTag: token.inTag,
        inAttribute: token.inAttribute,
        keyword: token.name,
        args: token.args,
        body: token.body,
        endArgs: token.endArgs,
      };
      nodes[id] = node;
      append(id, id);
      continue;
    }

    const templateTagBase = {
      id: createId(token),
      content: token.content,
      originalText: normalizeRaw(token),
      preserveOriginalText: token.inPreformatted,
      preNewLines,
      sourceStart: token.start,
      sourceEnd: token.end,
      keyword: token.name,
      role: token.role,
      protectedMarkerKind: protectedMarkerKindForToken(token),
      inTag: token.inTag,
      inAttribute: token.inAttribute,
    } as const;
    if (token.role === "branch") {
      if (!hasMatchingBranchParent(token, stack)) {
        throw new Error(
          `No start tag found for template branch tag "${templateTagBase.originalText}".`,
        );
      }

      const node: TemplateTagNode = { type: "template-tag", ...templateTagBase };
      nodes[node.id] = node;
      append(node.id, node.id);
      continue;
    }

    if (actsAsEndTag(token, expectedEndCounts)) {
      const endNode: TemplateTagNode = {
        type: "template-tag",
        ...templateTagBase,
        role: "end",
      };
      nodes[endNode.id] = endNode;

      let matchIndex = NOT_FOUND;
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (matchesEnd(stack[index].start, token.name)) {
          matchIndex = index;
          break;
        }
      }

      if (matchIndex === NOT_FOUND) {
        throw new Error(`No start tag found for template end tag "${endNode.originalText}".`);
      }
      if (matchIndex !== stack.length - 1) {
        const innerOpen = stack.at(-1)!.start;
        throw new Error(
          `Unexpected template end tag "${endNode.originalText}" while "${innerOpen.originalText}" is still open.`,
        );
      }

      const frame = stack.pop()!;
      updateExpectedEnds(frame.start.keyword, -1);
      const content = frame.parts.join("");
      const blockText = text.slice(frame.start.sourceStart, token.end);
      const blockId = markerAllocator.allocate(
        protectedMarkerKindForToken(token, !frame.start.inTag && !frame.start.inAttribute),
      );
      const blockNode: TemplateBlockNode = {
        type: "template-block",
        id: blockId,
        content,
        originalText: blockText,
        preNewLines: frame.start.preNewLines,
        sourceStart: frame.start.sourceStart,
        sourceEnd: token.end,
        nodes,
        protectedMarkerKind:
          frame.start.inTag || frame.start.inAttribute || frame.start.preserveOriginalText
            ? "inline"
            : "block",
        preserveOriginalText: frame.start.preserveOriginalText,
        start: frame.start,
        end: endNode,
        childIds: frame.childIds,
        containsNewLines: /\n/.test(blockText),
        inTag: frame.start.inTag,
        inAttribute: frame.start.inAttribute,
      };
      const parentBlockHasHtmlMarkup = /<(?!!--)[A-Za-z/!][^>]*>/.test(content);
      frame.start.parentBlockId = blockId;
      endNode.parentBlockId = blockId;
      endNode.parentBlockRelationship = "end";
      endNode.parentBlockInTag = blockNode.inTag;
      endNode.parentBlockInAttribute = blockNode.inAttribute;
      endNode.parentBlockHasHtmlMarkup = parentBlockHasHtmlMarkup;
      for (const childId of frame.childIds) {
        const child = nodes[childId];
        child.parentBlockId = blockId;
        child.parentBlockRelationship = "content";
        child.parentBlockInTag = blockNode.inTag;
        child.parentBlockInAttribute = blockNode.inAttribute;
        child.parentBlockHasHtmlMarkup = parentBlockHasHtmlMarkup;
      }
      nodes[blockId] = blockNode;
      append(blockId, blockId);
      continue;
    }

    const node: TemplateTagNode = { type: "template-tag", ...templateTagBase };
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

  root.content = rootParts.join("");
  return root;
}
