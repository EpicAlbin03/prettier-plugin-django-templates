import type { AstPath, Doc, Options, Printer } from "prettier";
import { doc } from "prettier";
import { scanHtmlHostContexts, splitHtmlAttributes } from "./html-host-context.js";
import { HtmlDocCache } from "./html-doc-cache.js";
import { containsProtectedNodeMarker, replaceProtectedMarkersInString } from "./html-adapter.js";
import { getDocumentPlan, prepareDocument, type ContainerPlan } from "./formatting-plan.js";
import { formatExpression, getRawBlockText } from "./template-text.js";
import {
  markerEntries,
  ATTRIBUTE_MARKER_SOURCE,
  BLOCK_MARKER_SOURCE,
  INLINE_MARKER_SOURCE,
} from "./internal-markers.js";
import { getStartTagFormatting, isBranchTag } from "./tags.js";
import type { TemplateBlockNode, DjangoNode, TemplateTagNode } from "./ast.js";

const { builders, utils } = doc;
const { mapDoc } = utils;

const htmlDocCaches = new WeakMap<Readonly<Record<string, DjangoNode>>, HtmlDocCache>();

export const preprocess: Printer<DjangoNode>["preprocess"] = (node) => {
  if (node.type === "root") {
    htmlDocCaches.set(node.nodes, new HtmlDocCache(node.nodes));
    return prepareDocument(node);
  }
  return node;
};

function stripProtectedMarkerContext(value: string): string {
  return value
    .replace(new RegExp(BLOCK_MARKER_SOURCE, "g"), "")
    .replace(new RegExp(INLINE_MARKER_SOURCE, "g"), "")
    .replace(new RegExp(ATTRIBUTE_MARKER_SOURCE, "g"), "");
}

function isInlineOnlyChildContext(linePrefix: string, lineSuffix: string): boolean {
  const cleanPrefix = stripProtectedMarkerContext(linePrefix);
  const cleanSuffix = stripProtectedMarkerContext(lineSuffix);

  const prefix = cleanPrefix.trim();
  const suffix = cleanSuffix.trim();
  const before = scanHtmlHostContexts(prefix).tags;
  const after = scanHtmlHostContexts(suffix).tags;
  return (
    before.length === 1 &&
    !before[0].closing &&
    before[0].start === 0 &&
    before[0].end === prefix.length &&
    after.length === 1 &&
    after[0].closing &&
    after[0].start === 0 &&
    after[0].end === suffix.length
  );
}

