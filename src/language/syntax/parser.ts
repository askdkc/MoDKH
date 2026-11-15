import fs from 'node:fs';
import { Parser, Language, Query } from 'web-tree-sitter';
import { grammarPaths } from './assets.ts';

export interface StructureNode {
  kind: string;
  name?: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface SyntaxResult {
  status: 'ok' | 'unsupported' | 'error';
  language: string;
  /** Present only on success; a failure reason is supplied otherwise. */
  nodes?: StructureNode[];
  errorCount?: number;
  detail?: string;
}

interface Loaded { parser: Parser; language: Language }
const loaded = new Map<string, Loaded | Error>();
let initializing: Promise<void> | null = null;

/** One WASM runtime per process; grammars are loaded lazily and kept small. */
async function runtime(): Promise<void> {
  initializing ??= Parser.init();
  await initializing;
}

const DEFINITION_QUERIES: Record<string, string> = {
  typescript: `(function_declaration name: (identifier) @name)
(class_declaration name: (type_identifier) @name)
(interface_declaration name: (type_identifier) @name)
(type_alias_declaration name: (type_identifier) @name)
(enum_declaration name: (identifier) @name)
(method_definition name: (property_identifier) @name)
(lexical_declaration (variable_declarator name: (identifier) @name))
(export_statement declaration: (function_declaration name: (identifier) @name))`,
  python: `(function_definition name: (identifier) @name)
(class_definition name: (identifier) @name)`,
  rust: `(function_item name: (identifier) @name)
(struct_item name: (type_identifier) @name)
(enum_item name: (type_identifier) @name)
(trait_item name: (type_identifier) @name)
(impl_item type: (type_identifier) @name)`,
  c: `(function_definition declarator: (function_declarator declarator: (identifier) @name))
(struct_specifier name: (type_identifier) @name)`,
  cpp: `(function_definition declarator: (function_declarator declarator: (_) @name))
(class_specifier name: (type_identifier) @name)
(struct_specifier name: (type_identifier) @name)
(namespace_definition name: (namespace_identifier) @name)`,
  ruby: `(method name: (_) @name)
(class name: (constant) @name)
(module name: (constant) @name)`,
  php: `(function_definition name: (name) @name)
(class_declaration name: (name) @name)
(method_declaration name: (name) @name)`,
  swift: `(function_declaration name: (simple_identifier) @name)
(class_declaration name: (type_identifier) @name)
(protocol_declaration name: (type_identifier) @name)`,
  html: `(element (start_tag (tag_name) @name))`,
  css: `(rule_set (selectors) @name)`,
};

// JS/TSX share the TypeScript-family grammar names but have their own wasm files.
for (const alias of ['javascript', 'tsx']) {
  DEFINITION_QUERIES[alias] = DEFINITION_QUERIES['typescript'] ?? '';
}
DEFINITION_QUERIES['javascript'] = `(function_declaration name: (identifier) @name)
(class_declaration name: (identifier) @name)
(method_definition name: (property_identifier) @name)
(lexical_declaration (variable_declarator name: (identifier) @name))`;

/** Bare `enclosing` lookups do not need naming; queries above name definitions only. */
export function definitionQuery(grammar: string): string | undefined {
  return DEFINITION_QUERIES[grammar];
}

async function load(grammar: string): Promise<Loaded> {
  const cached = loaded.get(grammar);
  if (cached instanceof Error) throw cached;
  if (cached) return cached;
  try {
    const paths = grammarPaths(grammar);
    if (!paths) throw new Error(`文法 ${grammar} は同梱されていません`);
    await runtime();
    const language = await Language.load(paths.bytes);
    const parser = new Parser();
    parser.setLanguage(language);
    const value = { parser, language };
    loaded.set(grammar, value);
    return value;
  } catch (e) {
    const failure = e instanceof Error ? e : new Error(String(e));
    loaded.set(grammar, failure);
    throw failure;
  }
}

/** A short parse proves the grammar works before it is advertised as ready. */
export async function verifyGrammar(grammar: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const { parser } = await load(grammar);
    const tree = parser.parse('x');
    if (!tree) return { ok: false, detail: '空の構文木が返った' };
    tree.delete();
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

const MAX_STRUCTURE_NODES = 400;
export async function outline(grammar: string, source: string, limit = MAX_STRUCTURE_NODES): Promise<SyntaxResult> {
  const query = definitionQuery(grammar);
  if (!query) return { status: 'unsupported', language: grammar, detail: 'この言語の構造抽出は未対応' };
  let tree;
  try {
    const bundle = await load(grammar);
    tree = bundle.parser.parse(source);
    if (!tree) return { status: 'error', language: grammar, detail: '構文木を作成できなかった' };
    const matcher = new Query(bundle.language, query);
    const nodes: StructureNode[] = [];
    for (const capture of matcher.captures(tree.rootNode)) {
      if (nodes.length >= limit) break;
      const node = capture.node;
      nodes.push({
        kind: node.parent?.parent?.type ?? node.parent?.type ?? node.type,
        name: node.text.slice(0, 200),
        startLine: node.startPosition.row + 1,
        startColumn: node.startPosition.column + 1,
        endLine: node.endPosition.row + 1,
        endColumn: node.endPosition.column + 1,
      });
    }
    matcher.delete();
    return { status: 'ok', language: grammar, nodes, errorCount: countErrors(tree.rootNode) };
  } catch (e) {
    return { status: 'error', language: grammar, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    tree?.delete();
  }
}

function countErrors(node: { hasError: boolean; childCount: number; child(i: number): unknown }, budget = 5000): number {
  const stack: { hasError: boolean; childCount: number; child(i: number): unknown }[] = [node];
  let count = 0, visited = 0;
  while (stack.length && visited < budget) {
    const current = stack.pop()!;
    visited++;
    if (!current.hasError) continue;
    count++;
    for (let i = 0; i < current.childCount; i++) stack.push(current.child(i) as never);
  }
  return count;
}
