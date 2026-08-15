# MutantHunter

> 테스트가 못 잡는 구멍을 찾아 테스트를 생성하고,
> **그 테스트가 실제로 버그를 잡는지 스스로 증명한 뒤에만** PR에 제안한다.

```
PR diff → 변경된 코드에 뮤테이션 주입
        → 살아남은 뮤턴트 = "아무 테스트도 안 지키는 지점"
        → LLM이 그 뮤턴트를 죽이는 테스트 생성
        → 4개 게이트로 검증
             ├ 원본 코드에서 통과하나?
             ├ 뮤턴트 코드에서 실패하나?   ← 이게 핵심 관문
             ├ 3회 반복해도 안정적인가?
             └ 기존 스위트를 깨뜨리지 않나?
        → 통과한 것만 코멘트
```

핵심 설계는 문제를 바꾼 데 있다. *"이 diff의 테스트를 써줘"*(정답 없음, 검증 불가) 대신
*"이 뮤턴트를 죽이는 테스트를 써줘"*(정답 명확, 실행으로 검증 가능)로 바꾼다.

## 30초 배경 — 뮤테이션 테스팅

커버리지는 "그 줄이 **실행됐는가**"만 본다. "그 줄이 틀렸을 때 **누가 알아채는가**"는 묻지 않는다.
뮤테이션 테스팅은 코드를 일부러 망가뜨려서 그 질문에 답한다.

```ts
// 원본
if (score > 90) return "high";

// 뮤턴트: 조건을 뒤집는다
if (false) return "high";
```

테스트를 다시 돌린다.

- **하나라도 실패했다** → 뮤턴트가 *죽었다*. 테스트가 이 코드를 지키고 있다. ✅
- **전부 통과했다** → 뮤턴트가 *살아남았다*. 이 줄은 틀려도 아무도 모른다. ⚠️

커버리지 100%여도 뮤테이션 스코어가 50%인 경우는 흔하다. 줄을 실행만 하고
결과를 단언하지 않는 테스트가 그렇다. **살아남은 뮤턴트가 곧 진짜 테스트 갭이고,
MutantHunter는 그 목록을 테스트 생성의 명세로 쓴다.**

## 왜 이 게이트가 필요한가 — 스파이크가 스스로 증명한 사례

1주차 스파이크에서 `tryParse`의 오류 반환을 겨냥한 테스트를 작성했다. 단언을
`/Failed to parse balanced JSON block: \S+/`로 느슨하게 쓰는 바람에, 뮤턴트가 만들어낸
`"...block: undefined"` 문자열까지 매칭되어 **통과해 버렸다.**

이 테스트는 원본 코드에서 멀쩡히 통과했고, 코드 리뷰로는 걸러내기 어렵다.
오직 **"뮤턴트에서 실패하는가"** 게이트만이 이걸 잡아냈다.

전체 결과는 [docs/spike/week1-report.md](docs/spike/week1-report.md).

## 실제로 도는 모습

