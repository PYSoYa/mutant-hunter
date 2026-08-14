import { ts } from "ts-morph";

export type SyntaxCheck = { ok: true } | { ok: false; message: string };

/**
 * 생성된 테스트가 파싱되는지 로컬에서 먼저 본다.
 *
 * 실측에서 `passes-on-original` 폐기 104건 중 42건(40%)이 문법 오류였다.
 * 이걸 잡으려고 vitest를 띄우는 건 낭비다 — 파서는 즉시, 공짜로 답한다.
 *
 * **타입 검사는 하지 않는다.** import가 대상 repo에서 해석되는지는 여기서
 * 알 수 없고, 타입 오류를 문법 오류로 보고하면 멀쩡한 테스트를 버리게 된다.
 */
export function checkSyntax(source: string, fileName = "generated.test.ts"): SyntaxCheck {
  if (source.trim().length === 0) {
    return { ok: false, message: "빈 파일입니다." };
  }

  const out = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      // 문법만 본다. 라이브러리 정의를 읽지 않으므로 빠르다.
      isolatedModules: true,
    },
  });

  const diagnostics = out.diagnostics ?? [];
  if (diagnostics.length === 0) return { ok: true };

  return { ok: false, message: diagnostics.slice(0, 5).map(describe).join("\n") };
}

function describe(d: ts.Diagnostic): string {
  const text = ts.flattenDiagnosticMessageText(d.messageText, " ");
  if (d.file && d.start !== undefined) {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return `L${line + 1}:${character + 1} ${text}`;
  }
  return text;
}
