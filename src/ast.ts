import type { HtmlHostContext } from "./html-host-context.js";

export type ProtectedMarkerKind = "inline" | "block" | "attr";

export type DjangoNode =
  | RootNode
  | ExpressionNode
  | TemplateTagNode
  | TemplateBlockNode
  | CommentNode
  | RawBlockNode
  | IgnoreRegionNode;

export interface BaseNode {
  readonly type: string;
  readonly id: string;
  /** Exact UTF-16 source slice; never normalized token spelling or an HTML projection. */
  readonly sourceText: string;
  /** Parser-required opacity (preformatted, literal syntax, or protected comment content). */
  readonly preserveOriginalText?: boolean;
  readonly preNewLines: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly protectedMarkerKind: ProtectedMarkerKind;
  readonly parentBlockId?: string;
  readonly parentBlockRelationship?: "content" | "end";
  readonly parentBlockContext?: { readonly host: HtmlHostContext; readonly hasHtmlMarkup: boolean };
  readonly hostContext: HtmlHostContext;
}

export interface RootNode extends BaseNode {
  readonly type: "root";
  /** HTML projection with direct child markers; offsets are not source offsets. */
  readonly html: string;
  readonly nodes: Readonly<Record<string, DjangoNode>>;
}

interface LeafNode extends BaseNode {
  readonly nodes?: never;
}

export interface ExpressionNode extends LeafNode {
  readonly type: "expression";
  readonly content: string;
}

export interface TemplateTagNode extends LeafNode {
  readonly type: "template-tag";
  readonly content: string;
  readonly keyword: string;
  readonly role: "start" | "branch" | "end" | "standalone";
}

export interface TemplateBlockNode extends BaseNode {
  readonly type: "template-block";
  /** HTML projection with direct child markers; offsets are not source offsets. */
  readonly html: string;
  readonly nodes: Readonly<Record<string, DjangoNode>>;
  readonly start: TemplateTagNode;
  readonly end: TemplateTagNode;
  readonly childIds: readonly string[];
  readonly containsNewLines: boolean;
}

export interface CommentNode extends LeafNode {
  readonly type: "comment";
  readonly content: string;
}

export interface RawBlockNode extends LeafNode {
  readonly type: "raw-block";
  readonly content: string;
  readonly keyword?: string;
  readonly args?: string;
  readonly body?: string;
  readonly endArgs?: string;
}

export interface IgnoreRegionNode extends LeafNode {
  readonly type: "ignore-region";
  readonly content: string;
  readonly closed: boolean;
}
