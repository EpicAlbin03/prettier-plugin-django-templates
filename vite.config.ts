import { defineConfig } from "vite-plus";

const externalPrettier = /^prettier($|\/)/;

export default defineConfig({
  test: {
    include: ["test/**/*.ts"],
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
      dts: false,
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
    ignorePatterns: ["dist", "test/**/*.html", "pnpm-lock.yaml", "repos", ".agents"],
    options: {
      typeAware: true,
      typeCheck: true,
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
    ],
    useTabs: false,
    printWidth: 100,
    semi: true,
    trailingComma: "all",
    singleQuote: false,
  },
});