function endsWithHtmlClosingTag(value: string): boolean {
  const text = stripProtectedMarkerContext(value).trimEnd();
  const tag = scanHtmlHostContexts(text).tags.at(-1);
  return Boolean(tag?.closing && tag.end === text.length);
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

function printTemplateTag(node: TemplateTagNode, htmlOwnsSpacing = false): Doc {
  const templateTag = `{% ${node.content.trim()} %}`;

  if (getStartTagFormatting(node.keyword) === "trim-leading") {
    return [builders.trim, templateTag];
  }

  if (
    isBranchTag(node.keyword) &&
    node.parentBlockRelationship === "content" &&
    node.parentBlockContext?.host === "document-flow"
  ) {
    return [builders.dedent(builders.hardline), templateTag, builders.hardline];
  }

  if (node.preNewLines > 1 && !htmlOwnsSpacing) {
    const hasParentBlock = node.parentBlockRelationship !== undefined;
    const standaloneNeedsSpacing =
      node.role === "standalone" &&
      (node.protectedMarkerKind !== "block" ||
        !hasParentBlock ||
        !node.parentBlockContext?.hasHtmlMarkup);
    if (standaloneNeedsSpacing) {
      return builders.group([builders.trim, builders.hardline, templateTag]);
    }
  }

  return templateTag;
}

function joinSegments(layout: ContainerPlan, mapped: Doc[]): Doc {
  return mapped.flatMap((segment, index) => {
    const boundary = layout.boundaries[index];
    return [
      boundary.before === "trim-line" ? builders.trim : "",
      boundary.before !== "none" ? builders.hardline : "",
      segment,
      ...Array.from({ length: boundary.after }, () => builders.hardline),
    ];
  });
}

function getStartTagTemplateBlockDoc(
  path: AstPath<DjangoNode>,
  print: (selector?: string | number | Array<string | number> | AstPath<DjangoNode>) => Doc,
  block: TemplateBlockNode,
): Doc {
  const docs: Doc[] = [];

  for (const attribute of splitHtmlAttributes(block.html)) {
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

function buildBlock(
  path: AstPath<DjangoNode>,
  print: (selector?: string | number | Array<string | number> | AstPath<DjangoNode>) => Doc,
  block: TemplateBlockNode,
  mapped: Doc,
  preserveMappedIndentation = false,
): Doc {
  if (/^\s*$/.test(block.html)) {
    return builders.group([
      path.call(print, "nodes", block.start.id),
      block.hostContext !== "document-flow" ? builders.softline : "",
      path.call(print, "nodes", block.end.id),
    ]);
  }

  if (
    block.hostContext !== "attribute-value" &&
    (block.hostContext === "document-flow" || block.containsNewLines)
  ) {
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
      return `{# ${node.content.trim()} #}`;
    case "raw-block":
      return getRawBlockText(node);
    case "ignore-region":
      return node.sourceText;
    default:
      return node.sourceText;
  }
};

export const embed: Printer<DjangoNode>["embed"] = () => {
  return async (
    textToDoc: (text: string, options: Options) => Promise<Doc>,
    print: (selector?: string | number | Array<string | number> | AstPath<DjangoNode>) => Doc,
    path: AstPath<DjangoNode>,
    options: Options,
  ): Promise<Doc | undefined> => {
    const ast = path.getNode();
    if (!ast || (ast.type !== "root" && ast.type !== "template-block")) return undefined;
    const plan = getDocumentPlan(ast);
    const layout = plan.containers.get(ast.id)!;
    const { node, markerContexts, segments, leadingStandaloneSplit } = layout;
    if (layout.preserved) {
      return [
        layout.preserved.text,
        node.type === "root" && layout.finalNewline ? builders.hardline : "",
      ];
    }
    if (layout.body.kind === "expression-lines") {
      const body = builders.join(
        builders.hardline,
        layout.body.lines.map((line) => [...line]),
      );
      return node.type === "template-block"
        ? buildBlock(path, print, node, body, true)
        : [body, layout.finalNewline ? builders.hardline : ""];
    }

    if (node.type === "template-block" && layout.body.kind === "start-tag") {
      return buildBlock(path, print, node, getStartTagTemplateBlockDoc(path, print, node));
    }

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

    if (layout.blockSequence) {
      const body = builders.join(
        builders.hardline,
        layout.blockSequence.map((id) => path.call(print, "nodes", id)),
      );
      return node.type === "template-block"
        ? buildBlock(path, print, node, body)
        : [body, layout.finalNewline ? builders.hardline : ""];
    }

    const mapped = await Promise.all(
      segments.map(async (segment, segmentIndex) => {
        const preparedSegment = layout.preparedSegments[segmentIndex];
        const doc = node.nodes[segment]
          ? segment
          : await htmlDocCaches
              .get(ast.nodes)!
              .format(
                preparedSegment.segment,
                textToDoc,
                preparedSegment.sensitiveBody ? "strict" : options.htmlWhitespaceSensitivity,
              );

        if (
          node.type === "root" &&
          Object.keys(node.nodes).length === 0 &&
          preparedSegment.beforeReplacements.length === 0
        ) {
          return doc;
        }

        return mapDoc(doc, (currentDoc) => {
          // A Prettier Doc is a documented union with strings as its only text representation.
          // oxlint-disable-next-line anti-slop/no-runtime-typeof
          if (typeof currentDoc !== "string") {
            return currentDoc;
          }

          for (const replacement of preparedSegment.beforeReplacements) {
            currentDoc = currentDoc.replaceAll(replacement.token, () => replacement.value);
          }

          const currentString = currentDoc;
          if (!containsProtectedNodeMarker(currentString, node.nodes)) {
            return currentDoc;
          }

          return replaceProtectedMarkersInString(currentDoc, node.nodes, (id, context) => {
            const currentNode = node.nodes[id];
            const preserved = plan.preserved.get(id);
            const markerContext = markerContexts.get(id);
            if (preserved && !markerContext?.leadingLines) return { doc: preserved.text };
            // This construct is the entire element body, not a document-flow boundary.
            if (id === preparedSegment.standaloneMarker && currentNode.type === "template-tag") {
              return { doc: printTemplateTag(currentNode) };
            }

            // HTML already preserves blank lines around block markers. Only tags
            // printed outside that HTML Doc need to supply their own spacing.
            const rendered = preserved
              ? preserved.text
              : currentNode.type === "template-tag" &&
                  currentNode.protectedMarkerKind === "block" &&
                  segment !== id
                ? printTemplateTag(currentNode, true)
                : path.call(print, "nodes", id);
            const leadingSpacing = markerContext?.leadingLines
              ? Array.from({ length: markerContext.leadingLines }, () => builders.hardline)
              : undefined;
            const restored = markerContext?.breakBefore
              ? [builders.trim, builders.hardline, rendered]
              : leadingSpacing
                ? [builders.trim, leadingSpacing, rendered]
                : rendered;
            if (preserved) {
              return { doc: restored, trimLeadingWhitespace: Boolean(leadingSpacing) };
            }
            if (
              currentNode.type === "template-tag" &&
              currentNode.role === "standalone" &&
              currentNode.protectedMarkerKind === "block"
            ) {
              const inlineWithNext = markerContext?.inlineWithNext ?? false;
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
              endsWithHtmlClosingTag(context.linePrefix)
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

    const joined = joinSegments(layout, mapped);

    if (node.type === "template-block") {
      return buildBlock(path, print, node, joined);
    }

    return [joined, layout.finalNewline ? builders.hardline : ""];
  };
};

export function getVisitorKeys(ast: DjangoNode | Readonly<Record<string, DjangoNode>>): string[] {
  if ("type" in ast) {
    return ast.type === "root" ? ["nodes"] : [];
  }

  return Object.values(ast)
    .filter((node) => node.type === "template-block")
    .map((node) => node.id);
}
