import { readdirSync, readFileSync } from "node:fs";
import { format, version as prettierVersion } from "prettier";
import { beforeAll, expect, test } from "vitest";
import * as plugin from "../dist/plugin.cjs";

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

const requestedMax = positiveInteger("BENCHMARK_MAX", 16_000);
const samples = positiveInteger("BENCHMARK_SAMPLES", 20);
// Bound adversarial allocations, rather than making noisy latency numbers a CI gate.
if (requestedMax < 1_000 || requestedMax > 16_000) {
  throw new Error("BENCHMARK_MAX must be between 1000 and 16000.");
}
const sizes = [1_000, 2_000, 4_000, 8_000, 16_000].filter((size) => size <= requestedMax);
const benchmarkOptions = {
  iterations: samples,
  time: 250,
  warmupIterations: 5,
  warmupTime: 100,
};
// A full formatter ladder can take several minutes with the default sample minimum.
const testOptions = { timeout: 600_000, concurrent: false };
const parser = plugin.parsers["django-html"].parse;
const formatOptions = { parser: "django-html", plugins: [plugin] };
const corpusDirectory = new URL("./cases/performance/", import.meta.url);
// Read/generate inputs outside measured callbacks. Sort for reproducible execution order.
const corpus = readdirSync(corpusDirectory)
  .filter((name) => name.endsWith(".html"))
  .sort()
  .map((name) => ({ name, source: readFileSync(new URL(name, corpusDirectory), "utf8") }));
if (corpus.length === 0) {
  throw new Error("The benchmark corpus must contain HTML templates.");
}

beforeAll(() => {
  console.info(
    `Warm-process benchmark: Node ${process.version}, ${process.platform}/${process.arch}, ` +
      `Prettier ${prettierVersion}; minimum ${samples} samples / 250 ms, ` +
      "warmup 5 iterations / 100 ms per workload. Times exclude input generation and imports.",
  );
});

function measurement(name, bytes, result, previous) {
  const medianMs = result.latency.p50;
  return {
    workload: name,
    bytes,
    samples: result.latency.samplesCount,
    "median ms": medianMs.toFixed(3),
    "p99 ms": result.latency.p99.toFixed(3),
    "MiB/s": ((bytes * 1_000) / medianMs / 1024 ** 2).toFixed(2),
    "byte growth": previous ? (bytes / previous.bytes).toFixed(2) : "—",
    "time growth": previous ? (medianMs / previous.medianMs).toFixed(2) : "—",
  };
}

const generators = {
  expressions: (size) => Array.from({ length: size }, () => "{{ value }}").join(" "),
  standalone: (size) => Array.from({ length: size }, () => '{% include "card.html" %}').join("\n"),
  nested: (size) => `${"{% if value %}".repeat(size)}x${"{% endif %}".repeat(size)}`,
  siblings: (size) =>
    Array.from({ length: size }, () => "{% panel %}<p>{{ value }}</p>{% endpanel %}").join("\n"),
  "sparse-html": (size) => `<main>${"<div>ordinary content</div>".repeat(size)}{{ value }}</main>`,
  attributes: (size) => `<div title="${"{{ value }} ".repeat(size)}">content</div>`,
  "filter-chain": (size) => `{{ value${'|default:"fallback"'.repeat(size)} }}`,
  boundaries: (size) =>
    `<main>${"<span>{% if value %}{{ value }}{% else %}empty{% endif %}</span>".repeat(size)}</main>`,
  "quoted-attribute": (size) =>
    `<div title="${"ordinary &amp; quoted content ".repeat(size)}{{ value }}">content</div>`,
};

function scaleBenchmark(name, generate, operation, verify) {
  test(name, testOptions, async ({ bench }) => {
    const rows = [];
    let previous;
    for (const size of sizes) {
      const source = generate(size);
      const bytes = Buffer.byteLength(source, "utf8");
      let output;
      // Preserve synchronous parser timing; an async wrapper would measure promise overhead.
      const run =
        operation === parser
          ? () => {
              output = parser(source, { originalText: source });
            }
          : async () => {
              output = await operation(source);
            };
      // Different sizes are independent workloads, not fastest/slowest competitors.
      const result = await bench(`n=${size}, bytes=${bytes}`, run).run(benchmarkOptions);
      verify(output);
      rows.push(measurement(`n=${size}`, bytes, result, previous));
      previous = { bytes, medianMs: result.latency.p50 };
    }
    console.table(rows);
  });
}

for (const [name, generate] of Object.entries(generators)) {
  scaleBenchmark(`parse ${name}`, generate, parser, (output) => expect(output).toBeDefined());
}

const mixedHtml = (size) =>
  `<main>${Array.from({ length: size }, (_, index) =>
    index % 2 === 0
      ? "<article><h2>{{ title }}</h2><p>ordinary content</p></article>"
      : "{% panel %}<section>{{ value }}</section>{% endpanel %}",
  ).join("\n")}</main>`;
const plainHtml = (size) =>
  `<main>${"<article><h2>title</h2><p>ordinary content</p></article>".repeat(size)}</main>`;
const expectFormatted = (output) => expect(output).toBeTypeOf("string");

scaleBenchmark(
  "format mixed HTML",
  mixedHtml,
  (source) => format(source, formatOptions),
  expectFormatted,
);
// The same plain HTML input through both paths is context, not isolated plugin overhead.
scaleBenchmark(
  "format plain HTML (django-html path)",
  plainHtml,
  (source) => format(source, formatOptions),
  expectFormatted,
);
scaleBenchmark(
  "format plain HTML (html reference)",
  plainHtml,
  (source) => format(source, { parser: "html" }),
  expectFormatted,
);

for (const { name, source } of corpus) {
  test(`format corpus ${name}`, testOptions, async ({ bench }) => {
    let output;
    const result = await bench(name, async () => {
      output = await format(source, formatOptions);
    }).run(benchmarkOptions);
    expectFormatted(output);
    console.table([measurement(name, Buffer.byteLength(source, "utf8"), result)]);
  });
}

test("format whole corpus (sequential)", testOptions, async ({ bench }) => {
  let output;
  const bytes = corpus.reduce((total, entry) => total + Buffer.byteLength(entry.source, "utf8"), 0);
  const result = await bench(`${corpus.length} templates, bytes=${bytes}`, async () => {
    for (const { source } of corpus) {
      output = await format(source, formatOptions);
    }
  }).run(benchmarkOptions);
  expectFormatted(output);
  console.table([measurement("whole corpus", bytes, result)]);
});
