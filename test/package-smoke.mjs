import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageName = "prettier-plugin-django-templates";
const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const installedPrettierManifest = JSON.parse(
  await readFile(join(projectDirectory, "node_modules", "prettier", "package.json"), "utf8"),
);
const prettierVersion =
  process.argv.slice(2).find((argument) => argument !== "--") ?? installedPrettierManifest.version;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "django-template-package-"));
const tarballPath = join(temporaryDirectory, `${packageName}.tgz`);
const formatCases = [
  ["<div>{{name}}</div>", "<div>{{ name }}</div>\n"],
  [
    "<main>{%if enabled%}<div>{{value}}</div>{%endif%}</main>",
    "<main>\n  {% if enabled %}\n    <div>{{ value }}</div>\n  {% endif %}\n</main>\n",
  ],
  [
    "{%verbatim%}{{ untouched }}{%endverbatim%}",
    "{% verbatim %}{{ untouched }}{% endverbatim %}\n",
  ],
];

function run(command, args, options = {}) {
  const spawnOptions = {
    cwd: projectDirectory,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  };
  const result =
    args === undefined ? spawnSync(command, spawnOptions) : spawnSync(command, args, spawnOptions);

  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args?.join(" ") ?? ""} failed`,
        result.error?.message,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout;
}

function runPnpm(args, options) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  }

  if (process.platform === "win32") {
    const command = `pnpm ${args.map((argument) => `"${argument.replaceAll('"', '""')}"`).join(" ")}`;
    return run(command, undefined, { shell: true, ...options });
  }

  return run("pnpm", args, options);
}

try {
  runPnpm(["run", "build"]);

  const packOutput = runPnpm(["pack", "--json", "--out", tarballPath]);
  const packResult = JSON.parse(packOutput.slice(packOutput.indexOf("{")));
  const packedFiles = packResult.files.map(({ path }) => path).sort();

  assert.deepEqual(packedFiles, [
    "LICENSE",
    "README.md",
    "dist/browser.d.mts",
    "dist/browser.mjs",
    "dist/plugin.cjs",
    "dist/plugin.cjs.map",
    "dist/plugin.d.cts",
    "package.json",
  ]);

  console.log(runPnpm(["exec", "publint", tarballPath, "--strict"]));
  console.log(runPnpm(["exec", "attw", tarballPath, "--exclude-entrypoints", "browser"]));
  // The browser entry is for ESM-aware bundlers, not CommonJS or legacy Node resolution.
  console.log(
    runPnpm(["exec", "attw", tarballPath, "--entrypoints", "browser", "--profile", "esm-only"]),
  );

  await writeFile(
    join(temporaryDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await writeFile(
    join(temporaryDirectory, "runtime-smoke.mjs"),
    `
import assert from "node:assert/strict";
import * as prettier from "prettier";
import * as plugin from "${packageName}";

const options = { parser: "django-html", plugins: [plugin] };
for (const [source, expected] of ${JSON.stringify(formatCases)}) {
  assert.equal(await prettier.format(source, options), expected);
  assert.equal(await prettier.format(expected, options), expected);
}
for (const member of ["languages", "options", "parsers", "printers"]) {
  assert.ok(member in plugin, "root export is missing " + member);
}
`,
  );
  await writeFile(
    join(temporaryDirectory, "commonjs-smoke.cjs"),
    `
const assert = require("node:assert/strict");
const prettier = require("prettier");
const plugin = require("${packageName}");

async function checkFormatting() {
  const options = { parser: "django-html", plugins: [plugin] };
  for (const [source, expected] of ${JSON.stringify(formatCases)}) {
    assert.equal(await prettier.format(source, options), expected);
    assert.equal(await prettier.format(expected, options), expected);
  }
}
checkFormatting().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`,
  );
  await writeFile(
    join(temporaryDirectory, "browser-smoke.mjs"),
    `
