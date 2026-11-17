import fs from 'node:fs';
import { commonLispReader } from '../language/commonlisp-reader.ts';
import path from 'node:path';
import { ToolError, type Tool } from '../agent/types.ts';
import { resolveInRoot, assertRealInRoot } from './guard.ts';
import { detectLanguage } from '../language/detect.ts';
import { formatDiagnostics, type LanguageService } from '../language/lsp/service.ts';
import { outline, verifyGrammar, type StructureNode } from '../language/syntax/parser.ts';
import { offsetToPosition, positionToOffset } from '../language/positions.ts';
import type { ServerDiagnostic } from '../language/lsp/client.ts';

function selector(value: unknown): 'tailwind' | undefined {
  if (value !== undefined && value !== 'tailwind') throw new ToolError('INVALID_ARGS', 'Unknown server selector');
  return value;
}

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new ToolError('INVALID_ARGS', `${name} は空でない文字列で指定する`);
  return value;
}

function readSource(root: string, rel: string): { abs: string; text: string } {
  const abs = resolveInRoot(root, rel);
  assertRealInRoot(root, abs);
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); } catch { throw new ToolError('NOT_FOUND', `読めないファイル: ${rel}`); }
  if (!stat.isFile()) throw new ToolError('READ_FAILED', `ファイルではない: ${rel}`);
  if (stat.size > MAX_SOURCE_BYTES) throw new ToolError('TOO_LARGE', `2 MiBを超えるファイルは解析しない: ${rel}`);
  return { abs, text: fs.readFileSync(abs, 'utf8') };
}

function renderDiagnostics(items: ServerDiagnostic[], root: string): string {
  if (items.length === 0) return '診断は0件（サーバーが通知した結果）';
  return items.slice(0, 50).map(item => {
    const rel = path.relative(root, item.path) || item.path;
    return `${rel}:${item.line}:${item.column} ${item.severity}: ${item.message}${item.source ? ` (${item.source})` : ''}`;
  }).join('\n');
}

function renderDeclaration(node: StructureNode): string {
  const range = node.declaration;
  const name = node.name?.replace(/\s+/g, ' ');
  return `${range.startLine}:${range.startColumn}-${range.endLine}:${range.endColumn} ${node.kind}${name ? ` ${name} (名前位置 ${node.startLine}:${node.startColumn})` : ''}`;
}

async function describeSyntax(root: string, rel: string, query?: string): Promise<string> {
  const { abs, text } = readSource(root, rel);
  const detection = detectLanguage(abs, root);
  if (!detection?.language.grammar) throw new ToolError('UNSUPPORTED', `構造抽出の対象外: ${rel}`);
  const result = await outline(detection.language.grammar, text, { nameIncludes: query });
  if (result.status !== 'ok' || !result.nodes) {
    throw new ToolError(result.status === 'unsupported' ? 'UNSUPPORTED' : 'PARSE_FAILED',
      `${rel} の構造を取得できない: ${result.detail ?? result.status}`);
  }
  const rows = result.nodes.map(renderDeclaration);
  const summary = `${rel} (${detection.language.id}, ${rows.length}件${result.truncated ? 'まで表示' : ''}, 構文エラー候補${result.errorCount ?? 0})`;
  return `${summary}\n${rows.join('\n') || '(構文上の一致なし)'}`;
}

