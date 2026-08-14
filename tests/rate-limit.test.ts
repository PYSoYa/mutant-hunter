import { describe, expect, it } from "vitest";
import {
  intervalForRpm,
  limiterFromEnv,
  RateLimiter,
  withRateLimit,
} from "../src/llm/rate-limit.js";
import { MockProvider } from "../src/llm/provider.js";

/** 실제 시간을 쓰지 않는 시계. 테스트가 느려지거나 흔들리면 안 된다. */
function fakeClock(start = 0) {
  let now = start;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    slept,
  };
}

describe("RateLimiter", () => {
  it("첫 호출은 기다리지 않는다", async () => {
    const c = fakeClock();
    const limiter = new RateLimiter(1000, c.now, c.sleep);
    expect(await limiter.acquire()).toBe(0);
  });

  it("연속 호출 사이에 최소 간격을 강제한다", async () => {
    const c = fakeClock();
    const limiter = new RateLimiter(1000, c.now, c.sleep);
    await limiter.acquire();
    expect(await limiter.acquire()).toBe(1000);
    expect(await limiter.acquire()).toBe(1000);
  });

  it("이미 충분히 지났으면 기다리지 않는다", async () => {
    const c = fakeClock();
    const limiter = new RateLimiter(1000, c.now, c.sleep);
    await limiter.acquire();
    c.advance(5000);
    expect(await limiter.acquire()).toBe(0);
  });

  it("긴 공백 뒤에도 간격이 밀리지 않는다", async () => {
    // nextAllowedAt을 과거에 붙들어두면 공백 이후 호출이 몰린다.
    const c = fakeClock();
    const limiter = new RateLimiter(1000, c.now, c.sleep);
    await limiter.acquire();
    c.advance(10_000);
    await limiter.acquire();
    expect(await limiter.acquire()).toBe(1000);
  });

  it("간격이 0이면 항상 통과시킨다", async () => {
    const c = fakeClock();
    const limiter = new RateLimiter(0, c.now, c.sleep);
    await limiter.acquire();
    expect(await limiter.acquire()).toBe(0);
  });
});

describe("intervalForRpm", () => {
  it("분당 요청 수를 간격으로 바꾼다", () => {
    // 경계에 딱 맞추면 서버 창이 조금만 어긋나도 429가 난다. 10% 여유.
    expect(intervalForRpm(20)).toBe(3300);
    expect(intervalForRpm(60)).toBe(1100);
  });

  it("0 이하면 제한하지 않는다", () => {
    expect(intervalForRpm(0)).toBe(0);
    expect(intervalForRpm(-5)).toBe(0);
  });
});

describe("limiterFromEnv", () => {
  it("MH_MIN_INTERVAL_MS를 그대로 쓴다", async () => {
    const limiter = limiterFromEnv({ MH_MIN_INTERVAL_MS: "0" });
    await limiter.acquire();
    expect(await limiter.acquire()).toBe(0);
  });

  it("MH_MIN_INTERVAL_MS가 MH_RPM보다 우선한다", async () => {
    const limiter = limiterFromEnv({ MH_MIN_INTERVAL_MS: "0", MH_RPM: "1" });
    await limiter.acquire();
    expect(await limiter.acquire()).toBe(0);
  });

  it("잘못된 값은 무시하고 기본값으로 간다", () => {
    expect(() => limiterFromEnv({ MH_RPM: "abc" })).not.toThrow();
  });
});

describe("withRateLimit", () => {
  it("provider 이름을 유지한다", () => {
    const wrapped = withRateLimit(new MockProvider(["x"]), new RateLimiter(0));
    expect(wrapped.name).toBe("mock");
  });

  it("응답을 그대로 통과시킨다", async () => {
    const wrapped = withRateLimit(new MockProvider(["결과"]), new RateLimiter(0));
    expect((await wrapped.generate({ system: "", user: "" })).text).toBe("결과");
  });

  it("대기가 발생하면 콜백으로 알린다", async () => {
    const c = fakeClock();
    const waits: number[] = [];
    const wrapped = withRateLimit(
      new MockProvider(["a", "b"]),
      new RateLimiter(500, c.now, c.sleep),
      (ms) => waits.push(ms),
    );
    await wrapped.generate({ system: "", user: "" });
    await wrapped.generate({ system: "", user: "" });
    expect(waits).toEqual([500]);
  });
});
