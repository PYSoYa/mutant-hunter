import { classifyFailure, retryGuidance } from "./failure.js";
import type { Mutant } from "./types.js";

export const SYSTEM_PROMPT = `당신은 TypeScript/JavaScript 테스트를 작성하는 도구다.

당신에게는 "살아남은 뮤턴트"가 주어진다. 뮤턴트란 소스 코드의 한 조각을 일부러
바꿔치기한 것이고, 살아남았다는 것은 그렇게 바꿔도 기존 테스트가 전부 통과했다는
뜻이다. 즉 그 코드는 틀려도 아무도 알아채지 못한다.

당신의 임무는 그 뮤턴트를 죽이는 테스트를 쓰는 것이다. 작성한 테스트는

1. 원본 코드에서 반드시 통과해야 하고
2. 뮤턴트가 적용된 코드에서 반드시 실패해야 한다

두 조건 중 하나라도 어기면 그 테스트는 버려진다. 특히 2번을 놓치기 쉽다.
단언이 느슨하면 원본에서도 뮤턴트에서도 통과해 버린다. 뮤턴트가 만들어내는
구체적인 값·메시지·호출 인자를 정확히 겨냥하라.

쓰기 전에 두 가지를 먼저 계산하라.

1. 어떤 입력을 넣으면 원본과 뮤턴트가 **다른 결과**를 내는가
2. 그 입력에서 원본 코드가 내놓는 값이 **정확히** 무엇인가

2번을 짐작하지 마라. 주어진 코드를 손으로 따라가며 계산하라. 실측에서
가장 흔한 실패가 기대값을 잘못 찍는 것이었다 — 예를 들어 결과가
문자열 "false"인데 빈 문자열을 기대해 원본에서부터 실패했다.

정확한 값을 확신할 수 없으면, 값을 단언하는 대신 **원본과 뮤턴트가
갈리는 성질**을 단언하라. 예를 들어 던지는가/던지지 않는가, 길이가
0인가 아닌가, 특정 부분 문자열을 포함하는가.

규칙:
- 완전한 테스트 파일 하나를 출력한다. 설명이나 마크다운 없이 코드만.
- 주어진 기존 테스트 파일의 import 스타일, 러너 API, 모킹 방식을 그대로 따른다.
- 시간·난수·실행 순서에 의존하지 않는다. 반복 실행해도 결과가 같아야 한다.
- 소스 코드를 수정하는 테스트는 쓰지 않는다.
- **기존 테스트 파일의 케이스를 복사하지 마라.** 참고용으로 준 것이지
  옮겨 적으라고 준 것이 아니다. 새로 추가하는 케이스만 담되, 파일이 단독으로
  실행되도록 필요한 import와 헬퍼는 포함하라. 실측에서 기존 21개를 그대로
  베끼고 1개만 더한 응답이 나왔다 — 적용하면 같은 테스트가 두 번 돈다.
- 거대한 픽스처가 있어야만 도달하는 분기라면(예: 수천 개 파일이 필요한
  상한 검사) 무리해서 만들지 말고, 그 뮤턴트는 죽이기 어렵다고 판단하라.
- 각 테스트에 무엇을 겨냥하는지 한 줄 주석을 남긴다.`;

export type PromptContext = {
  mutant: Mutant;
  /** 뮤턴트를 감싸는 선언의 소스 (줄 번호 포함) */
  sourceSnippet: string;
  /** 스타일 참고용 기존 테스트 파일 */
  siblingTest?: { path: string; content: string };
  /** 대상 모듈이 실제로 내보내는 것들. 없는 API를 지어내지 않게 한다. */
  moduleExports?: string;
  /** 이전 시도가 어느 게이트에서 왜 떨어졌는지 */
  previousFailure?: { gate: string; detail: string };
};

/** 컨텍스트가 커지면 무료 티어 쿼터를 빠르게 태운다. */
const MAX_SIBLING_CHARS = 6000;
const MAX_FAILURE_CHARS = 1500;

export function buildUserPrompt(ctx: PromptContext): string {
  const { mutant, sourceSnippet, siblingTest, previousFailure } = ctx;

  const parts = [
    `## 대상 파일\n${mutant.path}`,
    `## 살아남은 뮤턴트\n` +
      `위치: ${mutant.path}:${mutant.line}:${mutant.column}\n` +
      `종류: ${mutant.mutatorName}\n\n` +
      "원본 코드:\n```ts\n" +
      mutant.original +
      "\n```\n\n" +
      "뮤턴트가 이렇게 바꿔치기한다:\n```ts\n" +
      mutant.replacement +
      "\n```",
    `## 뮤턴트를 감싸는 코드\n\`\`\`ts\n${sourceSnippet}\n\`\`\``,
  ];

  if (ctx.moduleExports) {
    parts.push(
      `## ${mutant.path}가 내보내는 것\n` +
        "**이 목록에 없는 이름은 존재하지 않는다.** 지어내지 마라.\n" +
        "```\n" +
        ctx.moduleExports +
        "\n```",
    );
  }

  if (siblingTest) {
    parts.push(
      `## 기존 테스트 파일 (${siblingTest.path})\n` +
        "이 파일의 import 경로, 러너 API, 모킹 방식을 그대로 따르라.\n" +
        "```ts\n" +
        truncate(siblingTest.content, MAX_SIBLING_CHARS) +
        "\n```",
    );
  }

  if (previousFailure) {
    const guidance = retryGuidance(
      classifyFailure(previousFailure.detail, previousFailure.gate),
    );

    parts.push(
      `## 직전 시도가 실패했다\n` +
        `게이트: ${previousFailure.gate}\n` +
        `사유: ${truncate(previousFailure.detail, MAX_FAILURE_CHARS)}\n\n` +
        guidance,
    );
  }

  parts.push(
    "## 출력\n완전한 테스트 파일 하나를 코드만 출력하라. 설명을 덧붙이지 마라.",
  );

  return parts.join("\n\n");
}

/**
 * LLM 응답에서 테스트 소스만 뽑는다.
 * 코드만 달라고 해도 마크다운 펜스를 붙이는 경우가 흔하다.
 */
export function extractTestSource(text: string): string {
  const fenced = /```(?:ts|tsx|typescript|js|jsx|javascript)?\s*\n([\s\S]*?)```/.exec(
    text,
  );
  return (fenced?.[1] ?? text).trim();
}

/** 뮤턴트를 감싸는 선언을 줄 번호와 함께 잘라낸다. */
export function sourceSnippet(
  source: string,
  startLine: number,
  endLine: number,
): string {
  const lines = source.split("\n");
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length, endLine);
  const width = String(to).length;

  return lines
    .slice(from - 1, to)
    .map((text, i) => `${String(from + i).padStart(width)} | ${text}`)
    .join("\n");
}

function truncate(s: string, limit: number): string {
  return s.length > limit ? `${s.slice(0, limit)}\n… (생략)` : s;
}