/** Lazy: constructing the tools must stay cheap for subagents with no language work. */
export function languageTools(service: LanguageService): Tool[] {
  const outlineTool: Tool = {
    readOnly: true,
    name: 'code_outline',
    description: 'Tree-sitterで関数・クラス・メソッド等と宣言全体の範囲を取得する。行・桁は1開始。終了位置は範囲に含まない。',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: '対象ファイル(ルート相対)' },
      server: { type: 'string', enum: ['tailwind'], description: 'Explicit semantic overlay' },
    }, required: ['path'] },
    async execute(args, ctx) {
      return describeSyntax(ctx.root, requireString(args.path, 'path'));
    },
  };

  const syntaxSearchTool: Tool = {
    readOnly: true,
    name: 'code_syntax_search',
    description: 'Tree-sitterで構文上の宣言名を検索し、対象ファイルと宣言全体の範囲を返す。行・桁は1開始、終了位置は範囲に含まない。同名候補はそれぞれ返す。',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: '対象ファイル(ルート相対)' },
      server: { type: 'string', enum: ['tailwind'], description: 'Explicit semantic overlay' },
      query: { type: 'string', description: '名前の部分一致(空なら全件)' },
    }, required: ['path'] },
    async execute(args, ctx) {
      const rel = requireString(args.path, 'path');
      if (args.query !== undefined && typeof args.query !== 'string') {
        throw new ToolError('INVALID_ARGS', 'query は宣言名の文字列で指定する');
      }
      return describeSyntax(ctx.root, rel, args.query);
    },
  };

  const diagnosticsTool: Tool = {
    readOnly: true,
    name: 'code_diagnostics',
    description: '現在のファイル内容をLSPへ同期し、診断を取得する。診断0件・未通知・古い版を区別して返す。',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: '対象ファイル(ルート相対)' },
      server: { type: 'string', enum: ['tailwind'], description: 'Explicit semantic overlay' },
    }, required: ['path'] },
    async execute(args, ctx) {
      const rel = requireString(args.path, 'path');
      const { text } = readSource(ctx.root, rel);
      const result = await service.analyze(resolveInRoot(ctx.root, rel), text, ctx.signal, selector(args.server));
      if (result.status !== 'ok') {
        const supplemental = detectLanguage(resolveInRoot(ctx.root, rel), ctx.root)?.language.id === 'commonlisp'
          ? await commonLispReader(text, { signal: ctx.signal }) : undefined;
        // Readable input is not a clean LSP diagnostic result. Keep the tool unverified.
        throw new ToolError('LSP_UNVERIFIED', `${formatDiagnostics(result)}${supplemental ? `\nSupplemental ${supplemental.provider}: ${supplemental.status}; ${supplemental.scope}\n${supplemental.line ?? '?'}:${supplemental.column ?? '?'} ${supplemental.detail}` : ''}`);
      }
      return `${formatDiagnostics(result)}\n${renderDiagnostics(result.diagnostics ?? [], ctx.root)}`;
    },
  };

  const positionTool = (name: 'code_definition' | 'code_references' | 'code_hover', description: string): Tool => ({
    readOnly: true,
    name,
    description,
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: '対象ファイル(ルート相対)' },
      server: { type: 'string', enum: ['tailwind'], description: 'Explicit semantic overlay' },
      line: { type: 'number', description: '1開始の行' },
      column: { type: 'number', description: '1開始の桁(UTF-16)' },
    }, required: ['path', 'line', 'column'] },
    async execute(args, ctx) {
      const rel = requireString(args.path, 'path');
      const line = Number(args.line), column = Number(args.column);
      if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) {
        throw new ToolError('INVALID_ARGS', 'line と column は1以上の整数');
      }
      const { abs, text } = readSource(ctx.root, rel);
      const offset = positionToOffset(text, { line: line - 1, character: column - 1 });
      const detection = detectLanguage(abs, ctx.root);
      if (!detection) throw new ToolError('UNSUPPORTED', `対応言語ではない: ${rel}`);
      // Ensure the server has the current text before asking about a position.
      await service.analyze(abs, text, ctx.signal, selector(args.server));
      const position = offsetToPosition(text, offset);
      const root = detection.root;
      const configured = service.detect(abs);
      if (!configured) throw new ToolError('UNSUPPORTED', `対応言語ではない: ${rel}`);
      try {
        if (name === 'code_hover') {
          const answer = await withServer(service, abs, text, ctx.signal, server => server.hover(abs, position), selector(args.server));
          return answer ?? '型情報は得られなかった';
        }
        const locations = await withServer(service, abs, text, ctx.signal, server =>
          name === 'code_definition' ? server.definition(abs, position) : server.references(abs, position), selector(args.server));
        if (locations.length === 0) return `${name}: 該当なし。この結果は未取得ではなく、サーバーが空を返した`;
        return locations.map(location => `${path.relative(root, location.file) || location.file}:${location.line}:${location.character}`).join('\n');
      } catch (e) {
        throw new ToolError('LSP_FAILED', (e as Error).message);
      }
    },
  });

  return [outlineTool, syntaxSearchTool, diagnosticsTool,
    positionTool('code_definition', '定義位置を取得する(位置的問い合わせ)'),
    positionTool('code_references', '参照位置を取得する(位置的問い合わせ)'),
    positionTool('code_hover', '型・ドキュメントのホバー情報を取得する')];
}

/** Acquire the same pooled server used for diagnostics; absence is reported, never fabricated. */
async function withServer<T>(
  service: LanguageService,
  file: string,
  text: string,
  signal: AbortSignal | undefined,
  action: (server: import('../language/lsp/client.ts').LspServer) => Promise<T>,
  selector?: 'tailwind',
): Promise<T> {
  const server = service.poolFor(file, selector);
  if (!server) throw new Error('言語サーバーを初期化できませんでした');
  void text; void signal;
  return action(server);
}

export { verifyGrammar };
