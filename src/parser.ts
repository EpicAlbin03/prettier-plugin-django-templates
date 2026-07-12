import type { Parser } from "prettier";
import { InternalMarkerAllocator } from "./internal-markers.js";
import { getTagRole, isBlockStandaloneTag, isInlineStandaloneTag, isRawTag } from "./tags.js";
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

type TokenType = "Text" | "Variable" | "Comment" | "Tag" | "RawBlock" | "IgnoreBlock";

interface TokenBase {
  type: TokenType;
  raw: string;
  content: string;
  start: number;
  end: number;
  inAttribute: boolean;
  inTag: boolean;
}

interface TextToken extends TokenBase {
  type: "Text";
}

interface VariableToken extends TokenBase {
  type: "Variable";
}

interface CommentToken extends TokenBase {
  type: "Comment";
}

interface IgnoreBlockToken extends TokenBase {
  type: "IgnoreBlock";
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

type Token = TextToken | VariableToken | CommentToken | IgnoreBlockToken | TagToken | RawBlockToken;

interface IgnoreDelimiterPair {
  opener: string;
  closer: string;
}

const IGNORE_BLOCK_DELIMITERS: readonly IgnoreDelimiterPair[] = [
  {
    opener: "<!-- prettier-ignore-start -->",
    closer: "<!-- prettier-ignore-end -->",
  },
  {
    opener: "{# prettier-ignore-start #}",
    closer: "{# prettier-ignore-end #}",
  },
];

function readUntil(text: string, start: number, endToken: string, errorMessage?: string): number {
  const end = text.indexOf(endToken, start);
  if (end === -1) {
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    return text.length;
  }
  return end + endToken.length;
}

function findNextSpecial(text: string, from: number): number {
  const candidates = [
    text.indexOf("{{", from),
    text.indexOf("{#", from),
    text.indexOf("{%", from),
    text.indexOf("<!--", from),
  ].filter((index) => index !== -1);

  return candidates.length === 0 ? text.length : Math.min(...candidates);
}

function getHtmlState(text: string): Array<{ inAttribute: boolean; inTag: boolean }> {
  const states = Array.from<{ inAttribute: boolean; inTag: boolean }>({ length: text.length });
  let quote: '"' | "'" | null = null;
  let inTag = false;

  for (let index = 0; index < text.length; index += 1) {
    states[index] = { inAttribute: quote !== null, inTag };
    const char = text[index];

    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "<") {
      const next = text[index + 1] ?? "";
      if (/[A-Za-z!/]/.test(next)) {
        inTag = true;
      }
      continue;
    }

    if (char === ">") {
      inTag = false;
      continue;
    }

    if ((char === '"' || char === "'") && inTag) {
      quote = char;
    }
  }

  return states;
}

function createTextToken(
  text: string,
  start: number,
  end: number,
  state: { inAttribute: boolean; inTag: boolean },
): TextToken {
  return {
    type: "Text",
    raw: text,
    content: text,
    start,
    end,
    inAttribute: state.inAttribute,
    inTag: state.inTag,
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
  state: { inAttribute: boolean; inTag: boolean },
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
    inAttribute: state.inAttribute,
    inTag: state.inTag,
  };
}

function findRawBlockEnd(
  text: string,
  from: number,
  name: string,
  openingContent: string,
): { end: number; closingStart: number; endArgs: string } | null {
  // Django's lexer ends verbatim only when the complete stripped tag content matches.
  const expectedClosingContent = `end${openingContent}`;
  const endName = `end${name}`;
  let cursor = from;

  while (cursor < text.length) {
    const tagStart = text.indexOf("{%", cursor);
    if (tagStart === -1) {
      return null;
    }

    const closeDelimiter = text.indexOf("%}", tagStart + 2);
    if (closeDelimiter === -1) {
      return null;
    }

    const tagContent = text.slice(tagStart + 2, closeDelimiter).trim();
    const [tagName, ...rest] = tagContent.split(/\s+/);
    const isMatchingEnd =
      name === "verbatim" ? tagContent === expectedClosingContent : tagName === endName;

    if (isMatchingEnd) {
      return {
        end: closeDelimiter + 2,
        closingStart: tagStart,
        endArgs: rest.join(" "),
      };
    }

    cursor = closeDelimiter + 2;
  }

  return null;
}

function findIgnoreBlockEnd(
  text: string,
  from: number,
  delimiter: IgnoreDelimiterPair,
): { end: number; closed: boolean } {
  const closerStart = text.indexOf(delimiter.closer, from);
  return closerStart === -1
    ? { end: text.length, closed: false }
    : { end: closerStart + delimiter.closer.length, closed: true };
}

