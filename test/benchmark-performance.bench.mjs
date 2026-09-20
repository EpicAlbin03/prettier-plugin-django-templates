import { format } from "prettier";
import { expect, test } from "vitest";
import * as plugin from "../dist/plugin.cjs";

const requestedMax = Number(process.env.BENCHMARK_MAX ?? 16_000);
const samples = Number(process.env.BENCHMARK_SAMPLES ?? 5);
const sizes = [1_000, 2_000, 4_000, 8_000, 16_000].filter((size) => size <= requestedMax);

if (sizes.length === 0 || !Number.isInteger(samples) || samples < 1) {
  throw new Error("BENCHMARK_MAX must be at least 1000 and BENCHMARK_SAMPLES must be positive.");
}

const generators = {
  expressions: (size) => Array.from({ length: size }, () => "{{ value }}").join(" "),
  standalone: (size) => Array.from({ length: size }, () => '{% include "card.html" %}').join("\n"),
  nested: (size) => `${"{% if value %}".repeat(size)}x${"{% endif %}".repeat(size)}`,
  siblings: (size) =>
    Array.from({ length: size }, () => "{% panel %}<p>{{ value }}</p>{% endpanel %}").join("\n"),
  "sparse-html": (size) => `<main>${"<div>ordinary content</div>".repeat(size)}{{ value }}</main>`,
  attributes: (size) => `<div title="${"{{ value }} ".repeat(size)}">content</div>`,
};

const parser = plugin.parsers["django-html"].parse;
const formatOptions = { parser: "django-html", plugins: [plugin] };
const benchmarkOptions = {
  iterations: samples,
  time: 0,
  warmupIterations: 1,
  warmupTime: 0,
};

async function runBenchmarks(bench, benchmarks) {
  if (benchmarks.length === 1) {
    return benchmarks[0].run(benchmarkOptions);
  }
  return bench.compare(...benchmarks, benchmarkOptions);
}

for (const [name, generate] of Object.entries(generators)) {
  test(`parse ${name}`, { timeout: 0 }, async ({ bench }) => {
    let parsed;
    const benchmarks = sizes.map((size) => {
      const source = generate(size);
      return bench(`n=${size}`, () => {
        parsed = parser(source, { originalText: source });
      });
    });

    await runBenchmarks(bench, benchmarks);
    expect(parsed).toBeDefined();
  });
}

test("format mixed HTML", { timeout: 0 }, async ({ bench }) => {
  let formatted;
  const benchmarks = sizes.map((size) => {
    const source = `<main>${Array.from({ length: size }, (_, index) =>
      index % 2 === 0
        ? `<article><h2>{{ title }}</h2><p>ordinary content</p></article>`
        : `{% panel %}<section>{{ value }}</section>{% endpanel %}`,
    ).join("\n")}</main>`;

    return bench(`n=${size}`, async () => {
      formatted = await format(source, formatOptions);
    });
  });

  await runBenchmarks(bench, benchmarks);
  expect(formatted).toBeTypeOf("string");
});

test("format plain HTML", { timeout: 0 }, async ({ bench }) => {
  let formatted;
  const benchmarks = sizes.map((size) => {
    const source = `<main>${"<article><h2>title</h2><p>ordinary content</p></article>".repeat(size)}</main>`;

    return bench(`n=${size}`, async () => {
      formatted = await format(source, { parser: "html" });
    });
  });

  await runBenchmarks(bench, benchmarks);
  expect(formatted).toBeTypeOf("string");
});
