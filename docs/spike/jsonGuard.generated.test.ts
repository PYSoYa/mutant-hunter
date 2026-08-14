// [SPIKE] 살아남은 뮤턴트를 죽이기 위해 생성된 테스트.
// 각 테스트는 자신이 겨냥하는 뮤턴트를 주석으로 명시한다.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const callLLMMock = vi.fn();

vi.mock("@/lib/llm/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/llm/client")>(
      "@/lib/llm/client",
    );
  return {
    ...actual,
    callLLM: callLLMMock,
  };
});

const { extractJson, JsonGuardError, validateOrRepair } = await import(
  "@/lib/llm/jsonGuard"
);

describe("extractJson - 스캐너 경계", () => {
  // 겨냥: L18 ConditionalExpression (if (direct.ok) -> false)
  // 최상위가 배열이면 직접 파싱 경로로만 성공할 수 있다.
  it("직접 파싱으로 최상위 배열을 반환한다", () => {
    expect(extractJson("[1,2,3]")).toEqual([1, 2, 3]);
  });

  // 겨냥: L21 ConditionalExpression / UnaryOperator / BlockStatement
  // 기존 테스트는 toThrow(JsonGuardError)만 봐서 메시지 분기를 못 지켰다.
  it("'{'가 없으면 전용 메시지로 실패한다", () => {
    expect(() => extractJson("no json here")).toThrow(/No '\{' found/);
  });

  // 겨냥: L38 ConditionalExpression/BlockStatement, L39 BooleanLiteral, L42 ConditionalExpression
  // 기존 테스트는 문자열 안에 "}{" 처럼 균형 잡힌 쌍을 넣어 버그가 상쇄됐다.
  // 여기서는 여는 중괄호만 넣어 inString 처리가 실제로 필요하게 만든다.
  it("문자열 안의 균형 잡히지 않은 '{'를 깊이로 세지 않는다", () => {
    const raw = 'noise {"a":"{"} tail';
    expect(extractJson(raw)).toEqual({ a: "{" });
  });

  // 겨냥: L30 ConditionalExpression (if (escape)), L34 ConditionalExpression (ch === "\\")
  // 기존 이스케이프 테스트는 직접 파싱에 성공해서 스캐너를 아예 안 탔다.
  it("prose에 둘러싸인 문자열의 이스케이프된 따옴표를 처리한다", () => {
    const raw = 'x {"a":"q\\"}"} y';
    expect(extractJson(raw)).toEqual({ a: 'q"}' });
  });

  // 겨냥: L68 ObjectLiteral (tryParse 실패 반환 -> {})
  it("파싱 실패 시 원인 메시지를 담아 던진다", () => {
    expect(() => extractJson("{not, json}")).toThrow(
      /Failed to parse balanced JSON block: \S+/,
    );
  });
});

describe("validateOrRepair - 오류 포맷과 repair 호출", () => {
  const schema = z.object({
    name: z.string(),
    age: z.number().int().nonnegative(),
  });

  beforeEach(() => {
    callLLMMock.mockReset();
  });

  // 겨냥: L135 ObjectLiteral, L138 BlockStatement, L139 MethodExpression,
  //       L141 ArrowFunction/ConditionalExpression x2/LogicalOperator
  it("실패한 필드 경로를 오류 메시지에 담는다", async () => {
    const broken = '{"name":"bob","age":"nope"}';
    callLLMMock.mockResolvedValueOnce({
      raw: '{"name":"bob","age":"still-nope"}',
      model: "mock",
      promptTokens: 0,
      completionTokens: 10,
    });

    await expect(
      validateOrRepair(schema, broken, { system: "s", user: "u" }),
    ).rejects.toThrow(/age: \S+/);
  });

  // 겨냥: L140 MethodExpression (.slice(0, 5) 제거)
  it("오류를 최대 5개까지만 보고한다", async () => {
    const wide = z.object({
      f1: z.string(),
      f2: z.string(),
      f3: z.string(),
      f4: z.string(),
      f5: z.string(),
      f6: z.string(),
      f7: z.string(),
    });
    callLLMMock.mockResolvedValueOnce({
      raw: "{}",
      model: "mock",
      promptTokens: 0,
      completionTokens: 1,
    });

    const err = await validateOrRepair(wide, "{}", {
      system: "s",
      user: "u",
    }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(JsonGuardError);
    expect((err as Error).message).toContain("f5:");
    expect((err as Error).message).not.toContain("f6:");
  });

  // 겨냥: L92 ObjectLiteral, L97 BooleanLiteral (jsonMode: true -> false),
  //       L147 BlockStatement (buildRepairPrompt -> {})
  it("repair 호출을 jsonMode와 repair 프롬프트로 수행한다", async () => {
    callLLMMock.mockResolvedValueOnce({
      raw: '{"name":"z","age":1}',
      model: "mock",
      promptTokens: 0,
      completionTokens: 5,
    });

    await validateOrRepair(schema, '{"name":"z","age":"x"}', {
      system: "s",
      user: "u",
    });

    const arg = callLLMMock.mock.calls[0][0];
    expect(arg.jsonMode).toBe(true);
    expect(arg.temperature).toBe(0);
    expect(arg.user).toMatch(/failed validation/);
  });

  // 겨냥: L151 MethodExpression (badJson.slice(0, 8000) -> badJson)
  it("repair 프롬프트에 넣는 원본 JSON을 8000자로 자른다", async () => {
    const tail = '","age":"bad"}';
    const huge = '{"name":"' + "x".repeat(9000) + tail;
    callLLMMock.mockResolvedValueOnce({
      raw: '{"name":"ok","age":1}',
      model: "mock",
      promptTokens: 0,
      completionTokens: 5,
    });

    await validateOrRepair(schema, huge, { system: "s", user: "u" });

    const arg = callLLMMock.mock.calls[0][0];
    expect(arg.user).not.toContain(tail);
  });
});
