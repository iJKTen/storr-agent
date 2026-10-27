import type { AgentState, IFileReader, TerminalExecutor } from '../types.js';
import { log } from '../log.js';

export interface TypecheckResult {
  passed: boolean;
  errorOutput: string;
  errorFiles: Array<{ filePath: string; content: string; isComponent: boolean }>;
}

export function extractErrorFilePaths(errorOutput: string, workspacePath: string): string[] {
  const paths = new Set<string>();
  const pattern = /^(.+?)\(\d+,\d+\):\s*error\s+TS/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(errorOutput)) !== null) {
    let filePath = match[1].trim();
    if (filePath.startsWith(workspacePath)) {
      filePath = filePath.slice(workspacePath.length).replace(/^\//, '');
    }
    paths.add(filePath);
  }
  return [...paths];
}

export function isComponentFile(filePath: string): boolean {
  return /^app\/components\/[A-Z][a-zA-Z0-9]+\//.test(filePath)
    && !filePath.startsWith('app/components/templates/');
}

function parseErrorOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join('\n');
}

function stripNonErrorLines(output: string): string {
  return output
    .split('\n')
    .filter((line) =>
      /\(\d+,\d+\):\s*error\s+TS/.test(line) ||
      /^Found \d+ errors? in/.test(line),
    )
    .join('\n');
}

async function readErrorFiles(
  reader: IFileReader,
  errorOutput: string,
): Promise<TypecheckResult['errorFiles']> {
  const filePaths = extractErrorFilePaths(errorOutput, reader.workspacePath);
  const errorFiles: TypecheckResult['errorFiles'] = [];

  for (const filePath of filePaths) {
    if (reader.fileExists(filePath)) {
      try {
        const content = await reader.readFile(filePath);
        errorFiles.push({
          filePath,
          content,
          isComponent: isComponentFile(filePath),
        });
      } catch {
        // Skip unreadable files
      }
    }
  }

  return errorFiles;
}

export async function runTypecheck(
  reader: IFileReader,
  terminal: TerminalExecutor,
): Promise<TypecheckResult> {
  const result = await terminal('npm run typecheck');

  if (result.exitCode === 0) {
    return { passed: true, errorOutput: '', errorFiles: [] };
  }

  const errorOutput = parseErrorOutput(result.stdout, result.stderr);
  const errorFiles = await readErrorFiles(reader, errorOutput);
  return { passed: false, errorOutput, errorFiles };
}

function filterErrorLines(output: string, prefixes: string[]): string {
  return output
    .split('\n')
    .filter((line) => {
      if (!/\(\d+,\d+\):\s*error\s+TS/.test(line)) return true;
      return prefixes.some((prefix) => line.includes(prefix));
    })
    .join('\n');
}

export function filterTypecheckToScope(
  result: TypecheckResult,
  scopePrefixes: string[],
): TypecheckResult {
  if (result.passed) return result;

  const filteredFiles = result.errorFiles.filter((f) =>
    scopePrefixes.some((prefix) => f.filePath.startsWith(prefix)),
  );

  const filteredOutput = filterErrorLines(result.errorOutput, scopePrefixes);

  const hasRelevantErrors =
    filteredFiles.length > 0 ||
    filteredOutput.split('\n').some((l) => /\(\d+,\d+\):\s*error\s+TS/.test(l));

  if (!hasRelevantErrors) {
    return { passed: true, errorOutput: '', errorFiles: [] };
  }

  return { passed: false, errorOutput: filteredOutput, errorFiles: filteredFiles };
}

export function logTypecheckErrors(
  state: AgentState,
  result: TypecheckResult,
): void {
  if (result.passed || !result.errorOutput) return;
  const lines = result.errorOutput.split('\n');
  const maxLines = 30;
  const display = lines.length > maxLines
    ? [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`]
    : lines;
  log(state, `Typecheck errors:\n${display.join('\n')}`);
}

export function extractMissingModules(result: TypecheckResult): string[] {
  const pattern = /error TS2307: Cannot find module '([^']+)'/g;
  const modules = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(result.errorOutput)) !== null) {
    const specifier = match[1];
    // Skip relative/alias imports — only bare npm specifiers
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('~')) continue;
    // Handle scoped packages: @scope/pkg/subpath → @scope/pkg
    if (specifier.startsWith('@')) {
      const parts = specifier.split('/');
      modules.add(parts.slice(0, 2).join('/'));
    } else {
      // Unscoped: pkg/subpath → pkg
      modules.add(specifier.split('/')[0]);
    }
  }
  return [...modules];
}

export function formatTypecheckErrors(
  result: TypecheckResult,
  toolHint: 'write_component' | 'update_file',
): string {
  const cleanOutput = stripNonErrorLines(result.errorOutput);
  const parts = [
    `TYPECHECK FAILED — fix these TypeScript errors and re-call \`${toolHint}\`:`,
    '', '```', cleanOutput, '```',
  ];

  if (result.errorFiles.length > 0) {
    parts.push('', '## Files With Errors', '');
    for (const file of result.errorFiles) {
      parts.push(
        `## ${file.filePath}`, '```tsx', file.content, '```', '',
      );
    }
  }

  return parts.join('\n');
}
