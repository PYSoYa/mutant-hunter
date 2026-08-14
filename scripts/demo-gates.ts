/**
 * 검증 게이트를 실제 대상 repo에 돌려보는 데모.
 *
 * 같은 뮤턴트에 대해 두 가지 테스트를 넣는다.
 *   killing.test.ts — 뮤턴트를 죽인다        → 채택돼야 한다
 *   loose.test.ts   — 원본에서만 통과한다    → kills-mutant에서 떨어져야 한다
 *
 * 두 번째가 이 프로젝트의 존재 이유다. 원본에서 멀쩡히 통과하고 리뷰로도
 * 걸러내기 어려운 테스트를, 실행만이 잡아낸다.
 *
 * 사용법:
 *   npx tsx scripts/demo-gates.ts --repo <대상> --mutant-id <id> [--runner-config <경로>]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { detectTestRunner, WORK_DIR } from "../src/stryker.js";
import { findSiblingTest, generatedTestPath } from "../src/testfile.js";
import type { MutantScanResult } from "../src/types.js";
import { verifyGeneratedTest } from "../src/verify.js";

const args = parseArgs(process.argv.slice(2));
const repoRoot = resolve(args["repo"] ?? "");
const mutantId = args["mutant-id"] ?? "29";
const configFile = args["runner-config"];

const scan = JSON.parse(
  readFileSync(join(repoRoot, WORK_DIR, "candidates.json"), "utf8"),
) as MutantScanResult;

const mutant = scan.candidates.find((m) => m.id === mutantId);
if (!mutant) throw new Error(`뮤턴트 ${mutantId}를 후보에서 찾지 못했습니다`);

const runner = detectTestRunner(repoRoot);
const sibling = findSiblingTest(repoRoot, mutant.path);

console.log(`대상 뮤턴트  [${mutant.mutatorName}] ${mutant.path}:${mutant.line}`);
console.log(`  원본: ${mutant.original.replace(/\s+/g, " ")}`);
console.log(`  변이: ${mutant.replacement.replace(/\s+/g, " ")}`);
console.log(`형제 테스트  ${sibling ?? "(없음)"}\n`);

for (const kind of ["killing", "loose"] as const) {
  const source = readFileSync(
    fileURLToPath(new URL(`../tests/fixtures/gate-demo/${kind}.test.ts`, import.meta.url)),
    "utf8",
  );

  const outcome = await verifyGeneratedTest({
    repoRoot,
    runner,
    mutant,
    testSource: source,
    testFileRel: generatedTestPath(repoRoot, mutant.path, `${kind}-${mutant.id}`, sibling),
    configFile,
  });

  console.log(`── ${kind}.test.ts`);
  for (const g of outcome.gates) {
    console.log(`   ${g.ok ? "✅" : "❌"} ${g.gate.padEnd(20)} ${firstLine(g.detail)}`);
  }
  console.log(
    outcome.accepted
      ? "   → 채택\n"
      : `   → 폐기 (${outcome.rejectedAt})\n`,
  );
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 70 ? `${line.slice(0, 70)}…` : line;
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
