/**
 * 평가 결과로 자기완결 대시보드 HTML을 만든다.
 *
 *   npx tsx scripts/dashboard.ts [--eval-dir docs/eval] [--out docs/dashboard.html]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { buildDashboard } from "../src/dashboard/data.js";
import { renderDashboard } from "../src/dashboard/render.js";
import type { EvalRun } from "../src/eval/metrics.js";

const args = parseArgs(process.argv.slice(2));
const evalDir = abs(args["eval-dir"] ?? "docs/eval");
const outPath = abs(args["out"] ?? "docs/dashboard.html");

const runs: EvalRun[] = [];
for (const file of readdirSync(evalDir).sort()) {
  if (!file.endsWith(".json")) continue;
  try {
    const raw = JSON.parse(readFileSync(join(evalDir, file), "utf8")) as EvalRun;
    // 잡음 폭 요약 파일 등 EvalRun이 아닌 것은 건너뛴다.
    if (raw?.aggregate && raw?.label) runs.push(raw);
  } catch {
    console.error(`건너뜀 (읽기 실패): ${file}`);
  }
}

const data = buildDashboard(runs);
// 시각은 호출자가 찍는다. 렌더러는 시계를 읽지 않는다.
writeFileSync(outPath, renderDashboard(data, new Date().toISOString().slice(0, 16).replace("T", " ")));

console.log(`실행 ${data.totalRuns}건 · 코호트 ${data.cohorts.length}개`);
for (const c of data.cohorts) {
  const floor = c.measuredNoisePp ?? c.resolutionPp;
  console.log(
    `  뮤턴트 ${c.attempted}개 / ${c.provider ?? "?"} — 점 ${c.points.length}개, ` +
      `${c.measuredNoisePp ? "관측 잡음" : "최소 눈금"} ±${floor.toFixed(2)}%p`,
  );
}
console.log(`저장: ${outPath}`);

function abs(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k?.startsWith("--") && v !== undefined) out[k.slice(2)] = v;
  }
  return out;
}
