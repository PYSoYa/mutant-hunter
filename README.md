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

## 현재 상태

**2주차 — 결정론적 골격.** LLM은 아직 붙지 않았다.

| 모듈 | 역할 |
|---|---|
| `src/diff.ts` | `git diff --unified=0` → 변경 파일·줄 번호 |
| `src/targets.ts` | 변경된 줄 → 감싸는 선언 범위로 확장(ts-morph) → 병합 |
| `src/stryker.ts` | 범위 한정 Stryker 설정 생성·실행 |
| `src/mutants.ts` | 리포트 → 생존 뮤턴트 후보 + 필터 사유 |
| `src/cli.ts` | 파이프라인 배선 |

### 왜 "줄"이 아니라 "선언" 단위인가

변경된 줄만 뮤테이션하면 그 줄을 감싸는 분기 조건이 빠져 갭을 놓치고,
파일 전체를 뮤테이션하면 실행 시간이 폭발한다. 선언 단위가 그 중간이다.

실측: 2줄 변경 → `extractJson` 전체(46줄)로 확장 → 뮤턴트 57개.
파일 전체를 대상으로 했다면 109개였다. **48% 감소.**

### 필터링한 것은 침묵하지 않고 보고한다

1주차에서 생존 뮤턴트의 33%가 `StringLiteral`(대부분 LLM 프롬프트 텍스트)이었다.
프롬프트 문구를 테스트로 고정하는 건 유해하므로 LLM에 넘기기 전에 잘라내되,
**몇 개를 왜 버렸는지 항상 출력한다.** 조용한 절삭은 "다 훑었다"는 착시를 만든다.

| 필터 사유 | 의미 |
|---|---|
| `noise-string-literal` | 프롬프트·상수 문자열 변이 |
| `suspected-equivalent` | 원리적으로 킬 불가능한 등가 뮤턴트 |
| `no-coverage` | 테스트가 약한 게 아니라 아예 없는 지점 (다른 문제) |

## 대상 repo에 무엇을 심어야 하나

**워크플로우 YAML 한 장.** 그 외에는 아무것도 커밋하지 않는다.

```yaml
# .github/workflows/mutant-hunter.yml
- uses: yunseokpark/mutant-hunter@v1
  with:
    base: ${{ github.event.pull_request.base.sha }}
```

| 대상 repo에 커밋되는 것 | |
|---|---|
| 워크플로우 YAML | ✅ 필요 |
| Stryker devDependency | ❌ 런타임 설치 |
| `stryker.config.json` | ❌ 실행 시 생성 |
| 뮤테이션용 테스트 설정 | ❌ 실행 시 생성 (3주차) |

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

`--runner-config`는 전체 스위트 대신 빠른 부분집합만 돌리기 위한 것이다.
지정하지 않으면 대상 repo의 기본 테스트 설정을 쓴다. 자동 생성은 3주차 과제.

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

## 개발

```bash
npm test          # 자체 테스트
npm run typecheck # 타입 검사
```

## 로드맵

- [x] 1주차 — 기술 스파이크 (GO 판정: 킬 레이트 88%)
- [x] 2주차 — 결정론적 파이프라인 골격
- [ ] 3주차 — LLM 생성·검증 루프 (4개 게이트)
- [ ] 4주차 — GitHub Action 패키징
- [ ] 5주차 — 평가 하네스 + 골든 코퍼스
- [ ] 6주차 — 무료 티어 모델 실측 및 프롬프트 개선
- [ ] 7주차 — PR 코멘트 UX
- [ ] 8주차 — 대시보드
- [ ] 9주차 — 외부 OSS repo 검증
- [ ] 10주차 — 문서·데모

## 한계

- TypeScript/JavaScript + vitest/jest만 지원한다 (v1 의도적 범위)
- 등가 뮤턴트는 자동 판별이 불가능하다. 재시도 상한과 의심 목록 캐시로 대응한다
- 대상 repo에 뮤테이션 전용 테스트 설정이 필요하다. 자동 생성은 3주차 과제
