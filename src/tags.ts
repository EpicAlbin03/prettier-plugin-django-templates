export type TagRole = "start" | "branch" | "end" | "standalone";
export type StandaloneFlow = "inline" | "document-flow";
export type EndStrategy = "prefixed" | "exact-opening-content";
export type StartTagFormatting = "trim-leading";

interface StartTagDescriptor {
  role: "start";
  endStrategy: EndStrategy;
  rawBody?: true;
  documentFlowAfterExpression?: true;
}

interface BranchTagDescriptor {
  role: "branch";
  parents: readonly string[];
}

interface StandaloneTagDescriptor {
  role: "standalone";
  flow: StandaloneFlow;
  documentFlowWhenAssigned?: true;
  startTagFormatting?: StartTagFormatting;
}

export type TagDescriptor = StartTagDescriptor | BranchTagDescriptor | StandaloneTagDescriptor;

const descriptors = new Map<string, TagDescriptor>();

function register(names: readonly string[], descriptor: TagDescriptor): void {
  for (const name of names) {
    if (descriptors.has(name)) {
      throw new Error(`Duplicate template tag descriptor for "${name}".`);
    }
    descriptors.set(name, descriptor);
  }
}

register(
  [
    // django
    "for",
    "block",
    "filter",
    "with",
    "autoescape",
    "ifchanged",
    "spaceless",
    "blocktranslate",
    "cache",
    "localize",
    "localtime",
    "timezone",
    "language",
    "partialdef",
    // deprecated django
    "ifequal",
    "ifnotequal",
    "blocktrans",
    // sorl-thumbnail
    "thumbnail",
    // django-components
    "component",
    "component_block",
    "fill",
    "slot",
    "provide",
    // django-compressor
    "compress",
    // django-sekizai
    "addtoblock",
    "with_data",
    // django-waffle
    "flag",
    "switch",
    "sample",
    // django-mptt
    "recursetree",
    // django CMS
    "placeholder",
    "static_placeholder",
    "render_model_block",
    "render_model_add_block",
    "render_plugin_block",
    // django-allauth
    "element",
    // django-crispy-forms
    "crispy_addon",
  ],
  { role: "start", endStrategy: "prefixed" },
);

register(["if"], {
  role: "start",
  endStrategy: "prefixed",
  documentFlowAfterExpression: true,
});
register(["comment"], { role: "start", endStrategy: "prefixed", rawBody: true });
register(["verbatim"], {
  role: "start",
  endStrategy: "exact-opening-content",
  rawBody: true,
});

register(["elif"], { role: "branch", parents: ["if"] });
register(["else"], {
  role: "branch",
  parents: ["if", "for", "ifchanged", "ifequal", "ifnotequal", "flag"],
});
register(["empty"], { role: "branch", parents: ["for"] });
register(["plural"], { role: "branch", parents: ["blocktranslate", "blocktrans"] });

register(
  [
    // django
    "cycle",
    "firstof",
    "get_media_prefix",
    "get_static_prefix",
    "lorem",
    "now",
    "querystring",
    "csp_nonce_attr",
    "static",
    "templatetag",
    "translate",
    "widthratio",
    "partial",
    // deprecated django
    "trans",
    // django CMS
    "cms_admin_url",
    "page_attribute",
    "page_url",
    "page_id_url",
    "page_language_url",
    "render_model",
    "render_model_icon",
    "render_model_add",
    "render_placeholder",
    "render_uncached_placeholder",
    "render_plugin",
    "show_placeholder",
    "static_alias",
    // django-waffle
    "wafflejs",
  ],
  { role: "standalone", flow: "inline" },
);

register(["url"], {
  role: "standalone",
  flow: "inline",
  documentFlowWhenAssigned: true,
});

register(["html_attrs"], {
  role: "standalone",
  flow: "inline",
  startTagFormatting: "trim-leading",
});

