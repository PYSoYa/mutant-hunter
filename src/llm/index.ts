import { geminiFromEnv } from "./gemini.js";
import { openAICompatFromEnv } from "./openai-compat.js";
import type { LLMProvider } from "./provider.js";
import { limiterFromEnv } from "./rate-limit.js";

/**
 * 환경변수에서 provider를 고르고 페이싱을 입힌다.
 *
 * 페이싱은 provider 안쪽, **매 HTTP 시도마다** 건다. generate() 바깥에서만
 * 감싸면 재시도가 그 아래에서 일어나 제한을 우회한다 — 논리적 호출 1회가
 * 요청 4회를 순식간에 쏘면 분당 한도는 그대로 넘는다.
 *
 * OpenAI 호환 설정(MH_API_KEY)을 먼저 본다. 명시적으로 지정한 쪽이
 * 우선이어야 "왜 Gemini가 불렸지" 같은 혼란이 없다.
 */
export function providerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LLMProvider | undefined {
  const rateLimiter = limiterFromEnv(env);
  return (
    openAICompatFromEnv(env, rateLimiter) ?? geminiFromEnv(env, rateLimiter)
  );
}

export { geminiFromEnv, openAICompatFromEnv };
export type { LLMProvider };
