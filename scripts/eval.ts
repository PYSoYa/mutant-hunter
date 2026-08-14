/**
 * 골든 코퍼스 평가 실행기.
 *
 *   npx tsx scripts/eval.ts --corpus eval/corpus.json --label baseline
 *   npx tsx scripts/eval.ts --corpus eval/corpus.json --label after-prompt-v2 \
 *     --generate --compare docs/eval/baseline.json
 *
 * --generate 는 API 키를 요구한다 (MH_API_KEY 또는 GEMINI_API_KEY).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseCorpus } from "../src/eval/corpus.js";
import { compareRuns, type EvalRun } from "../src/eval/metrics.js";
import { renderEvalReport } from "../src/eval/report.js";
import { runEval } from "../src/eval/run.js";
import { computeNoiseFloor, renderNoiseFloor } from "../src/eval/variance.js";
import { providerFromEnv } from "../src/llm/index.js";

const args = parseArgs(process.argv.slice(2));

const corpusPath = resolvePath(args["corpus"] ?? "eval/corpus.json");
const outDir = resolvePath(args["out"] ?? "docs/eval");
const label = args["label"] ?? "unlabeled";
const wantGenerate = "generate" in args;

const corpus = parseCorpus(JSON.parse(readFileSync(corpusPath, "utf8")));
console.log(`코퍼스 ${corpus.entries.length}개 표본 — ${corpusPath}`);

let provider;
if (wantGenerate) {
  provider = providerFromEnv();
  if (!provider) {
    console.error("API 키가 없습니다 (MH_API_KEY 또는 GEMINI_API_KEY).");
    process.exit(1);
  }
  console.log(`provider=${provider.name}`);
}

const repeat = Math.max(1, Number(args["repeat"] ?? 1));
const runs: EvalRun[] = [];

for (let i = 0; i < repeat; i++) {
  const runLabel = repeat > 1 ? `${label}-run${i + 1}` : label;
  if (repeat > 1) console.log(`\n=== 반복 ${i + 1}/${repeat} ===`);

  runs.push(
    await runEval(corpus.entries, {
      baseDir: dirname(corpusPath),
      workDir: resolvePath(args["work-dir"] ?? ".eval-work"),
      provider,
      label: runLabel,
      maxMutants: args["max-mutants"] ? Number(args["max-mutants"]) : undefined,
      maxAttempts: args["max-attempts"] ? Number(args["max-attempts"]) : undefined,
      log: (m) => console.log(m),
    }),
  );
}

const run = runs[runs.length - 1]!;

let comparison;
if (args["compare"]) {
  const before = JSON.parse(
    readFileSync(resolvePath(args["compare"]), "utf8"),
  ) as EvalRun;
  comparison = compareRuns(before, run);
}

mkdirSync(outDir, { recursive: true });

for (const r of runs) {
  writeFileSync(join(outDir, `${r.label}.json`), JSON.stringify(r, null, 2));
}

const jsonPath = join(outDir, `${run.label}.json`);
const mdPath = join(outDir, `${label}.md`);

let markdown = renderEvalReport(run, comparison);
if (runs.length > 1) {
  // 반복 실행의 목적은 마지막 결과가 아니라 흔들림의 폭이다.
  markdown = `${renderNoiseFloor(computeNoiseFloor(runs), label)}\n---\n\n${markdown}`;
  writeFileSync(
    join(outDir, `${label}-noise.json`),
    JSON.stringify(computeNoiseFloor(runs), null, 2),
  );
}

writeFileSync(mdPath, `${markdown}\n`);

console.log(`\n${markdown}`);
console.log(`\n저장: ${jsonPath}\n      ${mdPath}`);

// 회귀는 조용히 넘어가면 안 된다. CI에서 이 종료 코드로 잡을 실패시킨다.
if (comparison?.hasRegression) process.exitCode = 1;

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const BOOLEAN = new Set(["generate"]);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const name = key.slice(2);
    if (BOOLEAN.has(name)) {
      out[name] = "true";
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined) continue;
    out[name] = val;
    i++;
  }
  return out;
}