register(
  [
    // django
    "csrf_token",
    "debug",
    "extends",
    "include",
    "load",
    "regroup",
    "resetcycle",
    "get_available_languages",
    "get_current_language",
    "get_current_language_bidi",
    "get_current_timezone",
    "get_language_info",
    "get_language_info_list",
    // django-mptt
    "drilldown_tree_for_node",
    "full_tree_for_model",
    // django-components
    "component_css_dependencies",
    "component_js_dependencies",
    // django CMS
    "cms_toolbar",
    // django-sekizai
    "render_block",
    "add_data",
    // django-crispy-forms
    "crispy",
    "crispy_field",
  ],
  { role: "standalone", flow: "document-flow" },
);

const knownEndNames = new Map<string, string>();
for (const [name, descriptor] of descriptors) {
  if (descriptor.role === "start") {
    knownEndNames.set(`end${name}`, name);
  }
}

export function getTagDescriptors(): ReadonlyMap<string, TagDescriptor> {
  return new Map(descriptors);
}

export function isBranchTag(name: string): boolean {
  return descriptors.get(name)?.role === "branch";
}

export function isRawBodyTag(name: string): boolean {
  const descriptor = descriptors.get(name);
  return descriptor?.role === "start" && descriptor.rawBody === true;
}

export function hasExactRawBodyEnd(name: string): boolean {
  const descriptor = descriptors.get(name);
  return (
    descriptor?.role === "start" &&
    descriptor.rawBody === true &&
    descriptor.endStrategy === "exact-opening-content"
  );
}

export function isKnownEndTag(name: string): boolean {
  return knownEndNames.has(name);
}

export function getTagRole(name: string): TagRole {
  if (isKnownEndTag(name)) {
    return "end";
  }
  return descriptors.get(name)?.role ?? "standalone";
}

export function getExpectedKnownEndName(name: string): string | undefined {
  return descriptors.get(name)?.role === "start" ? `end${name}` : undefined;
}

export function getExpectedEndNames(name: string): readonly string[] {
  const knownEndName = getExpectedKnownEndName(name);
  if (knownEndName) {
    return [knownEndName];
  }

  // Unknown paired custom tags use only conventions inferred from the source.
  const candidates = [`end${name}`];
  if (name.endsWith("_custom_end")) {
    candidates.push(name.replace(/_custom_end$/, "end"));
  }
  if (name.startsWith("dnd_")) {
    candidates.push(`end_${name}`);
  }
  return candidates;
}

export function isPermittedBranch(parentName: string | undefined, branchName: string): boolean {
  const descriptor = descriptors.get(branchName);
  return (
    descriptor?.role === "branch" &&
    parentName !== undefined &&
    descriptor.parents.includes(parentName)
  );
}

export function matchesRawBodyEnd(
  name: string,
  openingContent: string,
  closingContent: string,
): boolean {
  const descriptor = descriptors.get(name);
  if (descriptor?.role !== "start" || !descriptor.rawBody) {
    return false;
  }

  if (descriptor.endStrategy === "exact-opening-content") {
    return closingContent === `end${openingContent}`;
  }

  return closingContent.split(/\s+/, 1)[0] === `end${name}`;
}

export function getStandaloneFlow(name: string, args: string): StandaloneFlow {
  const descriptor = descriptors.get(name);
  if (descriptor?.role !== "standalone") {
    return "document-flow";
  }
  if (descriptor.documentFlowWhenAssigned && /\bas\s+\S+$/.test(args)) {
    return "document-flow";
  }
  return descriptor.flow;
}

export function getStartTagFormatting(name: string): StartTagFormatting | undefined {
  const descriptor = descriptors.get(name);
  return descriptor?.role === "standalone" ? descriptor.startTagFormatting : undefined;
}

export function startsDocumentFlowAfterExpression(name: string): boolean {
  const descriptor = descriptors.get(name);
  return descriptor?.role === "start" && descriptor.documentFlowAfterExpression === true;
}

export function startsDocumentFlowAfterTag(name: string): boolean {
  if (name.startsWith("end")) {
    return false;
  }

  const branchNames = [...descriptors].flatMap(([branchName, descriptor]) =>
    descriptor.role === "branch" ? [branchName] : [],
  );
  return branchNames.every((branchName) => !name.startsWith(branchName));
}