import * as prettier from "prettier/standalone";
import * as htmlPlugin from "prettier/plugins/html";
import * as plugin from "${packageName}/browser";

const options = { parser: "django-html", plugins: [htmlPlugin, plugin] };
export const formatted = [];
export const reformatted = [];
for (const [source] of ${JSON.stringify(formatCases)}) {
  const result = await prettier.format(source, options);
  formatted.push(result);
  reformatted.push(await prettier.format(result, options));
}
`,
  );
  await writeFile(
    join(temporaryDirectory, "vite.config.mjs"),
    `
export default {
  build: {
    emptyOutDir: true,
    lib: {
      entry: "browser-smoke.mjs",
      fileName: "browser-smoke",
      formats: ["es"],
    },
    minify: false,
    outDir: "browser-dist",
    target: "es2022",
  },
};
`,
  );
  await writeFile(join(temporaryDirectory, "cli-smoke.html"), "<div>{{name}}</div>");
  await writeFile(
    join(temporaryDirectory, "types-smoke.ts"),
    `
import type { Plugin } from "prettier";
import * as plugin from "${packageName}";
import * as browserPlugin from "${packageName}/browser";

const resolvedPlugin: Plugin = plugin;
const resolvedBrowserPlugin: Plugin = browserPlugin;
void resolvedPlugin;
void resolvedBrowserPlugin;
`,
  );
  await writeFile(
    join(temporaryDirectory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        skipLibCheck: true,
      },
      files: ["types-smoke.ts"],
    }),
  );

  await writeFile(join(temporaryDirectory, ".npmrc"), "resolution-mode=highest\n");
  await copyFile(
    join(projectDirectory, "pnpm-workspace.yaml"),
    join(temporaryDirectory, "pnpm-workspace.yaml"),
  );
  assert.equal(
    runPnpm(["config", "get", "minimumReleaseAge"], { cwd: temporaryDirectory }).trim(),
    "2880",
  );
  assert.equal(
    runPnpm(["config", "get", "blockExoticSubdeps"], { cwd: temporaryDirectory }).trim(),
    "true",
  );
  runPnpm(
    [
      "add",
      "--dir",
      temporaryDirectory,
      "--ignore-scripts",
      `file:${tarballPath.replaceAll("\\", "/")}`,
      `prettier@${prettierVersion}`,
      "typescript@7.0.2",
    ],
    { cwd: temporaryDirectory },
  );

  run(process.execPath, [join(temporaryDirectory, "runtime-smoke.mjs")], {
    cwd: temporaryDirectory,
  });
  run(process.execPath, [join(temporaryDirectory, "commonjs-smoke.cjs")], {
    cwd: temporaryDirectory,
  });

  const cliOutput = runPnpm(
    ["exec", "prettier", "--plugin", packageName, "--parser", "django-html", "cli-smoke.html"],
    { cwd: temporaryDirectory },
  );
  assert.equal(cliOutput, "<div>{{ name }}</div>\n");

  runPnpm(
    [
      "exec",
      "vp",
      "build",
      temporaryDirectory,
      "--config",
      join(temporaryDirectory, "vite.config.mjs"),
      "--logLevel",
      "warn",
    ],
    { cwd: projectDirectory },
  );
  const browserBundle = await import(
    pathToFileURL(join(temporaryDirectory, "browser-dist", "browser-smoke.js")).href
  );
  const expectedFormats = formatCases.map(([, expected]) => expected);
  assert.deepEqual(browserBundle.formatted, expectedFormats);
  assert.deepEqual(browserBundle.reformatted, expectedFormats);

  run(
    process.execPath,
    [join(temporaryDirectory, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"],
    { cwd: temporaryDirectory },
  );

  const installedManifest = JSON.parse(
    await readFile(join(temporaryDirectory, "node_modules", packageName, "package.json"), "utf8"),
  );
  assert.equal(installedManifest.main, "dist/plugin.cjs");

  console.log(`Packed-package smoke test passed with Prettier ${prettierVersion}.`);
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
