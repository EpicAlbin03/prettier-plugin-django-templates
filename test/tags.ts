import { format } from "prettier";
import { describe, expect, test } from "vitest";
import * as DjangoPlugin from "../src/index.js";
import { parse } from "../src/parser.js";
import {
  getExpectedEndNames,
  getExpectedKnownEndName,
  getStandaloneFlow,
  getStartTagFormatting,
  getTagDescriptors,
  getTagRole,
  hasExactRawBodyEnd,
  isKnownEndTag,
  isPermittedBranch,
  isRawBodyTag,
  matchesRawBodyEnd,
  startsDocumentFlowAfterExpression,
  startsDocumentFlowAfterTag,
} from "../src/tags.js";

const formatTemplate = (source: string) =>
  format(source, { parser: "django-html", plugins: [DjangoPlugin] });

const descriptors = getTagDescriptors();

describe("template tag descriptor registry", () => {
  test("classifies every descriptor through its authoritative role", () => {
    for (const [name, descriptor] of descriptors) {
      expect(getTagRole(name), name).toBe(descriptor.role);
    }

    const namesByRole = {
      start: [...descriptors]
        .flatMap(([name, descriptor]) => (descriptor.role === "start" ? [name] : []))
        .sort(),
      branch: [...descriptors]
        .flatMap(([name, descriptor]) => (descriptor.role === "branch" ? [name] : []))
        .sort(),
      standalone: [...descriptors]
        .flatMap(([name, descriptor]) => (descriptor.role === "standalone" ? [name] : []))
        .sort(),
    };
    expect(namesByRole).toMatchInlineSnapshot(`
      {
        "branch": [
          "elif",
          "else",
          "empty",
          "plural",
        ],
        "standalone": [
          "add_data",
          "cms_admin_url",
          "cms_toolbar",
          "component_css_dependencies",
          "component_js_dependencies",
          "crispy",
          "crispy_field",
          "csp_nonce_attr",
          "csrf_token",
          "cycle",
          "debug",
          "drilldown_tree_for_node",
          "extends",
          "firstof",
          "full_tree_for_model",
          "get_available_languages",
          "get_current_language",
          "get_current_language_bidi",
          "get_current_timezone",
          "get_language_info",
          "get_language_info_list",
          "get_media_prefix",
          "get_static_prefix",
          "html_attrs",
          "include",
          "load",
          "lorem",
          "now",
          "page_attribute",
          "page_id_url",
          "page_language_url",
          "page_url",
          "partial",
          "querystring",
          "regroup",
          "render_block",
          "render_model",
          "render_model_add",
          "render_model_icon",
          "render_placeholder",
          "render_plugin",
          "render_uncached_placeholder",
          "resetcycle",
          "show_placeholder",
          "static",
          "static_alias",
          "templatetag",
          "trans",
          "translate",
          "url",
          "wafflejs",
          "widthratio",
        ],
        "start": [
          "addtoblock",
          "autoescape",
          "block",
          "blocktrans",
          "blocktranslate",
          "cache",
          "comment",
          "component",
          "component_block",
          "compress",
          "crispy_addon",
          "element",
          "fill",
          "filter",
          "flag",
          "for",
          "if",
          "ifchanged",
          "ifequal",
          "ifnotequal",
          "language",
          "localize",
          "localtime",
          "partialdef",
          "placeholder",
          "provide",
          "recursetree",
          "render_model_add_block",
          "render_model_block",
          "render_plugin_block",
          "sample",
          "slot",
          "spaceless",
          "static_placeholder",
          "switch",
          "thumbnail",
          "timezone",
          "verbatim",
          "with",
          "with_data",
        ],
      }
    `);
  });

  test("gives every known start tag one conventional closing name", () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor.role !== "start") {
        continue;
      }

      const endName = getExpectedKnownEndName(name);
      expect(endName, name).toBe(`end${name}`);
      expect(isKnownEndTag(endName!), name).toBe(true);
      expect(getTagRole(endName!), name).toBe("end");
    }
  });

  test.each([
    ["elif", ["if"]],
    ["else", ["if", "for", "ifchanged", "ifequal", "ifnotequal", "flag"]],
    ["empty", ["for"]],
    ["plural", ["blocktranslate", "blocktrans"]],
  ])("defines the complete %s parent matrix", (branch, parents) => {
    const startNames = [...descriptors].flatMap(([name, descriptor]) =>
      descriptor.role === "start" ? [name] : [],
    );

    for (const parent of startNames) {
      expect(isPermittedBranch(parent, branch), `${branch} in ${parent}`).toBe(
        parents.includes(parent),
      );
    }
    expect(isPermittedBranch(undefined, branch)).toBe(false);
  });

  test("owns raw-body, flow, and start-tag formatting behavior", () => {
    expect([...descriptors].flatMap(([name]) => (isRawBodyTag(name) ? [name] : []))).toEqual([
      "comment",
      "verbatim",
    ]);
    expect(hasExactRawBodyEnd("comment")).toBe(false);
    expect(hasExactRawBodyEnd("verbatim")).toBe(true);
    expect(matchesRawBodyEnd("comment", "comment", "endcomment optional")).toBe(false);
    expect(matchesRawBodyEnd("comment", "comment", "endcomment")).toBe(true);
    expect(matchesRawBodyEnd("verbatim", "verbatim named", "endverbatim named")).toBe(true);
    expect(matchesRawBodyEnd("verbatim", "verbatim named", "endverbatim other")).toBe(false);

    for (const [name, descriptor] of descriptors) {
      if (descriptor.role === "standalone") {
        expect(getStandaloneFlow(name, ""), name).toBe(descriptor.flow);
      }
    }
    expect(getStandaloneFlow("url", "'view' as target")).toBe("document-flow");
    expect(getStandaloneFlow("url", "'view'")).toBe("inline");
    expect(getStartTagFormatting("html_attrs")).toBe("trim-leading");
    expect(startsDocumentFlowAfterExpression("if")).toBe(true);
    expect(startsDocumentFlowAfterTag("include")).toBe(true);
    expect(startsDocumentFlowAfterTag("endif")).toBe(false);
    expect(startsDocumentFlowAfterTag("elsewhere")).toBe(false);
  });

  test("has no contradictory or dangling descriptors", () => {
    const names = [...descriptors.keys()];
    expect(new Set(names).size).toBe(names.length);
    expect(names.every(Boolean)).toBe(true);

    for (const [name, descriptor] of descriptors) {
      if (descriptor.role === "branch") {
        expect(descriptor.parents.length, name).toBeGreaterThan(0);
        for (const parent of descriptor.parents) {
          expect(descriptors.get(parent)?.role, `${name} parent ${parent}`).toBe("start");
        }
      }
      if (descriptor.role === "start") {
        expect(descriptors.has(`end${name}`), name).toBe(false);
      }
    }
  });
});

