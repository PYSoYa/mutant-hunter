import { LLMError, type GenerateRequest, type GenerateResponse, type LLMProvider } from "./provider.js";

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
};

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

  constructor(private readonly opts: GeminiOptions) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const url = `${ENDPOINT}/${this.model}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      generationConfig: { temperature: req.temperature ?? 0.2 },
    };

    let lastError = "";

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt));

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.opts.apiKey,
        },
        body: JSON.stringify(body),
      });

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

      lastError = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 500);

      // 4xx는 재시도해도 그대로다. 단, 429는 쿼터라 기다리면 풀린다.
      if (res.status !== 429 && res.status < 500) {
        throw new LLMError(`Gemini 호출 실패: ${lastError}`, res.status);
      }
    }

    throw new LLMError(`재시도 ${this.maxRetries}회 후에도 실패: ${lastError}`);
  }
}

/** 환경변수에서 provider를 만든다. 키가 없으면 undefined. */
export function geminiFromEnv(env = process.env): GeminiProvider | undefined {
  const apiKey = env["GEMINI_API_KEY"];
  if (!apiKey) return undefined;
  return new GeminiProvider({ apiKey, model: env["GEMINI_MODEL"] });
}

export function backoffMs(attempt: number): number {
  // 1s, 2s, 4s … 무료 티어의 분당 제한을 넘기지 않을 만큼만 기다린다.
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
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