[PR #11](https://github.com/PYSoYa/mutant-hunter/pull/11)에서 이 도구가 **자기 자신의 PR에 단 코멘트**다.
GitHub Actions에서 1분 20초에 완주했다.

> ## 🧬 MutantHunter
>
> 변경된 코드 7개 파일에서 **테스트가 지키지 않는 지점 46곳**을 찾았습니다.
>
> 그중 **1곳**은 구멍을 막는 테스트를 만들어 실제로 결함을 잡는지 확인했습니다.
>
> ### 제안
>
> #### `src/equivalents.ts`
>
> **L34** — 이 조건이 **항상 참**이 되어도 **어떤 테스트도 실패하지 않습니다.**
>
> ```ts
> typeof k === "string"
> ```
>
> <details><summary>이 구멍을 막는 테스트 — 18줄 (검증 완료)</summary>
>
> ```ts
> it("배열에 비문자열 원소가 섞여 있어도 문자열만 읽는다", () => {
>   const p = tmpPath();
>   // 숫자, 객체, null이 섞인 배열
>   writeFileSync(p, JSON.stringify(["key1", 123, { a: 1 }, null]));
>   // 뮤턴트(항상 true)는 문자열이 아닌 모든 원소를 무시하지 못한다.
>   expect(loadRecord(p)).toEqual({ key1: 2 });
> });
> ```
>
> </details>

이 지적은 정확했다. 30분 전에 손으로 쓴 테스트는 `["key1"]`만 넣어서
그 분기를 검증하지 못하고 있었다.

## 무엇이 증명됐고 무엇이 안 됐나

| | |
|---|---|
| **게이트가 실제로 걸러낸다** | 뮤턴트 102개 실행에서 생성 테스트 **157건**을 폐기. `kills-mutant` 53건은 원본에서 멀쩡히 통과하지만 결함을 못 잡는 테스트였다 |
| **대상이 프롬프트보다 크다** | 같은 도구가 88% repo에서 0/3, 0% repo에서 6/7. 표본 간 3배 차이가 프롬프트 변경(±1%p)을 압도한다 |
| **프롬프트 튜닝은 효과 미입증** | 세 번 시도, 전부 잡음 범위. 같은 조건 4회 반복에서 채택 수가 5~7로 흔들린다 |
| **잘 테스트된 repo에서는 침묵한다** | 그게 올바른 동작이다. 증명 못 한 것을 제안하면 신뢰를 한 번에 잃는다 |

측정 과정과 그때마다 틀린 것은 [docs/findings.md](docs/findings.md)에 남겼다.

## 현재 상태

**3주차 — 생성·검증 루프.**

| 모듈 | 역할 |
|---|---|
| `src/diff.ts` | `git diff --unified=0` → 변경 파일·줄 번호 |
| `src/targets.ts` | 변경된 줄 → 감싸는 선언 범위로 확장(ts-morph) → 병합 |
| `src/stryker.ts` | 범위 한정 Stryker 설정 생성·실행 |
| `src/mutants.ts` | 리포트 → 생존 뮤턴트 후보 + 필터 사유 |
| `src/prompt.ts` | 뮤턴트 → 프롬프트 조립, 응답에서 코드 추출 |
| `src/apply.ts` | 소스에 뮤턴트 적용/복원 (게이트 2의 기반) |
| `src/verify.ts` | 4개 게이트 |
| `src/generate.ts` | 생성 → 검증 → 재시도 오케스트레이션 |
| `src/cli.ts` | 파이프라인 배선 |

## 대상 repo에 무엇을 심어야 하나

**워크플로우 YAML 한 장.** 그 외에는 아무것도 커밋하지 않는다.

```yaml
# .github/workflows/mutant-hunter.yml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0        # base...head diff 계산에 전체 이력이 필요하다
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: npm ci
- uses: PYSoYa/mutant-hunter@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
  env:
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

전체 예시는 [docs/example-workflow.yml](docs/example-workflow.yml).

| 대상 repo에 커밋되는 것 | |
|---|---|
| 워크플로우 YAML | ✅ 필요 |
| Stryker devDependency | ❌ 런타임 설치 |
| `stryker.config.json` | ❌ 실행 시 생성 |
| 뮤테이션용 테스트 설정 | ❌ 불필요 (대상의 기본 설정을 쓴다) |

### 왜 런타임 설치인가 — 실측으로 확인한 제약

Stryker와 러너 플러그인은 **대상 repo의 `node_modules`에서 해석돼야 한다.**
뮤테이션을 실행하는 vitest/jest 인스턴스가 대상 repo의 것이어야 하기 때문이다.
MutantHunter가 자기 `node_modules`의 Stryker로 대상을 돌려봤더니, 우리 vitest가
대상의 vite 설정을 읽으려다 실패했다.

그래서 실행 시점에 `npm install --no-save`로 넣는다. `package.json`과 lock 파일은
그대로 남는다 (실측 확인). 설치에 4.6초, 이후 실행은 3초.

```
대상 초기화 (stryker 없음, package.json 언급 0개)
  → 런타임 설치 → 뮤테이션 실행 → 결과   총 6.3초
실행 후 package.json의 stryker 언급: 0
```

### npx 자동 다운로드에 기대지 않는다

초기 구현은 `npx stryker`를 그냥 호출했고, 대상에 Stryker가 없어도 "동작했다."
npx가 **레지스트리에서 조용히 내려받고 있었기 때문**이다. 네트워크가 막힌 CI에서는
바로 깨졌을 숨은 의존성이라, 지금은 `npx --no-install`로 호출해 조용한 폴백을 차단하고
설치는 `ensureStryker`가 명시적으로 책임진다.

## 사용법

### 요구사항

| | |
|---|---|
| Node.js | 20 이상 |
| 대상 언어 | TypeScript / JavaScript |
| 대상 테스트 러너 | vitest 또는 jest (`package.json`에서 자동 감지) |
| jest 사용 시 | ts-jest 조합까지 실측 확인 |
| 대상 repo 상태 | 테스트가 **전부 통과하는** 상태여야 한다 |

마지막 조건이 중요하다. 이미 깨진 테스트가 있으면 "뮤턴트 때문에 실패한 것"과
"원래 실패하던 것"을 구분할 수 없어 판정이 무의미해진다.

### 설치

```bash
git clone https://github.com/PYSoYa/mutant-hunter.git
cd mutant-hunter
npm install
```

### 실행

```bash
# PR diff 기준 — base와 head 사이의 변경만 대상으로 삼는다
npm run scan -- --repo /path/to/target --base main --head HEAD

# 저장된 diff 파일 기준
npm run scan -- --repo /path/to/target --diff-file changes.diff
```

| 옵션 | 필수 | 설명 |
|---|---|---|
| `--repo <경로>` | ✅ | 스캔할 대상 repo 루트 |
| `--base <ref>` | | 비교 기준 (기본값 `HEAD~1`) |
| `--head <ref>` | | 비교 대상 (기본값 `HEAD`) |
| `--diff-file <경로>` | | diff를 파일에서 읽는다. 지정 시 `--base`/`--head` 무시 |
| `--runner-config <경로>` | | 뮤테이션 전용 테스트 설정. 대상 repo 기준 상대 경로 |
| `--concurrency <n>` | | 동시 실행 워커 수 (기본값 4) |
| `--generate` | | 후보 뮤턴트에 대해 테스트를 생성·검증한다 |
| `--max-mutants <n>` | | 한 번에 다룰 뮤턴트 수 (기본값 5) |
| `--max-attempts <n>` | | 뮤턴트당 재시도 상한 (기본값 2) |

`--generate`는 `GEMINI_API_KEY` 환경변수를 요구한다. `GEMINI_MODEL`로 모델을
바꿀 수 있다 (기본값 `gemini-2.0-flash`).

`--max-mutants` 기본값이 5인 이유는 PR 코멘트가 5개를 넘으면 사람이 전부
무시하기 때문이다. `--max-attempts`가 2인 이유는 등가 뮤턴트가 원리적으로
킬 불가능해서 무한 재시도가 쿼터만 태우기 때문이다.

`--runner-config`는 **필수가 아니라 순수 최적화**다. 지정하지 않으면 대상 repo의
기본 테스트 설정을 쓰고 결과는 동일하다. 같은 대상에서 실측했을 때 6.3초 대 11초로,
결과(뮤테이션 스코어 63.16%, 후보 12개)는 한 글자도 다르지 않았다.

### 출력

```
대상 범위 1개:
  lib/llm/jsonGuard.ts:15-60  (extractJson)

Stryker 런타임 설치 (--no-save): @stryker-mutator/core, @stryker-mutator/vitest-runner

뮤테이션 스코어 63.16%  (전체 57 / 킬 35 / 생존 17 / 커버리지없음 4 / 타임아웃 1)
후보 뮤턴트 12개
  제외 no-coverage: 4개
  제외 noise-string-literal: 5개

  [ConditionalExpression] lib/llm/jsonGuard.ts:38
    원본: ch === '"'
    변이: false
```

`후보 뮤턴트` 각각이 "이 코드를 이렇게 바꿔도 아무 테스트도 실패하지 않는다"는 뜻이다.
전체 결과는 대상 repo의 `.mutant-hunter/candidates.json`에 쓴다.

대상 repo에는 `.mutant-hunter/` 작업 디렉터리만 생기고 기존 설정은 건드리지 않는다.
`.gitignore`에 추가해 두면 깔끔하다.

## LLM provider

무료 티어를 주는 곳이 시기마다 바뀌므로 코드가 아니라 환경변수로 고른다.

```bash
# Gemini (Google AI Studio 무료 티어)
GEMINI_API_KEY=...            # GEMINI_MODEL 로 모델 변경 가능

# OpenAI 호환 API — DeepSeek / Groq / Mistral / OpenRouter
MH_PROVIDER=groq              # deepseek | groq | mistral | openrouter
MH_API_KEY=...
MH_MODEL=...                  # 선택, 프리셋 기본값 대체
MH_BASE_URL=...               # 선택, 프리셋 없이 직접 지정

# 호출 페이싱 — 429를 맞고 기다리는 것보다 처음부터 안 맞는 게 싸다
MH_RPM=20                     # 분당 요청 수 (기본값)
MH_MIN_INTERVAL_MS=...        # 직접 지정. 지정 시 MH_RPM 무시
```

기본 모델은 **별칭**을 쓴다(`gemini-flash-latest`). 버전을 코드에 박아두면
언젠가 반드시 썩는다 — 실제로 `gemini-2.0-flash`를 하드코딩했다가 단종으로
404가 났고, 확인해 보니 `gemini-2.5-flash`도 이미 죽어 있었다.

`MH_API_KEY`가 있으면 그쪽을 우선한다. 명시적으로 지정한 쪽이 이겨야
"왜 Gemini가 불렸지" 같은 혼란이 없다.

## 평가 하네스

프롬프트나 필터를 바꿀 때 좋아졌는지를 숫자로 판정한다.

```bash
npx tsx scripts/eval.ts --corpus eval/corpus.json --label baseline
npx tsx scripts/eval.ts --corpus eval/corpus-quick.json --label after-v2 \
  --generate --compare docs/eval/baseline.json
```

회귀가 감지되면 종료 코드가 0이 아니다. 판정 규칙 중 중요한 것:

- **뮤테이션 스코어는 뮤턴트 수로 가중한다.** 표본별 단순 평균이면 뮤턴트 3개짜리와
  500개짜리가 같은 무게를 갖는다
- **표본이 사라지면 회귀로 본다.** 어려운 표본을 빼면 점수는 언제든 오른다
- **git 표본은 커밋 SHA만 허용한다.** 브랜치를 쓰면 표본이 움직여 비교가 무의미해진다
- **뮤테이션 없이 끝난 표본을 구분해 표시한다.** "0%"가 결과처럼 보이면 안 된다

## 개발

```bash
npm test              # 자체 테스트
npm run typecheck     # 타입 검사
npm run build:action  # 액션 번들 (dist/index.cjs)
```

`dist/index.cjs`는 커밋한다 — 대상 repo가 이 파일을 직접 실행한다.
CI가 번들과 소스의 어긋남을 검사하므로, 소스를 고쳤으면 다시 빌드해 커밋해야 한다.

## 측정 대시보드

```bash
npm run dashboard    # docs/dashboard.html 생성 (브라우저로 열면 됨)
```

평가 실행들을 **표본 크기와 provider별 코호트로 나눠** 채택률 추이를 그린다.
24개 실행과 102개 실행을 한 줄에 그리면 분해능이 다른 숫자를 나란히 놓게 되기
때문이다 — 24개에서 뮤턴트 1건은 4.17%p, 102개에서는 0.98%p다.

**차트에 잡음 폭을 함께 그린다.** 채택률만 그리면 흔들림을 효과로 읽게 되고,
실제로 그 실수를 했다. 회색 띠 안의 변화는 효과라고 주장할 수 없다.
반복 측정이 3회 미만인 코호트는 흔들림을 말하지 않고 최소 눈금만 표시한다.

초기 실행들의 눈금이 ±25%p, ±50%p로 찍히는 것도 그대로 남겨뒀다.
그때 숫자가 왜 무의미했는지가 한눈에 보인다.

## 데모 재현

```bash
# 게이트가 좋은 테스트와 나쁜 테스트를 가르는 것을 눈으로 확인
npx tsx scripts/demo-gates.ts --repo <대상> --mutant-id <id>

# PR 코멘트가 어떻게 렌더링되는지 확인
npx tsx scripts/preview-comment.ts <대상>

# 골든 코퍼스 평가
npx tsx scripts/eval.ts --corpus eval/corpus.json --label baseline
```

## 로드맵

10주 계획으로 시작해 전부 진행했다. 순서는 데이터가 가리키는 대로 두 번 바꿨다.

- [x] 1주차 — 기술 스파이크 (GO 판정: 킬 레이트 88%)
- [x] 2주차 — 결정론적 파이프라인 골격
- [x] 3주차 — LLM 생성·검증 루프 (4개 게이트)
- [x] 4주차 — GitHub Action 패키징
- [x] 5주차 — 평가 하네스 + 골든 코퍼스
- [x] 6주차 — 무료 티어 실측, 페이싱, 재현 가능한 코퍼스
- [x] 7주차 — PR 코멘트 UX
- [x] 잡음 폭 측정 (측정 장치의 분해능 확립)
- [x] 표본 102개 확대
- [x] 9주차 — 외부 OSS repo 검증
- [x] jest 경로 실측 검증
- [x] 액션 실제 GitHub Actions 실행 (PR 코멘트까지)
- [x] 10주차 — 문서·데모
- [x] 8주차 — 대시보드 (판정 가능한 숫자를 먼저 만든 뒤에 그렸다)

모든 항목을 진행했다.

**순서를 바꾼 두 번:**

6주차에 "프롬프트 개선"을 하려다 **실패 데이터가 없어 근거가 없다**는 것을 깨닫고
측정을 먼저 했다. 8주차 대시보드는 **판정할 수 없는 숫자를 예쁘게 그리게 된다**는
이유로 뒤로 미루고 잡음 폭 측정을 먼저 했다.

## 한계

- TypeScript/JavaScript + vitest/jest만 지원한다 (v1 의도적 범위)
- 등가 뮤턴트는 자동 판별이 불가능하다. 재시도 상한과 의심 목록 캐시로 대응한다
- **무료 티어 모델의 실제 킬 레이트는 아직 측정하지 않았다.** 1주차 스파이크의
  88%는 상위 모델 기준 상한선이다. 6주차 골든 코퍼스 측정 전까지 이 수치를
  일반화하면 안 된다
- **골든 코퍼스가 아직 재현 불가능하다.** 현재 표본이 로컬 경로에 의존한다.
  9주차에 git SHA로 고정한 OSS 표본으로 교체해야 한다
- **무료 티어 쿼터가 빡빡하다.** 실측에서 분당 20요청 한도에 걸렸다. 서버가 주는
  재시도 힌트를 따르도록 고쳤지만, 큰 PR에서는 여전히 병목이다
- 검증 게이트는 대상 repo의 소스를 잠시 수정한다. 예외 경로를 포함해 항상
  복원하지만, 실행 중 프로세스가 강제 종료되면 복원이 보장되지 않는다
