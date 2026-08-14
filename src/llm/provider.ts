export type GenerateRequest = {
  system: string;
  user: string;
  /** 생성 다양성. 재시도 시 올려서 다른 접근을 유도한다. */
  temperature?: number;
};

export type GenerateResponse = {
  text: string;
  model: string;
};

export interface LLMProvider {
  readonly name: string;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
}

export class LLMError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "LLMError";
    this.status = status;
  }
}

/**
 * 미리 정해둔 응답을 순서대로 돌려주는 provider.
 * 게이트 로직을 API 키 없이 결정론적으로 검증하기 위한 것이다.
 */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  private index = 0;

  constructor(private readonly responses: string[]) {}

  generate(): Promise<GenerateResponse> {
    const text = this.responses[this.index] ?? "";
    this.index++;
    return Promise.resolve({ text, model: "mock" });
  }
}