function tokenize(text: string): Token[] {
  const state = getHtmlState(text);
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const tokenState = state[cursor] ?? { inAttribute: false, inTag: false };

    const ignoreDelimiter = IGNORE_BLOCK_DELIMITERS.find(({ opener }) =>
      text.startsWith(opener, cursor),
    );
    if (ignoreDelimiter) {
      const { end, closed } = findIgnoreBlockEnd(
        text,
        cursor + ignoreDelimiter.opener.length,
        ignoreDelimiter,
      );
      const raw = text.slice(cursor, end);
      tokens.push({
        type: "IgnoreBlock",
        raw,
        content: raw,
        start: cursor,
        end,
        inAttribute: tokenState.inAttribute,
        inTag: tokenState.inTag,
        closed,
      });
      cursor = end;
      continue;
    }

    if (text.startsWith("<!--", cursor)) {
      const end = readUntil(text, cursor + 4, "-->");
      const raw = text.slice(cursor, end);
      tokens.push(createTextToken(raw, cursor, end, tokenState));
      cursor = end;
      continue;
    }

    if (text.startsWith("{{", cursor)) {
      const end = readUntil(
        text,
        cursor + 2,
        "}}",
        `Unterminated template expression starting at index ${cursor}.`,
      );
      const raw = text.slice(cursor, end);
      tokens.push({
        type: "Variable",
        raw,
        content: raw.slice(2, -2),
        start: cursor,
        end,
        inAttribute: tokenState.inAttribute,
        inTag: tokenState.inTag,
      });
      cursor = end;
      continue;
    }

    if (text.startsWith("{#", cursor)) {
      const end = readUntil(
        text,
        cursor + 2,
        "#}",
        `Unterminated template comment starting at index ${cursor}.`,
      );
      const raw = text.slice(cursor, end);
      tokens.push({
        type: "Comment",
        raw,
        content: raw.slice(2, -2),
        start: cursor,
        end,
        inAttribute: tokenState.inAttribute,
        inTag: tokenState.inTag,
      });
      cursor = end;
      continue;
    }

    if (text.startsWith("{%", cursor)) {
      const end = readUntil(
        text,
        cursor + 2,
        "%}",
        `Unterminated template tag starting at index ${cursor}.`,
      );
      const raw = text.slice(cursor, end);
      const tag = createTagToken(raw, cursor, end, tokenState);

      if (isRawTag(tag.name) && !tag.inTag && !tag.inAttribute) {
        const openingContent = raw.slice(2, -2).trim();
        const blockEndInfo = findRawBlockEnd(text, end, tag.name, openingContent);
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
            inAttribute: tokenState.inAttribute,
            inTag: tokenState.inTag,
          });
          cursor = blockEndInfo.end;
          continue;
        }

        if (tag.name === "verbatim" && tag.args) {
          // Django's lexer remains in named verbatim mode through EOF without an exact terminator.
          tokens.push({
            type: "RawBlock",
            raw: text.slice(cursor),
            content: tag.content,
            name: tag.name,
            args: tag.args,
            start: cursor,
            end: text.length,
            inAttribute: tokenState.inAttribute,
            inTag: tokenState.inTag,
          });
          cursor = text.length;
          continue;
        }
      }

      tokens.push(tag);
      cursor = end;
      continue;
    }

    const next = findNextSpecial(text, cursor + 1);
    tokens.push(createTextToken(text.slice(cursor, next), cursor, next, tokenState));
    cursor = next;
  }

  return tokens;
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

function replaceAt(text: string, replacement: string, start: number, length: number): string {
  return text.slice(0, start) + replacement + text.slice(start + length);
}

function normalizeRaw(token: Token): string {
  switch (token.type) {
    case "Variable":
      return `{{ ${token.content.trim()} }}`;
    case "Comment":
      return `{# ${token.content.trim()} #}`;
    case "Tag":
      return `{% ${token.content.trim()} %}`;
    case "RawBlock":
    case "IgnoreBlock":
      return token.raw;
    default:
      return token.raw;
  }
}

function expectedEndNames(startName: string): string[] {
  const candidates = [`end${startName}`];

  if (startName.endsWith("_custom_end")) {
    candidates.push(startName.replace(/_custom_end$/, "end"));
  }

  if (startName.startsWith("dnd_")) {
    candidates.push(`end_${startName}`);
  }

  return candidates;
}

function matchesEnd(start: TemplateTagNode, endName: string): boolean {
  return expectedEndNames(start.keyword).includes(endName);
}

const BRANCH_PARENTS: Record<string, string[]> = {
  elif: ["if"],
  else: ["if", "for", "ifchanged", "ifequal", "ifnotequal", "flag"],
  empty: ["for"],
  plural: ["blocktranslate", "blocktrans"],
};

function hasMatchingBranchParent(token: TagToken, stack: TemplateTagNode[]): boolean {
  return BRANCH_PARENTS[token.name]?.includes(stack[stack.length - 1]?.keyword) ?? false;
}

