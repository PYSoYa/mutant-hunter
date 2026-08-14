import { describe, expect, it } from "vitest";
import { openAICompatFromEnv, PRESETS } from "../src/llm/openai-compat.js";
import { geminiFromEnv } from "../src/llm/gemini.js";
import { providerFromEnv } from "../src/llm/index.js";

describe("PRESETS", () => {
  it("무료 티어를 주는 서비스들을 프리셋으로 갖는다", () => {
    expect(Object.keys(PRESETS).sort()).toEqual([
      "deepseek",
      "groq",
      "mistral",
      "openrouter",
    ]);
  });

  it("모든 프리셋이 baseURL과 model을 갖는다", () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      expect(preset.baseURL, name).toMatch(/^https:\/\//);
      expect(preset.model, name).toBeTruthy();
    }
  });
});

describe("openAICompatFromEnv", () => {
  it("키가 없으면 만들지 않는다", () => {
    expect(openAICompatFromEnv({})).toBeUndefined();
  });

  it("프리셋 이름으로 provider를 만든다", () => {
    const p = openAICompatFromEnv({ MH_API_KEY: "k", MH_PROVIDER: "mistral" });
    expect(p?.name).toBe("mistral");
  });

  it("프리셋 없이 baseURL과 model을 직접 줘도 된다", () => {
    const p = openAICompatFromEnv({
      MH_API_KEY: "k",
      MH_BASE_URL: "https://example.com/v1",
      MH_MODEL: "custom",
    });
    expect(p?.name).toBe("openai-compat");
  });

  it("프리셋도 baseURL도 없으면 만들지 않는다", () => {
    // 키만 있고 어디로 보낼지 모르면 조용히 엉뚱한 곳으로 가면 안 된다.
    expect(openAICompatFromEnv({ MH_API_KEY: "k" })).toBeUndefined();
  });

  it("알 수 없는 프리셋 이름은 만들지 않는다", () => {
    expect(
      openAICompatFromEnv({ MH_API_KEY: "k", MH_PROVIDER: "존재하지않음" }),
    ).toBeUndefined();
  });
});

describe("geminiFromEnv", () => {
  it("키가 없으면 만들지 않는다", () => {
    expect(geminiFromEnv({})).toBeUndefined();
  });

  it("키가 있으면 만든다", () => {
    expect(geminiFromEnv({ GEMINI_API_KEY: "k" })?.name).toBe("gemini");
  });
});

describe("providerFromEnv", () => {
  it("OpenAI 호환 설정을 Gemini보다 우선한다", () => {
    // 명시적으로 지정한 쪽이 이겨야 "왜 Gemini가 불렸지" 같은 혼란이 없다.
    const p = providerFromEnv({
      MH_API_KEY: "k",
      MH_PROVIDER: "groq",
      GEMINI_API_KEY: "g",
    });
    expect(p?.name).toBe("groq");
  });

  it("OpenAI 호환 설정이 없으면 Gemini로 떨어진다", () => {
    expect(providerFromEnv({ GEMINI_API_KEY: "g" })?.name).toBe("gemini");
  });

  it("아무 키도 없으면 undefined다", () => {
    expect(providerFromEnv({})).toBeUndefined();
  });
});
