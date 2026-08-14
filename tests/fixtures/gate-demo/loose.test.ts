import { describe, expect, it } from "vitest";
import { extractJson } from "@/lib/llm/jsonGuard";

describe("extractJson", () => {
  // 같은 함수를 테스트하지만 스캐너 경로를 아예 타지 않는다.
  // 원본에서도 뮤턴트에서도 통과하므로 결함을 잡지 못한다.
  it("깨끗한 JSON 객체를 파싱한다", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
});
