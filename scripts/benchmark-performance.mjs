import { performance } from "node:perf_hooks";
import { format } from "prettier";
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
const options = { parser: "django-html", plugins: [plugin] };
const results = [];
const benchmarkStartedAt = performance.now();
const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

async function measure(run) {
  await run();
  const durations = [];
  const rssDeltas = [];
  for (let index = 0; index < samples; index += 1) {
    global.gc?.();
    const rssBefore = process.memoryUsage().rss;
    const start = performance.now();
    await run();
    durations.push(performance.now() - start);
    rssDeltas.push(Math.max(0, process.memoryUsage().rss - rssBefore) / 1024 / 1024);
  }
  return { milliseconds: median(durations), rssMiB: median(rssDeltas) };
}

console.log(`Node ${process.version}; ${samples} samples after one warmup; medians`);
console.log(
  "RSS deltas are advisory; run with --expose-gc for more repeatable memory observations.\n",
);

for (const [name, generate] of Object.entries(generators)) {
  for (const size of sizes) {
    const source = generate(size);
    const result = await measure(() => parser(source, { originalText: source }));
    results.push({ operation: "parse", name, size, ...result });
    console.log(
      `parse  ${name.padEnd(11)} n=${String(size).padStart(5)} ${result.milliseconds.toFixed(2).padStart(9)} ms  ${result.rssMiB.toFixed(1).padStart(6)} MiB`,
    );
  }
}

for (const size of sizes) {
  const source = `<main>${Array.from({ length: size }, (_, index) =>
    index % 2 === 0
      ? `<article><h2>{{ title }}</h2><p>ordinary content</p></article>`
      : `{% panel %}<section>{{ value }}</section>{% endpanel %}`,
  ).join("\n")}</main>`;
  const result = await measure(() => format(source, options));
  results.push({ operation: "format", name: "mixed-html", size, ...result });
  console.log(
    `format mixed-html  n=${String(size).padStart(5)} ${result.milliseconds.toFixed(2).padStart(9)} ms  ${result.rssMiB.toFixed(1).padStart(6)} MiB`,
  );
}

for (const size of sizes) {
  const source = `<main>${"<article><h2>title</h2><p>ordinary content</p></article>".repeat(size)}</main>`;
  const result = await measure(() => format(source, { parser: "html" }));
  results.push({ operation: "format", name: "plain-html", size, ...result });
  console.log(
    `format plain-html  n=${String(size).padStart(5)} ${result.milliseconds.toFixed(2).padStart(9)} ms  ${result.rssMiB.toFixed(1).padStart(6)} MiB`,
  );
}

const elapsedSeconds = (performance.now() - benchmarkStartedAt) / 1_000;
console.log(`\nSummary: ${results.length} measurements completed in ${elapsedSeconds.toFixed(1)}s`);
for (const operation of ["parse", "format"]) {
  const names = [
    ...new Set(
      results.filter((result) => result.operation === operation).map((result) => result.name),
    ),
  ];
  for (const name of names) {
    const group = results.filter(
      (result) => result.operation === operation && result.name === name,
    );
    const first = group[0];
    const last = group.at(-1);
    const inputGrowth = last.size / first.size;
    const timeGrowth = last.milliseconds / first.milliseconds;
    const peakRssMiB = Math.max(...group.map((result) => result.rssMiB));
    console.log(
      `${operation.padEnd(6)} ${name.padEnd(11)} ${first.milliseconds.toFixed(2)} → ${last.milliseconds.toFixed(2)} ms (${timeGrowth.toFixed(2)}x time for ${inputGrowth.toFixed(0)}x input), peak ΔRSS ${peakRssMiB.toFixed(1)} MiB`,
    );
  }
}
