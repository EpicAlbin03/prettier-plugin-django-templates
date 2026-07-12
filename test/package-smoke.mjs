import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageName = "prettier-plugin-django-templates";
const prettierVersion = process.argv.slice(2).find((argument) => argument !== "--") ?? "^3.0.0";
const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "django-template-package-"));
const tarballPath = join(temporaryDirectory, `${packageName}.tgz`);

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
    "dist/browser.mjs",
    "dist/plugin.cjs",
    "dist/plugin.cjs.map",
    "dist/plugin.d.cts",
    "package.json",
  ]);

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
import * as browserPlugin from "${packageName}/browser";

const formatted = await prettier.format("<div>{{name}}</div>", {
  parser: "django-html",
  plugins: [plugin],
});

assert.equal(formatted, "<div>{{ name }}</div>\\n");
for (const member of ["languages", "parsers", "printers"]) {
  assert.ok(member in plugin, "root export is missing " + member);
  assert.ok(member in browserPlugin, "browser export is missing " + member);
}
`,
  );
  await writeFile(
    join(temporaryDirectory, "types-smoke.ts"),
    `
import type { Plugin } from "prettier";
import * as plugin from "${packageName}";

const resolvedPlugin: Plugin = plugin;
void resolvedPlugin;
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
  runPnpm(
    [
      "add",
      "--dir",
      temporaryDirectory,
      "--ignore-scripts",
      `file:${tarballPath.replaceAll("\\", "/")}`,
      `prettier@${prettierVersion}`,
      "typescript@latest",
    ],
    { cwd: temporaryDirectory },
  );

  run(process.execPath, [join(temporaryDirectory, "runtime-smoke.mjs")], {
    cwd: temporaryDirectory,
  });
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