describe("custom and ecosystem tag regressions", () => {
  test("keeps unknown standalone and paired inference separate from known descriptors", async () => {
    expect(getTagRole("custom_asset")).toBe("standalone");
    expect(getTagRole("endpoint_asset")).toBe("standalone");
    expect(isKnownEndTag("endpoint_asset")).toBe(false);
    expect(getExpectedEndNames("custom_panel")).toEqual(["endcustom_panel"]);
    expect(getExpectedEndNames("panel_custom_end")).toEqual(["endpanel_custom_end", "panelend"]);
    expect(getExpectedEndNames("dnd_panel")).toEqual(["enddnd_panel", "end_dnd_panel"]);

    for (const [source, expectedEnd] of [
      ["{% custom_panel %}<div>x</div>{% endcustom_panel %}", "endcustom_panel"],
      ["{% endpoint %}x{% endendpoint %}", "endendpoint"],
      ["{% panel_custom_end %}x{% panelend %}", "panelend"],
      ["{% dnd_panel %}x{% end_dnd_panel %}", "end_dnd_panel"],
    ]) {
      const root = parse(source);
      const block = Object.values(root.nodes).find((node) => node.type === "template-block");
      expect(block?.type).toBe("template-block");
      if (block?.type === "template-block") {
        expect(block.end.keyword).toBe(expectedEnd);
      }
    }
  });

  test.each([
    ["unknown standalone", "<p>a {% custom_asset %} b</p>"],
    ["unknown name beginning with end", "<p>a {% endpoint_asset %} b</p>"],
    [
      "django-components metadata",
      '<div class="card" {% html_attrs attrs defaults:class="base" %}>{% component "button" %}x{% endcomponent %}</div>',
    ],
  ])("preserves %s behavior idempotently", async (_label, source) => {
    const formatted = await formatTemplate(source);
    expect(formatted).toMatchSnapshot();
    expect(await formatTemplate(formatted)).toBe(formatted);
  });
});
