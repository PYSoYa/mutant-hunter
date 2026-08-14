import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LLMProvider } from "./llm/provider.js";
import {
  buildUserPrompt,
  extractTestSource,
  sourceSnippet,
  SYSTEM_PROMPT,
} from "./prompt.js";
import type { TestRunner } from "./stryker.js";
import { findSiblingTest, generatedTestPath } from "./testfile.js";
import type { Mutant } from "./types.js";
import { verifyGeneratedTest, type GateName, type GateResult } from "./verify.js";

export type Attempt = {
  index: number;
  gates: GateResult[];
  rejectedAt?: GateName;
};

export type GenerationResult = {
  mutant: Mutant;
  accepted: boolean;
  /** 채택된 테스트 소스 */
  testSource?: string;
  /** 채택 시 제안할 파일 경로 */
  testFileRel?: string;
  attempts: Attempt[];
  /** LLM 호출 실패 등 검증 이전 단계의 오류 */
  error?: string;
};

export type GenerateOptions = {
  repoRoot: string;
  runner: TestRunner;
  provider: LLMProvider;
  /**
   * 뮤턴트당 최대 시도 횟수.
   *
   * 등가 뮤턴트는 원리적으로 킬이 불가능하므로 무한 재시도는 쿼터만 태운다.
   * 1주차에 실제로 2개를 만났다 (raw.trim() -> raw, i < len -> i <= len).
   */
  maxAttempts?: number;
  configFile?: string;
  stabilityRuns?: number;
  runFullSuite?: boolean;
};

/**
 * 뮤턴트 하나에 대해 테스트를 생성하고 게이트로 검증한다.
 * 실패하면 어느 게이트에서 왜 떨어졌는지를 프롬프트에 담아 다시 시도한다.
 */
export async function generateKillingTest(
  mutant: Mutant,
  opts: GenerateOptions,
): Promise<GenerationResult> {
  const { repoRoot, runner, provider, maxAttempts = 2 } = opts;

  const absSource = join(repoRoot, mutant.path);
  let source: string;
  try {
    source = readFileSync(absSource, "utf8");
  } catch {
    return { mutant, accepted: false, attempts: [], error: `소스를 읽지 못했습니다: ${mutant.path}` };
  }

  const sibling = findSiblingTest(repoRoot, mutant.path);
  const siblingTest = sibling
    ? { path: sibling, content: readFileSync(join(repoRoot, sibling), "utf8") }
    : undefined;

  const snippet = sourceSnippet(
    source,
    Math.max(1, mutant.line - 15),
    mutant.endLine + 15,
  );

  const attempts: Attempt[] = [];
  let previousFailure: { gate: string; detail: string } | undefined;

  for (let i = 0; i < maxAttempts; i++) {
    let testSource: string;
    try {
      const res = await provider.generate({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt({ mutant, sourceSnippet: snippet, siblingTest, previousFailure }),
        // 첫 시도는 결정론적으로, 재시도는 다른 접근을 유도한다.
        temperature: i === 0 ? 0.1 : 0.6,
      });
      testSource = extractTestSource(res.text);
    } catch (err) {
      return {
        mutant,
        accepted: false,
        attempts,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (!testSource) {
      previousFailure = { gate: "empty-response", detail: "빈 응답" };
      attempts.push({ index: i, gates: [], rejectedAt: undefined });
      continue;
    }

    const testFileRel = generatedTestPath(repoRoot, mutant.path, `${mutant.id}-${i}`, sibling);
    const outcome = await verifyGeneratedTest({
      repoRoot,
      runner,
      mutant,
      testSource,
      testFileRel,
      configFile: opts.configFile,
      stabilityRuns: opts.stabilityRuns,
      runFullSuite: opts.runFullSuite,
    });

    attempts.push({ index: i, gates: outcome.gates, rejectedAt: outcome.rejectedAt });

    if (outcome.accepted) {
      return { mutant, accepted: true, testSource, testFileRel, attempts };
    }

    const failed = outcome.gates.find((g) => !g.ok);
    previousFailure = failed
      ? { gate: failed.gate, detail: failed.detail }
      : undefined;
  }

  return { mutant, accepted: false, attempts };
}

/** 폐기 사유 집계. "생성한 것의 몇 %를 스스로 버렸는가"를 숫자로 남긴다. */
export function summarize(results: GenerationResult[]): {
  total: number;
  accepted: number;
  rejectedBy: Record<string, number>;
  totalAttempts: number;
} {
  const rejectedBy: Record<string, number> = {};
  let totalAttempts = 0;

  for (const r of results) {
    totalAttempts += r.attempts.length;
    if (r.accepted) continue;
    const last = r.attempts[r.attempts.length - 1];
    const key = r.error ? "llm-error" : (last?.rejectedAt ?? "unknown");
    rejectedBy[key] = (rejectedBy[key] ?? 0) + 1;
  }

  return {
    total: results.length,
    accepted: results.filter((r) => r.accepted).length,
    rejectedBy,
    totalAttempts,
  };
}
