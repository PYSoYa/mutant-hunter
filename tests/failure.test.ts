import { describe, expect, it } from "vitest";
import { classifyFailure, retryGuidance } from "../src/failure.js";

describe("classifyFailure", () => {
  it("단언 실패에서 실제값과 기대값을 뽑는다", () => {
    const f = classifyFailure("AssertionError: expected 'false' to be '' // Object.is");
    expect(f.kind).toBe("assertion");
    expect(f.actual).toBe("'false'");
    expect(f.expected).toBe("''");
  });

  it("toEqual 형태도 읽는다", () => {
    const f = classifyFailure("AssertionError: expected [ 1, 2 ] to deeply equal [ 1 ]");
    expect(f.kind).toBe("assertion");
    expect(f.actual).toBe("[ 1, 2 ]");
  });

  it("값을 못 뽑아도 단언 실패로는 분류한다", () => {
    expect(classifyFailure("AssertionError: 뭔가 이상함").kind).toBe("assertion");
  });

  it("단언 실패를 문법 오류로 세지 않는다", () => {
    // 이 오분류가 실제로 일어났다. 잘린 로그에 /Expected/ 정규식을 돌려
    // vitest diff 헤더('- Expected')에 걸렸고, 그 집계로 작업 방향을 정했다.
    const detail = [
      "AssertionError: expected 'a' to be 'b'",
      "- Expected",
      "+ Received",
      " Test Files  1 failed (1)",
    ].join("\n");
    expect(classifyFailure(detail).kind).toBe("assertion");
  });

  it("vitest 요약부만 있으면 unknown이다", () => {
    // 예전에는 이 조각만 저장돼 분류가 불가능했다.
    const detail = " Test Files  1 failed (1)\n Duration  163ms";
    expect(classifyFailure(detail).kind).toBe("unknown");
  });

  it("문법 오류를 알아본다", () => {
    expect(classifyFailure("Transform failed with 1 error").kind).toBe("syntax");
    expect(classifyFailure("SyntaxError: Unexpected token").kind).toBe("syntax");
  });

  it("import 실패를 알아본다", () => {
    expect(classifyFailure("Error: Cannot find module './x.js'").kind).toBe("import");
    expect(classifyFailure("Failed to resolve import \"@/a\"").kind).toBe("import");
  });

  it("없는 API 호출을 알아본다", () => {
    expect(classifyFailure("TypeError: fn is not a function").kind).toBe("missing-api");
    expect(classifyFailure("ReferenceError: 없는것 is not defined").kind).toBe("missing-api");
  });

  it("없는 API를 단언 실패보다 우선한다", () => {
    // 단언 안에서 없는 함수를 부르면 두 패턴이 함께 나온다.
    // 고쳐야 할 것은 단언이 아니라 호출이다.
    const detail = "TypeError: guard is not a function\nexpected undefined to be 1";
    expect(classifyFailure(detail).kind).toBe("missing-api");
  });

  it("테스트 수집 실패를 알아본다", () => {
    expect(classifyFailure("No test files found").kind).toBe("no-tests");
  });

  it("타임아웃을 알아본다", () => {
    expect(classifyFailure("[mutant-hunter] 300000ms 초과로 강제 종료").kind).toBe("timeout");
  });

  it("모르는 출력은 unknown이다", () => {
    expect(classifyFailure("알 수 없는 무언가").kind).toBe("unknown");
  });
});

describe("retryGuidance", () => {
  it("실제값을 알면 그 값을 짚어준다", () => {
    const g = retryGuidance({ kind: "assertion", actual: "'false'", expected: "''" });
    expect(g).toContain("'false'");
    expect(g).toContain("기대했다");
  });

  it("실제값을 알려주되 그것만으로 부족하다고 경고한다", () => {
    // 기대값만 실제값으로 바꾸면 원본은 통과하지만 뮤턴트도 통과한다.
    // 그러면 다음 게이트에서 떨어진다.
    const g = retryGuidance({ kind: "assertion", actual: "1", expected: "2" });
    expect(g).toContain("뮤턴트에서도 같게 나오면 소용없다");
  });

  it("값을 모르면 계산하라고만 한다", () => {
    const g = retryGuidance({ kind: "assertion" });
    expect(g).toContain("손으로 따라가");
    expect(g).not.toContain("실제로");
  });

  it("없는 API에는 export 목록을 가리킨다", () => {
    expect(retryGuidance({ kind: "missing-api" })).toContain("export 목록");
  });

  it("import 실패에는 기존 테스트의 경로 표기를 따르라고 한다", () => {
    expect(retryGuidance({ kind: "import" })).toContain("똑같은 경로 표기");
  });

  it("타임아웃에는 무한 대기를 없애라고 한다", () => {
    expect(retryGuidance({ kind: "timeout" })).toContain("무한 대기");
  });

  it("모르는 실패에도 문장을 준다", () => {
    expect(retryGuidance({ kind: "unknown" })).toBeTruthy();
  });
});

describe("게이트를 알면 텍스트를 추측하지 않는다", () => {
  it("kills-mutant는 오류가 아니라 결과다", () => {
    // 게이트를 안 넘겼더니 이 42건이 전부 unknown으로 뭉개졌다.
    const f = classifyFailure("뮤턴트가 살아남았다 — 결함을 잡지 못하는 테스트", "kills-mutant");
    expect(f.kind).toBe("not-killed");
  });

  it("parses 게이트 메시지를 문법 오류로 안다", () => {
    // 우리 분류기가 우리 도구의 메시지를 못 알아봤다.
    expect(classifyFailure("L3:5 '}' expected.", "parses").kind).toBe("syntax");
  });

  it("게이트를 모르면 텍스트로 분류한다", () => {
    expect(classifyFailure("AssertionError: expected 1 to be 2").kind).toBe("assertion");
  });

  it("not-killed에는 차이를 겨냥하라는 지침을 준다", () => {
    expect(retryGuidance({ kind: "not-killed" })).toContain("차이를 정확히 겨냥");
  });
});
