/** PR diff에서 변경이 감지된 파일 하나. */
export type ChangedFile = {
  /** repo 루트 기준 상대 경로 */
  path: string;
  /** 변경된 새 파일 기준 줄 번호 (1-based, 오름차순, 중복 없음) */
  changedLines: number[];
};

/** 뮤테이션을 걸 범위. Stryker의 `path:start-end` 인자로 직렬화된다. */
export type MutateRange = {
  path: string;
  start: number;
  end: number;
  /** 이 범위를 만들어낸 선언 이름 (로그·리포트용) */
  symbol: string;
};

/** Stryker 리포트에서 읽어낸 뮤턴트 하나. */
export type Mutant = {
  id: string;
  path: string;
  mutatorName: string;
  status: string;
  line: number;
  column: number;
  endLine: number;
  /** 뮤턴트가 원본 코드를 대체한 내용 */
  replacement: string;
  /** 원본 소스에서 해당 위치의 코드 */
  original: string;
};

/** 생존 뮤턴트를 필터링한 결과. 버린 것도 이유와 함께 남긴다. */
export type MutantScanResult = {
  /** LLM에게 넘길 후보 */
  candidates: Mutant[];
  /** 필터로 걸러낸 것들 — 침묵하지 않고 이유를 기록한다 */
  filtered: { mutant: Mutant; reason: FilterReason }[];
  stats: {
    total: number;
    killed: number;
    survived: number;
    noCoverage: number;
    timeout: number;
    mutationScore: number;
  };
};

export type FilterReason =
  /** 프롬프트·상수 문자열 변이 — 테스트로 고정하면 유해하다 */
  | "noise-string-literal"
  /** 과거에 킬 실패가 누적된 등가 뮤턴트 의심 */
  | "suspected-equivalent"
  /** 커버리지가 아예 없어 뮤테이션 이전에 테스트부터 필요한 지점 */
  | "no-coverage";
