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
  let cursor = from;

  while (cursor < source.length) {
    const tagStart = source.indexOf("{%", cursor);
    if (tagStart === -1) {
      return undefined;
    }

    const closeDelimiter = source.indexOf("%}", tagStart + 2);
    if (closeDelimiter === -1) {
      return undefined;
    }

    const tagContent = source.slice(tagStart + 2, closeDelimiter).trim();
    const [, ...rest] = tagContent.split(/\s+/);
    if (matchesRawBodyEnd(name, openingContent, tagContent)) {
      return {
        end: closeDelimiter + 2,
        closingStart: tagStart,
        endArgs: rest.join(" "),
      };
    }

    cursor = closeDelimiter + 2;
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
  if (openingEnd === -1) {
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
