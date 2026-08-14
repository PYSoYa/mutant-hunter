import { describe, expect, it } from "vitest";
import { extractJson } from "@/lib/llm/jsonGuard";

describe("extractJson", () => {
  // 겨냥: L38 ConditionalExpression (ch === '"' -> false)
  // 문자열 안에 여는 중괄호만 넣어 inString 추적이 실제로 필요하게 만든다.
  it("문자열 안의 균형 잡히지 않은 '{'를 깊이로 세지 않는다", () => {
    expect(extractJson('noise {"a":"{"} tail')).toEqual({ a: "{" });
  });
});
