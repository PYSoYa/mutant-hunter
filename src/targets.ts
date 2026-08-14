import { Node, Project, SyntaxKind } from "ts-morph";
import type { MutateRange } from "./types.js";

/**
 * 뮤테이션 범위의 단위가 되는 선언들.
 *
 * 변경된 "줄"만 뮤테이션하면 그 줄을 감싸는 분기 조건이 빠져 갭을 놓치고,
 * 파일 전체를 뮤테이션하면 실행 시간이 폭발한다. 선언 단위가 그 중간이다.
 */
const DECLARATION_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.ClassDeclaration,
]);

export function createProject(tsConfigFilePath?: string): Project {
  if (tsConfigFilePath) {
    return new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: true });
  }
  return new Project({
    compilerOptions: { allowJs: true, target: 99 },
    skipFileDependencyResolution: true,
  });
}

/**
 * 변경된 줄들을 감싸는 선언 범위로 확장하고, 겹치는 범위를 병합한다.
 * 감싸는 선언을 못 찾으면(최상위 문장 등) 그 줄만 범위로 삼는다.
 */
export function resolveMutateRanges(
  project: Project,
  absPath: string,
  repoRelPath: string,
  changedLines: number[],
): MutateRange[] {
  const sourceFile =
    project.getSourceFile(absPath) ?? project.addSourceFileAtPath(absPath);
  const compilerNode = sourceFile.compilerNode;
  const totalLines = sourceFile.getEndLineNumber();

  const raw: MutateRange[] = [];

  for (const line of changedLines) {
    if (line > totalLines) continue;

    const pos = safePosOfLine(compilerNode, line);
    if (pos === null) continue;

    const node = sourceFile.getDescendantAtPos(pos);
    const decl = node ? findEnclosingDeclaration(node) : undefined;

    if (decl) {
      raw.push({
        path: repoRelPath,
        start: decl.getStartLineNumber(),
        end: decl.getEndLineNumber(),
        symbol: describe(decl),
      });
    } else {
      raw.push({ path: repoRelPath, start: line, end: line, symbol: "(top-level)" });
    }
  }

  return mergeRanges(raw);
}

/**
 * 가장 안쪽 선언이 아니라 가장 바깥쪽 선언까지 올라간다.
 * 중첩 화살표 함수의 안쪽만 잡으면 그것을 감싼 조건 분기가 대상에서 빠진다.
 */
function findEnclosingDeclaration(node: Node): Node | undefined {
  let found: Node | undefined;
  let cursor: Node | undefined = node;

  while (cursor) {
    if (DECLARATION_KINDS.has(cursor.getKind())) found = cursor;
    cursor = cursor.getParent();
  }

  return found;
}

function describe(decl: Node): string {
  if (Node.isNameable(decl) || Node.isNamed(decl)) {
    const name = (decl as { getName?: () => string | undefined }).getName?.();
    if (name) return name;
  }
  // 익명 함수는 대입된 변수 이름으로 부른다.
  const varDecl = decl.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  if (varDecl) return varDecl.getName();
  return `${decl.getKindName()}@${decl.getStartLineNumber()}`;
}

/** 같은 파일 안에서 겹치거나 맞닿은 범위를 하나로 합친다. */
export function mergeRanges(ranges: MutateRange[]): MutateRange[] {
  if (ranges.length === 0) return [];

  const sorted = [...ranges].sort(
    (a, b) => a.path.localeCompare(b.path) || a.start - b.start || a.end - b.end,
  );

  const out: MutateRange[] = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.path === r.path && r.start <= prev.end + 1) {
      if (r.end > prev.end) prev.end = r.end;
      if (!prev.symbol.split(", ").includes(r.symbol)) {
        prev.symbol = `${prev.symbol}, ${r.symbol}`;
      }
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** Stryker `--mutate` 인자 형식으로 직렬화한다. */
export function toStrykerMutateArgs(ranges: MutateRange[]): string[] {
  return ranges.map((r) => `${r.path}:${r.start}-${r.end}`);
}

function safePosOfLine(
  compilerNode: { getPositionOfLineAndCharacter: (l: number, c: number) => number },
  line: number,
): number | null {
  try {
    return compilerNode.getPositionOfLineAndCharacter(line - 1, 0);
  } catch {
    return null;
  }
}
