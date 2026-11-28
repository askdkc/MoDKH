import path from 'node:path';
import fs from 'node:fs';
import { assertRealInRoot, resolveInRoot } from '../tools/guard.ts';
import type { AgentMessage, ToolCall, ToolResult } from './types.ts';
import { isUserRequest } from './types.ts';
import { TOOL_OUTPUT_BYTES } from '../model/context.ts';
import { evidenceExcerpt } from './saved-results.ts';

interface Row { file: string; number: number; text: string; index: number }
interface Read { rows: Row[]; lines: string[]; purpose: string }

const sedRange = /^sed -n (['"]?)(\d+),(\d+)p\1 ([-\w./]+)$/u;
const simpleDump = /^(?:cat|head -(\d+)) ([-\w./]+)$/u;

function shellRows(call: ToolCall, lines: string[]): Row[] {
  if (typeof call.args.command !== 'string' || lines.includes('[出力が上限に達したため一部を省略した]')) return [];
  if (lines[0] !== '[exit code: 0]' || lines[1] !== '--- stdout ---' || lines.includes('--- stderr ---')) return [];
  // Only literal, single-file commands. A pipeline, expansion or other shell operation
  // need not produce the named file's lines, even if it exits successfully.
  const sed = sedRange.exec(call.args.command);
  const grep = /^grep -n (?:'[^'\n]*'|"[^"`$\\\n]*") ([-\w./]+)$/u.exec(call.args.command);
  const dump = simpleDump.exec(call.args.command);
  if (!sed && !grep && !dump) return [];
  const name = sed?.[4] ?? dump?.[2] ?? grep![1];
  if (name.startsWith('-') || path.isAbsolute(name) || (call.args.cwd !== undefined && typeof call.args.cwd !== 'string')) return [];
  const file = path.normalize(path.join(String(call.args.cwd ?? '.'), name));
  const rows: Row[] = [];
  for (let index = 2; index < lines.length; index++) {
    if (sed || dump) {
      const number = Number(sed?.[2] ?? 1) + index - 2;
      if (number < 1 || number > Number(sed?.[3] ?? dump?.[1] ?? Infinity)) return [];
      rows.push({ file, number, index, text: lines[index] });
    } else {
      const hit = /^(\d+):(.*)$/u.exec(lines[index]);
      if (!hit) return [];
      rows.push({ file, number: Number(hit[1]), text: hit[2], index });
    }
  }
  return rows;
}

function observedRead(call: ToolCall, result: ToolResult): Read | undefined {
  if (result.status !== 'ok' || call.name !== result.name || !['read_file', 'run_command', 'search_files'].includes(call.name)) return;
  let rows: Row[] = [];
  const lines = result.output.split('\n');
  let purpose = call.args.purpose;
  if (call.name === 'read_file' && typeof call.args.path === 'string') {
    const prefix = call.args.path + ' (';
    if (!lines[0].startsWith(prefix)) return;
    const header = /^\d+行中 (\d+)行目から(\d+)行\)$/u.exec(lines[0].slice(prefix.length));
    if (!header || Number(header[2]) > lines.length - 1) return;
    for (let index = 1; index <= Number(header[2]); index++) {
      const number = Number(header[1]) + index - 1;
      const label = number + ': ';
      if (!lines[index].startsWith(label)) return;
      rows.push({ file: path.normalize(call.args.path), number, index, text: lines[index].slice(label.length) });
    }
  } else if (call.name === 'search_files') {
    purpose = purpose ?? call.args.pattern;
    for (let index = 2; index < lines.length; index++) {
      const hit = /^(.+?):(\d+): (.*)$/u.exec(lines[index]);
      if (hit && !hit[3].endsWith('[行の一部省略]')) rows.push({ file: path.normalize(hit[1]), number: Number(hit[2]), text: hit[3], index });
    }
  } else if (call.name === 'run_command') {
    rows = shellRows(call, lines);
    purpose = call.args.description;
  }
  if (rows.length) return { lines, rows, purpose: typeof purpose === 'string' ? evidenceExcerpt(purpose, 100) : 'purpose not recorded' };
}

function ranges(numbers: number[]): string {
  const parts: string[] = [];
  let start = numbers[0], last = start;
  for (const n of numbers.slice(1)) {
    if (n !== last + 1) { parts.push(start === last ? String(start) : start + '-' + last); start = n; }
    last = n;
  }
  parts.push(start === last ? String(start) : start + '-' + last);
  return parts.join(',');
}

/** Reconstruct from the journal, including sessions written before read purposes existed.
 * Historical observations are hints. Only a fresh matching result can establish equality. */
export function projectReadHistory(messages: AgentMessage[], start: number, from: number) {
  const calls = new Map<string, ToolCall>();
  const notes = new Map<string, { rows: Row[]; label: string }>();
  const seen = new Set<string>();
  for (const message of messages.slice(start, from)) {
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) calls.set(call.id, call);
    if (message.role !== 'tool') continue;
    // Normal tool output projection can truncate a large page or a large batch.
    // Such receipts cannot establish which source lines the model actually saw.
    if (message.results.length > 8) continue;
    for (const result of message.results) {
      if (Buffer.byteLength(result.output) > TOOL_OUTPUT_BYTES) continue;
      const call = calls.get(result.callId);
      if (!call || seen.has(call.id)) continue;
      seen.add(call.id);
      const read = observedRead(call, result);
      if (!read) continue;
      const files = new Map<string, Row[]>();
      for (const row of read.rows) {
        const rows = files.get(row.file);
        if (rows) rows.push(row); else files.set(row.file, [row]);
      }
      for (const [file, rows] of files) {
        const where = file + ':' + ranges(rows.map(r => r.number));
        const label = [evidenceExcerpt(where, 150), read.purpose, evidenceExcerpt(rows.find(r => r.text.trim())?.text ?? '', 90)];
        const key = JSON.stringify([where, read.purpose]);
        notes.delete(key);
        notes.set(key, { rows, label: JSON.stringify(label) });
        if (notes.size > 24) notes.delete(notes.keys().next().value!);
      }
    }
  }
  const tail = messages.slice(from);
  const prior = new Map<string, Map<number, string>>();
  function remember(row: Row) {
    let file = prior.get(row.file);
    if (!file) prior.set(row.file, file = new Map());
    file.set(row.number, row.text);
  }
  for (const { rows } of notes.values()) rows.forEach(remember);
  const note = !notes.size ? '' : '\nPreviously inspected source (historical data: file:lines, purpose, excerpt). Reuse this context; request only missing or changed lines. Use read_file(full_text:true) when exact text is needed.\n'
    + [...notes.values()].map(n => n.label).join('\n');
  let sameTask = true;
  return { note, tail: tail.map(message => {
    if (isUserRequest(message)) sameTask = false;
    if (!sameTask) return message;
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) calls.set(call.id, call);
    if (message.role !== 'tool') return message;
    return { ...message, results: message.results.map(result => {
      const call = calls.get(result.callId);
      if (!call) return result;
      const read = observedRead(call, result);
      if (!read) return result;
      const omitted = read.rows.filter(r => prior.get(r.file)?.get(r.number) === r.text);
      if (message.results.length <= 8 && Buffer.byteLength(result.output) <= TOOL_OUTPUT_BYTES) read.rows.forEach(remember);
      if (!omitted.length || call.args.full_text === true) return result;
      const indexes = new Set(omitted.map(r => r.index));
      // sed's stdout has no line numbers. Keep positions for new/changed lines
      // when earlier lines have been suppressed.
      if (call.name === 'run_command' && !String(call.args.command).startsWith('grep -n ')) for (const row of read.rows) {
        if (!indexes.has(row.index)) read.lines[row.index] = row.file + ':' + row.number + ': ' + row.text;
      }
      const output = read.lines.filter((_, i) => !indexes.has(i)).join('\n') + '\n[Already inspected: ' + omitted.length
        + ' unchanged lines omitted. Use read_file(full_text:true) for exact text.]';
      return output.length < result.output.length ? { ...result, output } : result;
    }) };
  }) };
}