function actsAsEndTag(token: TagToken, stack: TemplateTagNode[]): boolean {
  return token.role === "end" || stack.some((entry) => matchesEnd(entry, token.name));
}

function isStandaloneUrlAssignment(tag: TagToken): boolean {
  return tag.name === "url" && /\bas\s+\S+$/.test(tag.args);
}

function shouldInlineStandalone(tag: TagToken): boolean {
  if (isStandaloneUrlAssignment(tag) && !tag.inAttribute && !tag.inTag) {
    return false;
  }

  if (isBlockStandaloneTag(tag.name) && !tag.inAttribute && !tag.inTag) {
    return false;
  }

  return isInlineStandaloneTag(tag.name) || tag.inAttribute || tag.inTag;
}

function hasMatchingEnd(tokens: Token[], startIndex: number, startName: string): boolean {
  const endNames = new Set(expectedEndNames(startName));
  return tokens
    .slice(startIndex + 1)
    .some((token) => token.type === "Tag" && endNames.has(token.name));
}

function followsIgnoredRegionOrHtmlComment(tokens: Token[], index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const token = tokens[cursor];
    if (token.type === "Text" && /^\s*$/.test(token.raw)) {
      continue;
    }

    if (token.type === "IgnoreBlock") {
      return true;
    }

    return token.type === "Text" && token.raw.startsWith("<!--") && token.raw.endsWith("-->");
  }

  return false;
}

function protectedMarkerKindForToken(token: Token, forceBlock = false): ProtectedMarkerKind {
  if (token.inTag && !token.inAttribute) {
    return "attr";
  }

  if (forceBlock) {
    return "block";
  }

  if (token.type === "Tag" && token.role === "standalone" && !shouldInlineStandalone(token)) {
    return "block";
  }

  if (token.type === "IgnoreBlock" || token.type === "RawBlock") {
    return token.inTag || token.inAttribute ? "inline" : "block";
  }

  return "inline";
}

