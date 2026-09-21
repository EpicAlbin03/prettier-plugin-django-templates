import type { DjangoNode, RootNode, TemplateBlockNode, TemplateTagNode } from "./ast.js";

type Writable<T> = { -readonly [K in keyof T]: T[K] };
export type DraftTag = Writable<TemplateTagNode>;
export type DraftBlock = Omit<
  Writable<TemplateBlockNode>,
  "nodes" | "start" | "end" | "childIds"
> & {
  nodes: Record<string, DraftNode>;
  start: DraftTag;
  end: DraftTag;
  childIds: string[];
};
export type DraftRoot = Omit<Writable<RootNode>, "nodes"> & { nodes: Record<string, DraftNode> };
export type DraftNode =
  | DraftRoot
  | DraftBlock
  | Writable<Exclude<DjangoNode, RootNode | TemplateBlockNode>>;

export function finishDocument(root: DraftRoot): RootNode {
  for (const node of Object.values(root.nodes)) {
    if (node.type === "template-block") Object.freeze(node.childIds);
    if (node.parentBlockContext) Object.freeze(node.parentBlockContext);
    Object.freeze(node);
  }
  Object.freeze(root.nodes);
  return Object.freeze(root);
}
