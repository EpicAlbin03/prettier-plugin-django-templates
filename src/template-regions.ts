import { hasExactRawBodyEnd, isRawBodyTag, matchesRawBodyEnd } from "./tags.js";

export interface IgnoreRegionDelimiter {
  opener: string;
  closer: string;
}

export const IGNORE_REGION_DELIMITERS: readonly IgnoreRegionDelimiter[] = [
  {
    opener: "<!-- prettier-ignore-start -->",
    closer: "<!-- prettier-ignore-end -->",
  },
  {
    opener: "{# prettier-ignore-start #}",
    closer: "{# prettier-ignore-end #}",
  },
];

export interface RawBodyEnd {
  end: number;
  closingStart: number;
  endArgs: string;
}

export function findRawBodyEnd(
  source: string,
  from: number,
  name: string,
  openingContent: string,
): RawBodyEnd | undefined {
  // Match Django's lexer: a delimiter cannot span LF, including a raw body's terminator.
  const constructs = /{%[^\n]*?%}|{{[^\n]*?}}|{#[^\n]*?#}/g;
  constructs.lastIndex = from;
  for (let match = constructs.exec(source); match; match = constructs.exec(source)) {
    if (!match[0].startsWith("{%")) {
      continue;
    }
    const tagContent = match[0].slice(2, -2).trim();
    const [, ...rest] = tagContent.split(/\s+/);
    if (matchesRawBodyEnd(name, openingContent, tagContent)) {
      return {
        end: match.index + match[0].length,
        closingStart: match.index,
        endArgs: rest.join(" "),
      };
    }
  }

  return undefined;
}

export function findProtectedTemplateRegionEnd(
  source: string,
  offset: number,
  includeRawBodies = true,
): number | undefined {
  const ignoreDelimiter = IGNORE_REGION_DELIMITERS.find(({ opener }) =>
    source.startsWith(opener, offset),
  );
  if (ignoreDelimiter) {
    const closerStart = source.indexOf(
      ignoreDelimiter.closer,
      offset + ignoreDelimiter.opener.length,
    );
    return closerStart === -1 ? source.length : closerStart + ignoreDelimiter.closer.length;
  }

  if (!includeRawBodies || !source.startsWith("{%", offset)) {
    return undefined;
  }

  const openingEnd = source.indexOf("%}", offset + 2);
  if (openingEnd === -1 || source.slice(offset, openingEnd).includes("\n")) {
    return undefined;
  }
  const openingContent = source.slice(offset + 2, openingEnd).trim();
  const [name = "", ...args] = openingContent.split(/\s+/);
  if (!isRawBodyTag(name)) {
    return undefined;
  }

  const rawBodyEnd = findRawBodyEnd(source, openingEnd + 2, name, openingContent);
  if (rawBodyEnd) {
    return rawBodyEnd.end;
  }

  return hasExactRawBodyEnd(name) && args.length > 0 ? source.length : undefined;
}
