import type { Mutant } from "./types.js";

/**
 * 뮤턴트를 사람 말로 옮긴다.
 *
 * `- ch === '"'` / `+ false` 를 보고 왜 문제인지 알려면 뮤테이션 테스팅을
 * 알아야 한다. PR을 읽는 사람 대부분은 모른다. 무엇이 안 지켜지고 있는지를
 * 도구 용어 없이 한 문장으로 말해야 코멘트가 읽힌다.
 */
export function explainMutant(mutant: Mutant): string {
  const what = describeChange(mutant);
  return `${what} **어떤 테스트도 실패하지 않습니다.**`;
}

function describeChange(mutant: Mutant): string {
  const replacement = mutant.replacement.trim();

  switch (mutant.mutatorName) {
    case "ConditionalExpression":
      if (replacement === "true") return "이 조건이 **항상 참**이 되어도";
      if (replacement === "false") return "이 조건이 **항상 거짓**이 되어도";
      return "이 조건의 결과가 뒤집혀도";

    case "EqualityOperator":
      return "비교 연산자의 **경계가 한 칸 밀려도**(`<` ↔ `<=` 등)";

    case "LogicalOperator":
      return "논리 연산자가 바뀌어도(`&&` ↔ `||`, `??` 포함)";

    case "ArithmeticOperator":
      return "산술 연산자가 바뀌어도(`+` ↔ `-` 등)";

    case "UpdateOperator":
      return "증감 방향이 뒤집혀도(`++` ↔ `--`)";

    case "UnaryOperator":
      return "부호가 뒤집혀도(`-` ↔ `+`)";

    case "BooleanLiteral":
      return "참/거짓 값이 뒤집혀도";

    case "AssignmentOperator":
      return "대입 연산자가 바뀌어도";

    case "BlockStatement":
      return "이 블록의 **내용이 통째로 사라져도**";

    case "ArrowFunction":
      return "이 함수가 **아무것도 반환하지 않아도**";

    case "MethodExpression":
      return "이 메서드 호출이 **없어져도**(원본 값이 그대로 흘러도)";

    case "OptionalChaining":
      return "옵셔널 체이닝이 **사라져도**(값이 없을 때 터지게 되어도)";

    case "ObjectLiteral":
      return "이 객체가 **빈 객체가 되어도**";

    case "ArrayDeclaration":
      return "이 배열이 **비어도**";

    case "StringLiteral":
      return "이 문자열이 바뀌어도";

    case "Regex":
      return "이 정규식이 바뀌어도";

    default:
      return "이 코드가 아래처럼 바뀌어도";
  }
}

/**
 * 같은 증상을 여러 뮤턴트가 가리키는 경우가 흔하다.
 * (한 줄에 옵셔널 체이닝이 셋이면 뮤턴트도 셋)
 * 파일·심볼·게이트 관점에서 같은 것끼리 묶는 키.
 */
export function dedupeKey(mutant: Mutant): string {
  return `${mutant.path}:${mutant.line}:${mutant.mutatorName}`;
}

/** 한 줄로 줄인다. 코멘트 표에 넣기 위한 것. */
export function oneLine(source: string, limit = 100): string {
  const flat = source.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
