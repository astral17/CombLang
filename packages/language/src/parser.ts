import ts from 'typescript';

import {
  type Diagnostic,
  type SourceFileId,
  type SourceSpan,
  sourceFileId,
  sourceSpan,
} from '@comblang/shared';

export interface SourceFileSnapshot {
  readonly path: string;
  readonly text: string;
}

export interface ParsedSourceFile {
  readonly id: SourceFileId;
  readonly path: string;
  readonly text: string;
  readonly ast: ts.SourceFile;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ParsedProject {
  readonly files: ReadonlyMap<SourceFileId, ParsedSourceFile>;
  readonly diagnostics: readonly Diagnostic[];
}

export interface SyntaxNodeSummary {
  readonly kind: string;
  readonly span: SourceSpan;
  readonly text: string;
}

function diagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function normalizeDiagnostic(fileId: SourceFileId, diagnostic: ts.Diagnostic): Diagnostic {
  const base = {
    code: `TS${diagnostic.code}`,
    severity: 'error' as const,
    message: diagnosticMessage(diagnostic),
  };

  if (diagnostic.start === undefined) {
    return base;
  }

  return {
    ...base,
    span: sourceSpan(fileId, diagnostic.start, diagnostic.start + (diagnostic.length ?? 0)),
  };
}

export function parseFile(file: SourceFileSnapshot): ParsedSourceFile {
  const id = sourceFileId(file.path);
  const ast = ts.createSourceFile(
    file.path,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const parserDiagnostics = (
    ast as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;

  return {
    id,
    path: file.path,
    text: file.text,
    ast,
    diagnostics: parserDiagnostics.map((diagnostic) => normalizeDiagnostic(id, diagnostic)),
  };
}

export function parseProject(files: readonly SourceFileSnapshot[]): ParsedProject {
  const parsedFiles = new Map<SourceFileId, ParsedSourceFile>();
  const diagnostics: Diagnostic[] = [];

  for (const file of files) {
    const parsed = parseFile(file);
    if (parsedFiles.has(parsed.id)) {
      diagnostics.push({
        code: 'CL0001',
        severity: 'error',
        message: `Duplicate source path after normalization: ${file.path}`,
      });
      continue;
    }

    parsedFiles.set(parsed.id, parsed);
    diagnostics.push(...parsed.diagnostics);
  }

  return { files: parsedFiles, diagnostics };
}

export function spanForNode(file: ParsedSourceFile, node: ts.Node): SourceSpan {
  return sourceSpan(file.id, node.getStart(file.ast), node.getEnd());
}

export function summarizeTopLevel(file: ParsedSourceFile): readonly SyntaxNodeSummary[] {
  return file.ast.statements.map((statement) => ({
    kind: ts.SyntaxKind[statement.kind],
    span: spanForNode(file, statement),
    text: statement.getText(file.ast),
  }));
}
