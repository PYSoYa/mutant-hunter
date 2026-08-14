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

export type Summary = {
  total: number;
  accepted: number;
  /** 최종 결과 기준 폐기 사유. 뮤턴트 단위. */
  rejectedBy: Record<string, number>;
  totalAttempts: number;
  /**
   * **모든 시도** 기준으로 게이트가 떨어뜨린 횟수.
   *
   * rejectedBy는 마지막 시도만 센다. 1차에서 게이트에 걸렸다가 2차에
   * 통과하면 "게이트가 걸러냈다"는 사실이 사라진다 — 안전망 크기를
   * 재려는 목적에 정확히 반대다. 이 숫자가 곧 "증명 못 한 것을 얼마나
   * 버렸는가"이고 이 프로젝트의 존재 이유다.
   */
  gateRejections: Record<string, number>;
  /** 게이트에 한 번 걸렸다가 재시도로 살아난 수 */
  rescuedByRetry: number;
};

/** 폐기 사유 집계. "생성한 것의 몇 %를 스스로 버렸는가"를 숫자로 남긴다. */
export function summarize(results: GenerationResult[]): Summary {
  const rejectedBy: Record<string, number> = {};
  const gateRejections: Record<string, number> = {};
  let totalAttempts = 0;
  let rescuedByRetry = 0;

  for (const r of results) {
    totalAttempts += r.attempts.length;

    // 모든 시도를 훑어 게이트가 떨어뜨린 것을 빠짐없이 센다.
    let hitGate = false;
    for (const attempt of r.attempts) {
      if (!attempt.rejectedAt) continue;
      hitGate = true;
      gateRejections[attempt.rejectedAt] =
        (gateRejections[attempt.rejectedAt] ?? 0) + 1;
    }
    if (hitGate && r.accepted) rescuedByRetry++;

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
    gateRejections,
    rescuedByRetry,
  };
}
