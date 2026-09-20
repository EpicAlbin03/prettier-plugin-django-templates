import { defineConfig } from "vite-plus";

const externalPrettier = /^prettier($|\/)/;

export default defineConfig({
  test: {
    include: ["test/**/*.ts"],
    exclude: ["test/**/*.bench.ts"],
  },
  staged: {
    "*": "vp check --fix",
  },
  pack: [
    {
      entry: {
        plugin: "src/index.ts",
      },
      format: "cjs",
      sourcemap: true,
      dts: true,
      deps: {
        neverBundle: [externalPrettier],
      },
      // The package root is intentionally CommonJS so Prettier can load it via
      // either import() or require() in supported Node versions.
      outExtensions: () => ({
        js: ".cjs",
      }),
      outputOptions: {
        strict: true,
        esModule: false,
        generatedCode: {
          symbols: false,
        },
      },
    },
    {
      entry: {
        browser: "src/index.ts",
      },
      format: "esm",
      dts: true,
      deps: {
        neverBundle: [externalPrettier],
      },
      outExtensions: () => ({
        js: ".mjs",
      }),
      outputOptions: {
        paths: {
          prettier: "prettier/standalone",
        },
      },
    },
  ],
  lint: {
    ignorePatterns: [
      "dist",
      "test/**/*.html",
      "pnpm-lock.yaml",
      "repos",
      ".agents",
      "tools/oxlint/anti-slop/**",
    ],
    jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "off",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
    },
  },
  fmt: {
    ignorePatterns: [
      "dist",
      "test/**/*.html",
      "pnpm-lock.yaml",
      "repos",
      ".agents",
      "README.md",
      ".changeset",
      "tools/oxlint/anti-slop/**",
    ],
    useTabs: false,
    printWidth: 100,
    semi: true,
    trailingComma: "all",
    singleQuote: false,
  },
});
