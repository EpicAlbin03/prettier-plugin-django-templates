import { findProtectedTemplateRegionEnd } from "./template-regions.js";

export type HtmlHostContext = "document-flow" | "start-tag" | "attribute-value";

export interface HtmlAttribute {
  readonly valueStart?: number;
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

export interface HtmlTag {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly depth: number;
  readonly attributes: readonly string[];
  readonly attributeRanges: readonly HtmlAttribute[];
}

export const BLOCK_FLOW_ELEMENTS = new Set([
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

export function isInlineHtmlElement(name: string | undefined): boolean {
  return Boolean(name && !BLOCK_FLOW_ELEMENTS.has(name));
}

type RawTextElement = "script" | "style" | "textarea" | "title";

export interface HtmlHostContextIndex {
  readonly tags: readonly HtmlTag[];
  readonly comments: readonly { readonly start: number; readonly end: number }[];
  readonly balance:
    | { readonly unclosed: readonly string[]; readonly unexpectedClosings: readonly string[] }
    | undefined;
  at(offset: number): HtmlHostContext;
  isDocumentFlowNormalizationSafeAt(offset: number): boolean;
  isPreformattedAt(offset: number): boolean;
  elementAt(offset: number): string | undefined;
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

const DOCUMENT_FLOW = 0;
const START_TAG = 1;
const ATTRIBUTE_VALUE = 2;

const contextNames: readonly HtmlHostContext[] = ["document-flow", "start-tag", "attribute-value"];

const protectedConstructEnds = new Map([
  ["{{", "}}"],
  ["{%", "%}"],
  ["{#", "#}"],
]);

function fillContext(contexts: Uint8Array, from: number, to: number, context: number): void {
  contexts.fill(context, from, to);
}

function isRawTextClosingTag(source: string, offset: number, element: RawTextElement): boolean {
  let cursor = offset + 1;
  if (source[cursor] !== "/") {
    return false;
  }
  cursor += 1;
  while (/\s/.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  if (source.slice(cursor, cursor + element.length).toLowerCase() !== element) {
    return false;
  }
  return /[\s>]/.test(source[cursor + element.length] ?? "");
}

export function findHtmlTagEnd(source: string, tagStart: number): number | undefined {
  let quote: '"' | "'" | undefined;
  for (let offset = tagStart + 1; offset < source.length; offset += 1) {
    const char = source[offset];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return offset;
    }
  }
  return undefined;
}

/**
 * Indexes only the HTML-relative contexts needed by parser and printer callers.
 * Unclosed tags and quoted values conservatively retain their context through EOF.
 */
export function scanHtmlHostContexts(source: string): HtmlHostContextIndex {
  const contexts = new Uint8Array(source.length);
  const documentFlowNormalizationSafety = new Uint8Array(source.length).fill(1);
  let inTag = false;
  let quote: '"' | "'" | undefined;
  let tagStart = -1;
  let rawTextElement: RawTextElement | undefined;
  const preformatted = new Uint8Array(source.length);
  let preformattedStart: number | undefined;
  let preDepth = 0;
  const elements: string[] = [];
  const tags: HtmlTag[] = [];
  const comments: Array<{ start: number; end: number }> = [];
  const unexpectedClosings: string[] = [];
  let incomplete = false;
  const elementChanges: Array<{ offset: number; name: string | undefined }> = [];
  const events = /[<{>"']/g;

  for (let offset = 0; offset < source.length; offset += 1) {
    const context = quote ? ATTRIBUTE_VALUE : inTag ? START_TAG : DOCUMENT_FLOW;
    // Ordinary text cannot change scanner state. Fill its context in bulk and
    // let the regexp engine find the next potentially significant character.
    events.lastIndex = offset;
    const next = events.exec(source)?.index ?? source.length;
    fillContext(contexts, offset, Math.min(next + 1, source.length), context);
    if (rawTextElement && rawTextElement !== "textarea") {
      fillContext(documentFlowNormalizationSafety, offset, Math.min(next + 1, source.length), 0);
    }
    offset = next;
    if (offset === source.length) break;

    if (rawTextElement && rawTextElement !== "textarea") {
      if (source[offset] !== "<" || !isRawTextClosingTag(source, offset, rawTextElement)) {
        continue;
      }
      rawTextElement = undefined;
    }

    const protectedRegionEnd = findProtectedTemplateRegionEnd(
      source,
      offset,
      context === DOCUMENT_FLOW,
    );
    if (protectedRegionEnd !== undefined) {
      fillContext(contexts, offset, protectedRegionEnd, context);
      fillContext(documentFlowNormalizationSafety, offset, protectedRegionEnd, 0);
      offset = protectedRegionEnd - 1;
      continue;
    }

    const protectedEnd = protectedConstructEnds.get(source.slice(offset, offset + 2));
    if (protectedEnd) {
      const close = source.indexOf(protectedEnd, offset + 2);
      // Django's non-DOTALL lexer leaves LF-spanning and unclosed delimiters literal.
      // Their text can contain real HTML or another valid template construct.
      if (close !== -1 && !source.slice(offset, close).includes("\n")) {
        const end = close + protectedEnd.length;
        fillContext(contexts, offset, end, context);
        offset = end - 1;
        continue;
      }
    }

    // Textarea content is text, not markup, but Django constructs still need scanning.
    if (rawTextElement === "textarea") {
      if (source[offset] !== "<" || !isRawTextClosingTag(source, offset, "textarea")) {
        continue;
      }
      if (preDepth === 0 && preformattedStart !== undefined) {
        preformatted.fill(1, preformattedStart, offset);
        preformattedStart = undefined;
      }
      rawTextElement = undefined;
    }

    if (!inTag && source.startsWith("<!--", offset)) {
      const close = source.indexOf("-->", offset + 4);
      const end = close === -1 ? source.length : close + 3;
      incomplete ||= close === -1;
      comments.push({ start: offset, end });
      fillContext(contexts, offset, end, DOCUMENT_FLOW);
      fillContext(documentFlowNormalizationSafety, offset, end, 0);
      offset = end - 1;
      continue;
    }

    if (!inTag && (source.startsWith("<!", offset) || source.startsWith("<?", offset))) {
      const tagEnd = findHtmlTagEnd(source, offset);
      incomplete ||= tagEnd === undefined;
      const end = tagEnd === undefined ? source.length : tagEnd + 1;
      fillContext(contexts, offset, end, DOCUMENT_FLOW);
      fillContext(documentFlowNormalizationSafety, offset, end, 0);
      offset = end - 1;
      continue;
    }

    const char = source[offset];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (!inTag && char === "<" && /[A-Za-z/]/.test(source[offset + 1] ?? "")) {
      inTag = true;
      tagStart = offset;
      continue;
    }

    if (inTag && char === ">") {
      const tagText = source.slice(tagStart, offset + 1);
      const tag = tagText.match(/^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)/);
      if (tag) {
        const name = tag[2].toLowerCase();
        const closing = tag[1] === "/";
        const selfClosing = /\/\s*>$/.test(tagText) || HTML_VOID_ELEMENTS.has(name);
        const attributeOffset = tagStart + tag[0].length;
        const attributeText = tagText.slice(tag[0].length).replace(/\/?\s*>$/, "");
        const attributeRanges = closing ? [] : scanHtmlAttributes(attributeText, attributeOffset);
        for (const attribute of attributeRanges) {
          if (attribute.valueStart !== undefined) {
            fillContext(contexts, attribute.valueStart, attribute.end, ATTRIBUTE_VALUE);
          }
        }
        tags.push({
          start: tagStart,
          end: offset + 1,
          name,
          closing,
          selfClosing,
          depth: elements.length,
          attributes: attributeRanges.map(({ start, end }) => source.slice(start, end)),
          attributeRanges,
        });
        if (closing) {
          if (elements.at(-1) === name) {
            elements.pop();
          } else {
            unexpectedClosings.push(name);
          }
        } else if (!selfClosing) {
          elements.push(name);
        }
        elementChanges.push({ offset: offset + 1, name: elements.at(-1) });
      }
      const openingRawTextTag = tagText.match(/^<\s*(script|style|textarea|title)(?=[\s/>])/i)?.[1];
      const normalizedRawTextTag = openingRawTextTag?.toLowerCase();
      if (
        (normalizedRawTextTag === "script" ||
          normalizedRawTextTag === "style" ||
          normalizedRawTextTag === "textarea" ||
          normalizedRawTextTag === "title") &&
        !/\/\s*>$/.test(tagText)
      ) {
        rawTextElement = normalizedRawTextTag;
        if (normalizedRawTextTag === "textarea") {
          preformattedStart ??= offset + 1;
        }
      }
      if (/^<pre(?=[\s>])/i.test(tagText)) {
        preDepth += 1;
        preformattedStart ??= offset + 1;
      } else if (/^<\/pre\s*>/i.test(tagText) && preDepth > 0) {
        preDepth -= 1;
        if (preDepth === 0 && preformattedStart !== undefined) {
          preformatted.fill(1, preformattedStart, tagStart);
          preformattedStart = undefined;
        }
      }
      inTag = false;
      tagStart = -1;
      continue;
    }

    if (inTag && (char === '"' || char === "'")) {
      quote = char;
    }
  }

  if (preformattedStart !== undefined) {
    preformatted.fill(1, preformattedStart);
  }

  return {
    tags,
    comments,
    balance: incomplete || inTag ? undefined : { unclosed: elements, unexpectedClosings },
    at(offset: number): HtmlHostContext {
      return contextNames[contexts[offset] ?? DOCUMENT_FLOW];
    },
    isDocumentFlowNormalizationSafeAt(offset: number): boolean {
      return documentFlowNormalizationSafety[offset] === 1 && preformatted[offset] !== 1;
    },
    isPreformattedAt(offset: number): boolean {
      return preformatted[offset] === 1;
    },
    elementAt(offset: number): string | undefined {
      let low = 0;
      let high = elementChanges.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (elementChanges[middle].offset <= offset) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      return elementChanges[low - 1]?.name;
    },
  };
}

function scanHtmlAttributes(content: string, sourceOffset: number): HtmlAttribute[] {
  const attributes: HtmlAttribute[] = [];
  let cursor = 0;
  const skipTemplate = () => {
    const delimiter = protectedConstructEnds.get(content.slice(cursor, cursor + 2));
    if (!delimiter) return false;
    const close = content.indexOf(delimiter, cursor + 2);
    if (close === -1 || content.slice(cursor, close).includes("\n")) return false;
    cursor = close + delimiter.length;
    return true;
  };
  while (cursor < content.length) {
    if (/\s/.test(content[cursor])) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    while (cursor < content.length && !/[\s=]/.test(content[cursor])) {
      if (!skipTemplate()) cursor += 1;
    }
    const name = content.slice(start, cursor);
    let end = cursor;
    let valueStart: number | undefined;
    while (/\s/.test(content[cursor] ?? "")) cursor += 1;
    if (content[cursor] === "=") {
      cursor += 1;
      while (/\s/.test(content[cursor] ?? "")) cursor += 1;
      valueStart = sourceOffset + cursor;
      const quote =
        content[cursor] === '"' || content[cursor] === "'" ? content[cursor++] : undefined;
      while (cursor < content.length) {
        if (skipTemplate()) continue;
        if (quote ? content[cursor] === quote : /\s/.test(content[cursor])) break;
        cursor += 1;
      }
      if (quote && content[cursor] === quote) cursor += 1;
      // Retain malformed suffixes as part of the original attribute spelling.
      while (cursor < content.length && !/\s/.test(content[cursor])) cursor += 1;
      end = cursor;
    }
    attributes.push({ name, start: sourceOffset + start, end: sourceOffset + end, valueStart });
  }
  return attributes;
}

export function splitHtmlAttributes(content: string): string[] {
  return scanHtmlAttributes(content, 0).map(({ start, end }) => content.slice(start, end));
}
