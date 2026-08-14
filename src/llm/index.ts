import { geminiFromEnv } from "./gemini.js";
import { openAICompatFromEnv } from "./openai-compat.js";
import type { LLMProvider } from "./provider.js";

/**
 * 환경변수에서 provider를 고른다.
 *
 * OpenAI 호환 설정(MH_API_KEY)을 먼저 본다. 명시적으로 지정한 쪽이
 * 우선이어야 "왜 Gemini가 불렸지" 같은 혼란이 없다.
 */
export function providerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LLMProvider | undefined {
  return openAICompatFromEnv(env) ?? geminiFromEnv(env);
}

export { geminiFromEnv, openAICompatFromEnv };
export type { LLMProvider };