export const parse: Parser<DjangoNode>["parse"] = (text) => {
  const tokens = tokenize(text);
  const nodes: Record<string, DjangoNode> = {};
  const root: RootNode = {
    type: "root",
    id: "root",
    content: text,
    originalText: text,
    preNewLines: 0,
    sourceStart: 0,
    sourceEnd: text.length,
    nodes,
    protectedMarkerKind: "block",
  };

  const markerAllocator = new InternalMarkerAllocator(text);
  const protectedSpans = new Map<string, { start: number; length: number }>();
  let delta = 0;
  const stack: TemplateTagNode[] = [];

  const createId = (token: Token, forceBlock = false) =>
    markerAllocator.allocate(protectedMarkerKindForToken(token, forceBlock));

  for (const [tokenIndex, token] of tokens.entries()) {
    const currentIndex = token.start + delta;
    const rawPreNewLines = countPreNewLines(text, token.start);
    const preNewLines =
      rawPreNewLines > 1 && followsIgnoredRegionOrHtmlComment(tokens, tokenIndex)
        ? rawPreNewLines - 1
        : rawPreNewLines;

    if (token.type === "Text") {
      continue;
    }

    if (token.type === "Variable") {
      const id = createId(token);
      const node: ExpressionNode = {
        type: "expression",
        id,
        content: token.content,
        originalText: normalizeRaw(token),
        preNewLines,
        sourceStart: token.start,
        sourceEnd: token.end,
        nodes,
        protectedMarkerKind: protectedMarkerKindForToken(token),
        inTag: token.inTag,
        inAttribute: token.inAttribute,
      };
      nodes[id] = node;
      root.content = replaceAt(root.content, id, currentIndex, token.raw.length);
      delta += id.length - token.raw.length;
      continue;
    }

    if (token.type === "Comment") {
      const id = createId(token);
      const node: CommentNode = {
        type: "comment",
        id,
        content: token.content,
        originalText: normalizeRaw(token),
        preNewLines,
        sourceStart: token.start,
        sourceEnd: token.end,
        nodes,
        protectedMarkerKind: protectedMarkerKindForToken(token),
        inTag: token.inTag,
        inAttribute: token.inAttribute,
      };
      nodes[id] = node;
      root.content = replaceAt(root.content, id, currentIndex, token.raw.length);
      delta += id.length - token.raw.length;
      continue;
    }

    if (token.type === "IgnoreBlock") {
      const id = createId(token, !token.inTag && !token.inAttribute);
      const node: IgnoreRegionNode = {
        type: "ignore-region",
        id,
        content: token.raw,
        originalText: token.raw,
        preNewLines,
        sourceStart: token.start,
        sourceEnd: token.end,
        nodes,
        protectedMarkerKind: protectedMarkerKindForToken(token, !token.inTag && !token.inAttribute),
        inTag: token.inTag,
        inAttribute: token.inAttribute,
        closed: token.closed,
      };
      nodes[id] = node;
      root.content = replaceAt(root.content, id, currentIndex, token.raw.length);
      delta += id.length - token.raw.length;
      continue;
    }

    if (token.type === "RawBlock") {
      const id = createId(token, !token.inTag && !token.inAttribute);
      const node: RawBlockNode = {
        type: "raw-block",
        id,
        content: token.raw,
        originalText: token.raw,
        preNewLines,
        sourceStart: token.start,
        sourceEnd: token.end,
        nodes,
        protectedMarkerKind: protectedMarkerKindForToken(token, !token.inTag && !token.inAttribute),
        inTag: token.inTag,
        inAttribute: token.inAttribute,
        keyword: token.name,
        args: token.args,
        body: token.body,
        endArgs: token.endArgs,
      };
      nodes[id] = node;
      root.content = replaceAt(root.content, id, currentIndex, token.raw.length);
      delta += id.length - token.raw.length;
      continue;
    }

    const templateTagBase = {
      id: createId(token),
      content: token.content,
      originalText: normalizeRaw(token),
      preNewLines,
      sourceStart: token.start,
      sourceEnd: token.end,
      nodes,
      keyword: token.name,
      role: token.role,
      protectedMarkerKind: protectedMarkerKindForToken(token),
      inTag: token.inTag,
      inAttribute: token.inAttribute,
    } as const;
    protectedSpans.set(templateTagBase.id, { start: currentIndex, length: token.raw.length });

    if (token.role === "branch") {
      if (!hasMatchingBranchParent(token, stack)) {
        throw new Error(
          `No start tag found for template branch tag "${templateTagBase.originalText}".`,
        );
      }

      const node: TemplateTagNode = { type: "template-tag", ...templateTagBase };
      nodes[node.id] = node;
      root.content = replaceAt(root.content, node.id, currentIndex, token.raw.length);
      delta += node.id.length - token.raw.length;
      continue;
    }

    if (actsAsEndTag(token, stack)) {
      const endNode: TemplateTagNode = {
        type: "template-tag",
        ...templateTagBase,
        role: "end",
      };
      nodes[endNode.id] = endNode;

      let matchIndex = NOT_FOUND;
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (matchesEnd(stack[index], token.name)) {
          matchIndex = index;
          break;
        }
      }

      if (matchIndex === NOT_FOUND) {
        throw new Error(`No start tag found for template end tag "${endNode.originalText}".`);
      }

      if (matchIndex !== stack.length - 1) {
        const innerOpen = stack[stack.length - 1];
        throw new Error(
          `Unexpected template end tag "${endNode.originalText}" while "${innerOpen.originalText}" is still open.`,
        );
      }

      const startNode = stack.pop()!;
      const startProtectedSpan = protectedSpans.get(startNode.id)!;
      const blockText = root.content.slice(
        startProtectedSpan.start,
        currentIndex + token.raw.length,
      );
      const blockId = markerAllocator.allocate(
        protectedMarkerKindForToken(token, !startNode.inTag && !startNode.inAttribute),
      );
      const blockNode: TemplateBlockNode = {
        type: "template-block",
        id: blockId,
        content: blockText.slice(startProtectedSpan.length, blockText.length - token.raw.length),
        originalText: blockText,
        preNewLines: startNode.preNewLines,
        sourceStart: startNode.sourceStart,
        sourceEnd: token.end,
        nodes,
        protectedMarkerKind: startNode.inTag || startNode.inAttribute ? "inline" : "block",
        start: startNode,
        end: endNode,
        containsNewLines: /\n/.test(blockText),
        inTag: startNode.inTag,
        inAttribute: startNode.inAttribute,
      };
      nodes[blockId] = blockNode;
      root.content = replaceAt(root.content, blockId, startProtectedSpan.start, blockText.length);
      delta += blockId.length - blockText.length;
      continue;
    }

    if (token.role === "standalone") {
      const node: TemplateTagNode = { type: "template-tag", ...templateTagBase };
      nodes[node.id] = node;

      if (hasMatchingEnd(tokens, tokenIndex, token.name)) {
        stack.push(node);
        continue;
      }

      root.content = replaceAt(root.content, node.id, currentIndex, token.raw.length);
      delta += node.id.length - token.raw.length;
      continue;
    }

    const node: TemplateTagNode = { type: "template-tag", ...templateTagBase };
    nodes[node.id] = node;
    stack.push(node);
  }

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const node = stack[index];
    const protectedSpan = protectedSpans.get(node.id)!;
    root.content = replaceAt(root.content, node.id, protectedSpan.start, protectedSpan.length);
  }

  return root;
};
