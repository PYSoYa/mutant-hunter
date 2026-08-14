/**
 * 실패 출력을 분류한다.
 *
 * 이 로직은 원래 일회성 스크립트의 정규식이었다. 잘린 로그에 돌린 탓에
 * 단언 실패를 문법 오류로 세었고, **그 잘못된 집계로 작업 방향을 정했다.**
 * 분류가 의사결정의 근거라면 코드에 있고 테스트로 지켜져야 한다.
 */
export type FailureKind =
  | "syntax"
  | "import"
  | "missing-api"
  | "no-tests"
  | "assertion"
  | "timeout"
  | "unknown";

export type Failure = {
  kind: FailureKind;
  /** 단언 실패일 때 원본 코드가 실제로 내놓은 값 */
  actual?: string;
  /** 단언 실패일 때 테스트가 기대한 값 */
  expected?: string;
};

/** `expected 'a' to be 'b'` — vitest는 실제값을 먼저, 기대값을 나중에 쓴다. */
const ASSERTION = /expected\s+(.+?)\s+to\s+(?:be|equal|deeply equal|contain|match)\s+(.+?)(?:\s*\/\/|$)/ims;

export function classifyFailure(detail: string): Failure {
  if (/상한을 넘겨 강제 종료|초과로 강제 종료/.test(detail)) {
    return { kind: "timeout" };
  }
  if (/Transform failed|SyntaxError/.test(detail)) {
    return { kind: "syntax" };
  }
  if (/Cannot find module|Failed to resolve import|ERR_MODULE_NOT_FOUND/.test(detail)) {
    return { kind: "import" };
  }
  if (/No test files found|no tests? found/i.test(detail)) {
    return { kind: "no-tests" };
  }
  // 없는 이름을 부른 경우. 단언 실패보다 먼저 봐야 한다 —
  // 단언 안에서 없는 함수를 부르면 두 패턴이 함께 나온다.
  if (/is not a function|is not defined|ReferenceError|TypeError/.test(detail)) {
    return { kind: "missing-api" };
  }

  const m = ASSERTION.exec(detail);
  if (m) {
    return {
      kind: "assertion",
      actual: trim(m[1]),
      expected: trim(m[2]),
    };
  }
  if (/AssertionError/.test(detail)) return { kind: "assertion" };

  return { kind: "unknown" };
}

/**
 * 실패 종류에 맞춘 재시도 지침.
 *
 * "위 사유를 해결하라"는 막연한 지시로는 같은 실수를 반복한다.
 * 무엇이 틀렸는지 아는 만큼 구체적으로 말해줘야 한다.
 */
export function retryGuidance(failure: Failure): string {
  switch (failure.kind) {
    case "assertion":
      if (failure.actual && failure.expected) {
        return (
          `단언이 틀렸다. 원본 코드는 실제로 \`${failure.actual}\`를 내놓았는데 ` +
          `테스트는 \`${failure.expected}\`를 기대했다.\n\n` +
          `\`${failure.actual}\`가 옳은 값이다. 기대값을 그것으로 고치되, ` +
          `**그 값이 뮤턴트에서도 같게 나오면 소용없다.** 뮤턴트가 만들어내는 값이 ` +
          `무엇인지 먼저 따져보고, 두 값이 실제로 다른 입력을 골라라.`
        );
      }
      return (
        "단언이 원본 코드에서 실패했다. 기대값을 짐작하지 말고 " +
        "주어진 코드를 손으로 따라가 계산하라."
      );

    case "missing-api":
      return (
        "존재하지 않는 이름을 불렀다. 위에 준 export 목록에 있는 것만 써라. " +
        "목록에 없으면 그 함수는 없는 것이다."
      );

    case "import":
      return (
        "import가 해석되지 않았다. 기존 테스트 파일과 **똑같은 경로 표기**를 써라. " +
        "별칭(`@/`)을 쓰는지 상대 경로를 쓰는지 그대로 따라가라."
      );

    case "syntax":
      return "문법이 깨졌다. 완전한 파일 하나를 처음부터 다시 써라.";

    case "no-tests":
      return (
        "테스트가 하나도 수집되지 않았다. `describe`/`it` 블록이 실제로 있는지, " +
        "최상위에서 호출되는지 확인하라."
      );

    case "timeout":
      return (
        "테스트가 끝나지 않아 강제 종료됐다. 타이머·열린 핸들·무한 대기를 없애고, " +
        "동기적으로 판정할 수 있는 형태로 다시 써라."
      );

    default:
      return "위 사유를 해결한 테스트를 다시 작성하라.";
  }
}

/** 따옴표와 잡음을 걷어낸 값 텍스트. */
function trim(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const cleaned = s.trim().replace(/\s+/g, " ");
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned;
}
