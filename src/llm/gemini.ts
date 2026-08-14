import { LLMError, type GenerateRequest, type GenerateResponse, type LLMProvider } from "./provider.js";
import type { RateLimiter } from "./rate-limit.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * 기본 모델은 **별칭**으로 둔다.
 *
 * 처음엔 `gemini-2.0-flash`를 하드코딩했다가 404로 죽었다 — 모델이 단종된
 * 것이다. 버전을 코드에 박아두면 언젠가 반드시 같은 방식으로 썩는다.
 * 정확한 버전이 필요하면 GEMINI_MODEL로 고정할 수 있다.
 */
const DEFAULT_MODEL = "gemini-flash-latest";

export type GeminiOptions = {
  apiKey: string;
  model?: string;
  /** 429/5xx에 대한 재시도 횟수 */
  maxRetries?: number;
  /** 단일 요청 타임아웃. 없으면 응답이 안 와도 영원히 매달린다. */
  timeoutMs?: number;
  /**
   * HTTP 요청 단위 페이싱.
   *
   * generate() 바깥에서만 페이싱하면 재시도가 그 아래에서 일어나
   * 제한을 우회한다. 논리적 호출 1회가 요청 4회를 순식간에 쏘면
   * 분당 한도는 그대로 넘는다 — 실측에서 이것 때문에 429가 계속 났다.
   */
  rateLimiter?: RateLimiter;
};

/** 한 번의 생성 요청에 허용할 최대 시간. CI를 무한정 붙잡지 않는다. */
export const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Gemini REST API provider.
 *
 * 무료 티어는 분당 요청 수 제한이 빡빡하다. 429는 실패가 아니라 "기다리라"는
 * 신호이므로 지수 백오프로 재시도하고, 그래도 안 되면 시끄럽게 죽는다.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: GeminiOptions) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const url = `${ENDPOINT}/${this.model}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      generationConfig: { temperature: req.temperature ?? 0.2 },
    };

    let lastError = "";
    let hintedDelayMs: number | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(waitMs(attempt, hintedDelayMs));
      await this.opts.rateLimiter?.acquire();

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.opts.apiKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // 타임아웃·네트워크 오류는 재시도 가치가 있다.
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }

      if (res.ok) {
        const json = (await res.json()) as GeminiResponse;
        const text = json.candidates?.[0]?.content?.parts
          ?.map((p) => p.text ?? "")
          .join("");

        if (!text) {
          // 안전 필터에 걸리거나 빈 응답이 오는 경우가 있다. 재시도 가치가 없다.
          throw new LLMError(
            `빈 응답 (finishReason=${json.candidates?.[0]?.finishReason ?? "unknown"})`,
          );
        }
        return { text, model: this.model };
      }

      const bodyText = await res.text().catch(() => "");
      lastError = `${res.status} ${bodyText}`.slice(0, 500);
      hintedDelayMs = parseRetryDelayMs(bodyText, res.headers);

      // 4xx는 재시도해도 그대로다. 단, 429는 쿼터라 기다리면 풀린다.
      if (res.status !== 429 && res.status < 500) {
        throw new LLMError(`Gemini 호출 실패: ${lastError}`, res.status);
      }
    }

    throw new LLMError(`재시도 ${this.maxRetries}회 후에도 실패: ${lastError}`);
  }
}

/** 환경변수에서 provider를 만든다. 키가 없으면 undefined. */
export function geminiFromEnv(
  env = process.env,
  rateLimiter?: RateLimiter,
): GeminiProvider | undefined {
  const apiKey = env["GEMINI_API_KEY"];
  if (!apiKey) return undefined;
  return new GeminiProvider({ apiKey, model: env["GEMINI_MODEL"], rateLimiter });
}

export function backoffMs(attempt: number): number {
  // 1s, 2s, 4s … 서버가 대기 시간을 알려주지 않을 때의 기본값.
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

/** 서버가 요구한 대기 시간의 상한. 무한정 CI를 붙잡지 않는다. */
export const MAX_RETRY_WAIT_MS = 65_000;

/**
 * 429 응답에서 서버가 알려준 대기 시간을 뽑는다.
 *
 * 실측에서 Gemini는 "Please retry in 9.4s"라고 정확히 알려주는데,
 * 우리 지수 백오프 상한이 8초라 그 전에 포기해 5건을 통째로 날렸다.
 * 서버가 답을 주는데 짐작으로 기다릴 이유가 없다.
 */
export function parseRetryDelayMs(
  bodyText: string,
  headers?: { get(name: string): string | null },
): number | undefined {
  const header = headers?.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
    }
  }

  // google.rpc.RetryInfo — { "retryDelay": "9.4s" }
  const structured = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(bodyText);
  if (structured?.[1]) {
    return Math.min(Number(structured[1]) * 1000, MAX_RETRY_WAIT_MS);
  }

  // 사람이 읽는 메시지에만 담겨 오는 경우도 있다.
  const prose = /retry in ([\d.]+)\s*s/i.exec(bodyText);
  if (prose?.[1]) {
    return Math.min(Number(prose[1]) * 1000, MAX_RETRY_WAIT_MS);
  }

  return undefined;
}

/** 서버 힌트가 있으면 그걸 따르고, 없으면 지수 백오프. 항상 약간 더 기다린다. */
export function waitMs(
  attempt: number,
  hintedMs: number | undefined,
): number {
  const base = backoffMs(attempt);
  if (hintedMs === undefined) return base;
  // 힌트 시각에 정확히 맞춰 쏘면 경계에서 다시 429가 난다.
  return Math.min(Math.max(base, hintedMs + 500), MAX_RETRY_WAIT_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type GeminiResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
};
