import { describe, expect, it } from "vitest";
import {
  backoffMs,
  MAX_RETRY_WAIT_MS,
  parseRetryDelayMs,
  waitMs,
} from "../src/llm/gemini.js";

const headers = (map: Record<string, string>) => ({
  get: (name: string) => map[name.toLowerCase()] ?? null,
});

describe("parseRetryDelayMs", () => {
  it("Retry-After 헤더를 초 단위로 읽는다", () => {
    expect(parseRetryDelayMs("", headers({ "retry-after": "12" }))).toBe(12_000);
  });

  it("google.rpc.RetryInfo의 retryDelay를 읽는다", () => {
    const body = '{"error":{"details":[{"retryDelay":"9.4s"}]}}';
    expect(parseRetryDelayMs(body)).toBe(9_400);
  });

  it("사람이 읽는 메시지에서도 뽑아낸다", () => {
    // 실측에서 Gemini가 이 형식으로 알려줬다.
    expect(parseRetryDelayMs("Please retry in 9.414350787s.")).toBeCloseTo(9414, -1);
  });

  it("헤더를 구조화된 값보다 우선한다", () => {
    expect(
      parseRetryDelayMs('{"retryDelay":"30s"}', headers({ "retry-after": "5" })),
    ).toBe(5_000);
  });

  it("힌트가 없으면 undefined다", () => {
    expect(parseRetryDelayMs("그냥 오류 문자열")).toBeUndefined();
    expect(parseRetryDelayMs("")).toBeUndefined();
  });

  it("터무니없이 긴 대기 요구는 상한으로 자른다", () => {
    // 서버가 시키는 대로 한 시간을 기다리면 CI가 죽는다.
    expect(parseRetryDelayMs('{"retryDelay":"3600s"}')).toBe(MAX_RETRY_WAIT_MS);
  });

  it("잘못된 헤더 값은 무시하고 본문을 본다", () => {
    expect(
      parseRetryDelayMs('{"retryDelay":"7s"}', headers({ "retry-after": "곧" })),
    ).toBe(7_000);
  });
});

describe("waitMs", () => {
  it("힌트가 없으면 지수 백오프를 쓴다", () => {
    expect(waitMs(1, undefined)).toBe(backoffMs(1));
    expect(waitMs(3, undefined)).toBe(4000);
  });

  it("서버 힌트가 백오프보다 길면 힌트를 따른다", () => {
    // 이걸 안 해서 실측에서 5건을 통째로 날렸다.
    // 서버가 9.4초를 요구했는데 백오프 상한이 8초였다.
    expect(waitMs(3, 9_400)).toBe(9_900);
  });

  it("힌트에 여유를 더해 경계에서 다시 429가 나지 않게 한다", () => {
    expect(waitMs(1, 5_000)).toBe(5_500);
  });

  it("힌트가 백오프보다 짧으면 백오프를 유지한다", () => {
    expect(waitMs(4, 100)).toBe(8000);
  });

  it("상한을 넘지 않는다", () => {
    expect(waitMs(1, 999_000)).toBe(MAX_RETRY_WAIT_MS);
  });
});
