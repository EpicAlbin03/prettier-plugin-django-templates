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
  type: string;
  id: string;
  content: string;
  originalText: string;
  preNewLines: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  nodes?: Record<string, DjangoNode>;
  protectedMarkerKind: ProtectedMarkerKind;
  parentBlockId?: string;
  parentBlockRelationship?: "content" | "end";
  parentBlockInTag?: boolean;
  parentBlockInAttribute?: boolean;
  parentBlockHasHtmlMarkup?: boolean;
  inTag?: boolean;
  inAttribute?: boolean;
}

export interface RootNode extends BaseNode {
  type: "root";
  nodes: Record<string, DjangoNode>;
}

export interface ExpressionNode extends BaseNode {
  type: "expression";
}

export interface TemplateTagNode extends BaseNode {
  type: "template-tag";
  keyword: string;
  role: "start" | "branch" | "end" | "standalone";
}

export interface TemplateBlockNode extends BaseNode {
  type: "template-block";
  nodes: Record<string, DjangoNode>;
  start: TemplateTagNode;
  end: TemplateTagNode;
  childIds: string[];
  containsNewLines: boolean;
}

export interface CommentNode extends BaseNode {
  type: "comment";
}

export interface RawBlockNode extends BaseNode {
  type: "raw-block";
  keyword?: string;
  args?: string;
  body?: string;
  endArgs?: string;
}

export interface IgnoreRegionNode extends BaseNode {
  type: "ignore-region";
  closed: boolean;
}
