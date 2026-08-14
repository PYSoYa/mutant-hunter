import { LLMError, type GenerateRequest, type GenerateResponse, type LLMProvider } from "./provider.js";
import { DEFAULT_TIMEOUT_MS, parseRetryDelayMs, waitMs } from "./gemini.js";
import type { RateLimiter } from "./rate-limit.js";

/**
 * OpenAI 호환 `/chat/completions` provider.
 *
 * DeepSeek, Groq, OpenRouter, Together 등이 같은 스펙을 쓰므로 baseURL과
 * 모델 이름만 바꾸면 그대로 붙는다. 어느 쪽이 무료 티어를 주는지, 어느 쪽이
 * 더 싼지는 시기마다 바뀌므로 코드가 아니라 설정으로 고르게 둔다.
 */
export type OpenAICompatOptions = {
  apiKey: string;
  baseURL: string;
  model: string;
  maxRetries?: number;
  /** 단일 요청 타임아웃. 없으면 응답이 안 와도 영원히 매달린다. */
  timeoutMs?: number;
  /** HTTP 요청 단위 페이싱. 재시도가 제한을 우회하지 않도록 매 시도마다 건다. */
  rateLimiter?: RateLimiter;
  /** 로그·리포트에 표시할 이름 */
  label?: string;
};

export const PRESETS = {
  deepseek: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
  },
  mistral: {
    baseURL: "https://api.mistral.ai/v1",
    // 코드 전용 모델(codestral-latest)도 같은 엔드포인트에서 쓸 수 있다.
    // 어느 쪽이 뮤턴트를 잘 죽이는지는 평가 하네스로 재서 정한다.
    model: "mistral-small-latest",
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-chat",
  },
} as const;

export type PresetName = keyof typeof PRESETS;

export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  private readonly maxRetries: number;

  constructor(private readonly opts: OpenAICompatOptions) {
    this.name = opts.label ?? "openai-compat";
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const body = {
      model: this.opts.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      temperature: req.temperature ?? 0.2,
    };

    let lastError = "";
    let hintedDelayMs: number | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(waitMs(attempt, hintedDelayMs));
      await this.opts.rateLimiter?.acquire();

      let res: Response;
      try {
        res = await fetch(`${this.opts.baseURL}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.opts.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }

      if (res.ok) {
        const json = (await res.json()) as ChatCompletion;
        const text = json.choices?.[0]?.message?.content;
        if (!text) {
          throw new LLMError(
            `빈 응답 (finish_reason=${json.choices?.[0]?.finish_reason ?? "unknown"})`,
          );
        }
        return { text, model: json.model ?? this.opts.model };
      }

      const bodyText = await res.text().catch(() => "");
      lastError = `${res.status} ${bodyText}`.slice(0, 500);
      // 대부분의 OpenAI 호환 서비스는 Retry-After 헤더로 대기 시간을 알려준다.
      hintedDelayMs = parseRetryDelayMs(bodyText, res.headers);

      // 429는 쿼터라 기다리면 풀린다. 나머지 4xx는 재시도해도 그대로다.
      if (res.status !== 429 && res.status < 500) {
        throw new LLMError(`${this.name} 호출 실패: ${lastError}`, res.status);
      }
    }

    throw new LLMError(`재시도 ${this.maxRetries}회 후에도 실패: ${lastError}`);
  }
}

/**
 * 환경변수로 provider를 고른다.
 *
 *   MH_PROVIDER=deepseek|groq|openrouter  (프리셋)
 *   MH_API_KEY=...                        (필수)
 *   MH_MODEL=...                          (선택, 프리셋 기본값 대체)
 *   MH_BASE_URL=...                       (선택, 프리셋 없이 직접 지정)
 */
export function openAICompatFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  rateLimiter?: RateLimiter,
): OpenAICompatProvider | undefined {
  const apiKey = env["MH_API_KEY"];
  if (!apiKey) return undefined;

  const presetName = env["MH_PROVIDER"] as PresetName | undefined;
  const preset = presetName ? PRESETS[presetName] : undefined;

  const baseURL = env["MH_BASE_URL"] ?? preset?.baseURL;
  const model = env["MH_MODEL"] ?? preset?.model;

  if (!baseURL || !model) return undefined;

  return new OpenAICompatProvider({
    apiKey,
    baseURL,
    model,
    rateLimiter,
    label: presetName ?? "openai-compat",
  });
}

type ChatCompletion = {
  model?: string;
  choices?: { message?: { content?: string }; finish_reason?: string }[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
