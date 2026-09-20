import type { Parser, Printer, SupportLanguage } from "prettier";
import type { DjangoNode } from "./ast.js";
import { parse } from "./parser.js";
import { embed, getVisitorKeys, print } from "./printer.js";

const PLUGIN_KEY = "django-html";

const languages: SupportLanguage[] = [
  {
    name: "HTML+Django",
    parsers: [PLUGIN_KEY],
    extensions: [".html"],
    vscodeLanguageIds: ["html"],
  },
];

const parsers: Record<typeof PLUGIN_KEY, Parser<DjangoNode>> = {
  [PLUGIN_KEY]: {
    astFormat: PLUGIN_KEY,
    parse,
    locStart: (node) => node.sourceStart,
    locEnd: (node) => node.sourceEnd,
  },
};

const printers: Record<typeof PLUGIN_KEY, Printer<DjangoNode>> = {
  [PLUGIN_KEY]: {
    print,
    embed,
    getVisitorKeys,
  },
};

const options = {};

export { languages, options, parsers, printers };
