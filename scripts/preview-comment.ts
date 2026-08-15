/**
 * 저장된 평가 산출물로 PR 코멘트를 렌더링해 눈으로 확인한다.
 * 코멘트는 사람이 읽는 것이라 스냅샷 테스트만으로는 부족하다.
 *
 *   npx tsx scripts/preview-comment.ts <대상 repo 경로>
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PipelineResult } from "../src/pipeline.js";
import { renderReport } from "../src/report.js";
import { WORK_DIR } from "../src/stryker.js";

const root = resolve(process.argv[2] ?? ".");
const read = (name: string) =>
  JSON.parse(readFileSync(join(root, WORK_DIR, name), "utf8"));

const gen = read("generated.json") as Pick<PipelineResult, "results" | "summary">;
const scan = read("candidates.json") as PipelineResult["scan"];

const first = gen.results?.[0]?.mutant.path ?? "src";
console.log(
  renderReport(
    {
      status: "generated",
      ranges: [{ path: first, start: 1, end: 1, symbol: "preview" }],
      scan,
      results: gen.results,
      summary: gen.summary,
    },
    { repo: "PYSoYa/mutant-hunter", sha: "HEAD" },
  ),
);
