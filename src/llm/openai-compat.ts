import { LLMError, type GenerateRequest, type GenerateResponse, type LLMProvider } from "./provider.js";
import { backoffMs } from "./gemini.js";

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
  /** 로그·리포트에 표시할 이름 */
  label?: string;
};

export const PRESETS = {
  deepseek: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
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

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt));

      const res = await fetch(`${this.opts.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
      });

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

      lastError = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 500);

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
