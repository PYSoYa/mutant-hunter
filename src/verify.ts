import { join } from "node:path";
import { withMutantApplied } from "./apply.js";
import { runTests } from "./runner.js";
import type { TestRunner } from "./stryker.js";
import { checkSyntax } from "./syntax.js";
import { removeGeneratedTest, writeGeneratedTest } from "./testfile.js";
import type { Mutant } from "./types.js";

export type GateName =
  /** 파싱은 되는가 — 가장 싼 검사라 맨 앞에 둔다 */
  | "parses"
  /** 원본 코드에서 통과하는가 — 애초에 말이 되는 테스트인가 */
  | "passes-on-original"
  /** 뮤턴트 코드에서 실패하는가 — 진짜 결함을 잡는가 (핵심 관문) */
  | "kills-mutant"
  /** 반복 실행해도 결과가 같은가 — flaky를 심지 않는가 */
  | "stable"
  /** 기존 스위트를 깨뜨리지 않는가 */
  | "suite-intact";

export type GateResult = {
  gate: GateName;
  ok: boolean;
  detail: string;
};

export type VerifyOutcome = {
  accepted: boolean;
  gates: GateResult[];
  /** 통과하지 못한 첫 게이트. 폐기 사유 통계에 쓴다. */
  rejectedAt?: GateName;
};

export type VerifyOptions = {
  repoRoot: string;
  runner: TestRunner;
  mutant: Mutant;
  /** LLM이 생성한 테스트 소스 */
  testSource: string;
  /** 대상 repo 기준 상대 경로. 검증이 끝나면 지운다. */
  testFileRel: string;
  configFile?: string;
  /** 안정성 게이트 반복 횟수 (첫 실행 포함) */
  stabilityRuns?: number;
  /** 전체 스위트 게이트를 돌릴지. 느리므로 끄고 배치 말미에 한 번만 돌릴 수도 있다. */
  runFullSuite?: boolean;
};

/**
 * 생성된 테스트를 4개 게이트로 검증한다.
 *
 * 순서는 비용순이자 탈락 확률순이다. 싸고 잘 떨어지는 것부터 돌려
 * 무료 티어 쿼터와 CI 시간을 아낀다. 하나라도 실패하면 즉시 중단한다.
 */
export async function verifyGeneratedTest(
  opts: VerifyOptions,
): Promise<VerifyOutcome> {
  const {
    repoRoot,
    runner,
    mutant,
    testSource,
    testFileRel,
    configFile,
    stabilityRuns = 3,
    runFullSuite = true,
  } = opts;

  const gates: GateResult[] = [];
  const reject = (gate: GateName): VerifyOutcome => ({
    accepted: false,
    gates,
    rejectedAt: gate,
  });

  // 게이트 0 — 파싱되는가.
  // 실측에서 원본 통과 실패의 40%가 문법 오류였다. 그걸 잡으려고
  // vitest를 띄우는 건 낭비다. 파서는 즉시, 공짜로 답한다.
  const syntax = checkSyntax(testSource, testFileRel);
  gates.push({
    gate: "parses",
    ok: syntax.ok,
    detail: syntax.ok ? "통과" : syntax.message,
  });
  if (!syntax.ok) return reject("parses");

  writeGeneratedTest(repoRoot, testFileRel, testSource);

  try {
    // 게이트 1 — 원본에서 통과하는가.
    // 컴파일 에러, 잘못된 import, 틀린 기대값이 여기서 걸린다.
    const original = await runTests(repoRoot, runner, {
      testFile: testFileRel,
      configFile,
    });
    gates.push({
      gate: "passes-on-original",
      ok: original.passed,
      detail: original.passed
        ? "통과"
        : original.timedOut
          ? "실행이 상한을 넘겨 강제 종료됨 (멈추는 테스트)"
          : tail(original.output),
    });
    if (!original.passed) return reject("passes-on-original");

    // 게이트 2 — 뮤턴트에서 실패하는가. 이 프로젝트의 존재 이유.
    // 원본에서 통과하는 그럴듯한 테스트는 얼마든지 쓸 수 있다.
    // 결함을 실제로 잡는지는 오직 여기서만 판별된다.
    const mutated = await withMutantApplied(
      join(repoRoot, mutant.path),
      mutant,
      () => runTests(repoRoot, runner, { testFile: testFileRel, configFile }),
    );
    // 멈춘 실행을 "실패했으니 뮤턴트를 죽였다"로 읽으면 안 된다.
    // 판정 불가는 폐기다.
    const killed = !mutated.passed && !mutated.timedOut;
    gates.push({
      gate: "kills-mutant",
      ok: killed,
      detail: killed
        ? "뮤턴트를 죽였다"
        : mutated.timedOut
          ? "실행이 상한을 넘겨 강제 종료됨 — 죽였다고 볼 수 없다"
          : "뮤턴트가 살아남았다 — 결함을 잡지 못하는 테스트",
    });
    if (!killed) return reject("kills-mutant");

    // 게이트 3 — 반복해도 같은 결과인가.
    // 시간·난수·순서에 의존하는 테스트를 남의 CI에 심으면 안 된다.
    const repeats = Math.max(0, stabilityRuns - 1);
    for (let i = 0; i < repeats; i++) {
      const again = await runTests(repoRoot, runner, {
        testFile: testFileRel,
        configFile,
      });
      if (!again.passed) {
        gates.push({
          gate: "stable",
          ok: false,
          detail: `${i + 2}회차 실행에서 실패 — flaky`,
        });
        return reject("stable");
      }
    }
    gates.push({
      gate: "stable",
      ok: true,
      detail: `${stabilityRuns}회 반복 통과`,
    });

    // 게이트 4 — 기존 스위트 무해한가. 가장 비싸므로 마지막.
    if (runFullSuite) {
      const suite = await runTests(repoRoot, runner, {});
      gates.push({
        gate: "suite-intact",
        ok: suite.passed,
        detail: suite.passed ? "기존 스위트 통과" : tail(suite.output),
      });
      if (!suite.passed) return reject("suite-intact");
    }

    return { accepted: true, gates };
  } finally {
    // 검증 결과와 무관하게 대상 repo를 원래대로 되돌린다.
    removeGeneratedTest(repoRoot, testFileRel);
  }
}

function tail(output: string, limit = 800): string {
  const trimmed = output.trim();
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}