/** Retain per-line observations outside the model's compressed context. Only
 * literal file reads can be declined, after comparing the current source. */
export class RepeatedReads {
  private files = new Map<string, Map<number, { text: string; count: number; exact: boolean }>>();

  observe(call: ToolCall, result: ToolResult): void {
    if (result.status !== 'ok') return;
    if (['edit_file', 'create_file'].includes(call.name) && typeof call.args.path === 'string') {
      this.files.delete(path.normalize(call.args.path));
      return;
    }
    const read = observedRead(call, result);
    if (!read) return;
    if (call.name === 'read_file') {
      const header = /\((\d+)行中 /.exec(read.lines[0]);
      const previous = this.files.get(read.rows[0].file);
      if (previous && header) for (const number of previous.keys()) {
        if (number > Number(header[1])) previous.delete(number);
      }
    }
    for (const row of read.rows) {
      let lines = this.files.get(row.file);
      if (!lines) this.files.set(row.file, lines = new Map());
      const old = lines.get(row.number);
      const same = old?.text === row.text;
      lines.set(row.number, { text: row.text, count: same ? old.count + 1 : 1,
        exact: call.args.full_text === true || (same && old.exact) });
    }
  }

  block(root: string, call: ToolCall): string | undefined {
    let file: unknown, start: number, end: number;
    const a = call.args;
    if (call.name === 'read_file') {
      file = a.path;
      start = Number(a.offset ?? 1);
      const limit = Number(a.limit ?? 500);
      if (!Number.isSafeInteger(limit) || limit < 1) return;
      end = start + limit - 1;
    } else if (call.name === 'run_command' && typeof a.command === 'string' && !a.run_in_background) {
      const sed = sedRange.exec(a.command), dump = simpleDump.exec(a.command);
      const target = sed?.[4] ?? dump?.[2];
      if (!target || target.startsWith('-') || path.isAbsolute(target) || (a.cwd !== undefined && typeof a.cwd !== 'string')) return;
      file = path.join(String(a.cwd ?? '.'), target);
      start = Number(sed?.[2] ?? 1);
      end = Number(sed?.[3] ?? dump?.[1] ?? Infinity);
    } else return;
    if (typeof file !== 'string' || !Number.isSafeInteger(start) || start < 1 || end < start) return;
    const seen = this.files.get(path.normalize(file));
    if (!seen || (seen.get(start)?.count ?? 0) < 3) return;
    try {
      const abs = resolveInRoot(root, file);
      assertRealInRoot(root, abs);
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return;
      const current = fs.readFileSync(abs, 'utf8').split('\n');
      if (current.at(-1) === '') current.pop();
      // A shorter page is new evidence even if every surviving line matches.
      if (end > current.length && seen.has(current.length + 1)) return;
      end = Math.min(end, current.length);
      if (start > end) return;
      for (let n = start; n <= end; n++) {
        const row = seen.get(n);
        if (!row || row.count < 3 || row.text !== current[n - 1] || (a.full_text === true && !row.exact)) return;
      }
      return '[REPEATED_READ] ' + JSON.stringify(file) + ':' + start + '-' + end
        + ' is unchanged and has already been read three times. Use the evidence to carry out the requested work, or report the result. Read a different range only for a missing fact.';
    } catch { return; } // Normal dispatch owns all path, permission and I/O errors.
  }
}
