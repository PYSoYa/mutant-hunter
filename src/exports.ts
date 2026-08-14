import { Node, type Project, type SourceFile } from "ts-morph";

/**
 * 대상 모듈이 실제로 내보내는 것들을 시그니처와 함께 나열한다.
 *
 * 실측에서 `passes-on-original` 폐기 104건 중 29건(28%)이 없는 API 호출이었다.
 * 모델이 함수를 지어내는 건 **뭐가 있는지 알려주지 않았기 때문**이다.
 * 감싸는 선언과 형제 테스트만 줘서는 모듈의 전체 표면을 알 수 없다.
 */
export function describeExports(project: Project, absPath: string, limit = 40): string {
  let sourceFile: SourceFile;
  try {
    sourceFile = project.getSourceFile(absPath) ?? project.addSourceFileAtPath(absPath);
  } catch {
    return "";
  }

  const lines: string[] = [];

  for (const [name, decls] of sourceFile.getExportedDeclarations()) {
    if (lines.length >= limit) break;
    const decl = decls[0];
    if (!decl) continue;
    lines.push(`${name}: ${signatureOf(decl)}`);
  }

  return lines.join("\n");
}

function signatureOf(decl: Node): string {
  if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) {
    const params = decl
      .getParameters()
      .map((p) => `${p.getName()}${p.isOptional() ? "?" : ""}: ${typeText(p.getType().getText(p))}`)
      .join(", ");
    return `(${params}) => ${typeText(decl.getReturnType().getText(decl))}`;
  }

  if (Node.isClassDeclaration(decl)) {
    const members = decl
      .getMembers()
      .filter((m) => Node.isMethodDeclaration(m) && !m.hasModifier("private"))
      .map((m) => (Node.isMethodDeclaration(m) ? m.getName() : ""))
      .filter(Boolean);
    return `class { ${members.join(", ")} }`;
  }

  if (Node.isTypeAliasDeclaration(decl) || Node.isInterfaceDeclaration(decl)) {
    return "type";
  }

  // 변수에 대입된 화살표 함수 등은 타입 텍스트가 가장 정확하다.
  return typeText(decl.getType().getText(decl));
}

/** 타입 텍스트가 길어지면 프롬프트를 삼킨다. import(...) 잡음도 걷어낸다. */
function typeText(text: string, limit = 120): string {
  const cleaned = text.replace(/import\("[^"]*"\)\./g, "").replace(/\s+/g, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}
