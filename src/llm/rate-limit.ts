import type { GenerateRequest, GenerateResponse, LLMProvider } from "./provider.js";

/**
 * 호출 사이에 최소 간격을 강제한다.
 *
 * 5주차 실측에서 폐기의 전부가 429였다. 맞고 나서 기다리는 것보다
 * 처음부터 안 맞는 게 싸다 — 429는 재시도 비용에 더해 그 시도 자체를
 * 통째로 날린다.
 */
export class RateLimiter {
  private nextAllowedAt = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  /** 다음 호출이 허용될 때까지 기다린다. */
  async acquire(): Promise<number> {
    const current = this.now();
    const waitMs = Math.max(0, this.nextAllowedAt - current);

    if (waitMs > 0) await this.sleep(waitMs);

    // 실제 대기 후 시각이 아니라 계산된 시각을 기준으로 잡아야
    // 호출이 몰릴 때 간격이 조금씩 밀리지 않는다.
    this.nextAllowedAt = Math.max(current, this.nextAllowedAt) + this.minIntervalMs;
    return waitMs;
  }
}

/** 분당 요청 수를 최소 간격으로 바꾼다. */
export function intervalForRpm(requestsPerMinute: number): number {
  if (requestsPerMinute <= 0) return 0;
  // 경계에 딱 맞추면 서버 쪽 창(window)이 조금만 어긋나도 429가 난다. 10% 여유.
  // 60_000/rpm * 1.1 로 계산하면 부동소수 오차로 3300 대신 3301이 나온다.
  return Math.ceil((60_000 * 11) / (requestsPerMinute * 10));
}

/**
 * provider를 감싸 호출 간격을 지키게 한다.
 * provider 구현마다 페이싱을 복제하지 않기 위해 데코레이터로 둔다.
 */
export function withRateLimit(
  provider: LLMProvider,
  limiter: RateLimiter,
  onWait?: (waitedMs: number) => void,
): LLMProvider {
  return {
    name: provider.name,
    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      const waited = await limiter.acquire();
      if (waited > 0) onWait?.(waited);
      return provider.generate(req);
    },
  };
}

/**
 * 환경변수로 페이싱을 정한다.
 *   MH_RPM=20            분당 요청 수 (기본값)
 *   MH_MIN_INTERVAL_MS   직접 지정. 지정 시 MH_RPM 무시
 */
export function limiterFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimiter {
  const explicit = Number(env["MH_MIN_INTERVAL_MS"]);
  if (Number.isFinite(explicit) && explicit >= 0) return new RateLimiter(explicit);

  const rpm = Number(env["MH_RPM"]);
  // 무료 티어 실측 한도가 분당 20이었다.
  const effective = Number.isFinite(rpm) && rpm > 0 ? rpm : 20;
  return new RateLimiter(intervalForRpm(effective));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
