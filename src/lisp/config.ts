import fs from 'node:fs';
import path from 'node:path';
import { readBundledSkill, DKH_SKILL_BINDING } from '../agent/bundled-skills.ts';
import type { LocalDefinition, PluginDescriptor } from '../plugins/api.ts';
import { executeBounded, privateEnvironment, temporaryDirectory, sha256 } from './runtime.ts';
export interface SessionDefinition { descriptor: PluginDescriptor; definition: LocalDefinition }
export interface LispConfiguration { digest: string; entries: SessionDefinition[] }
const TOOLS = new Set(['code_outline', 'code_definition', 'code_references', 'code_diagnostics', 'code_hover', 'edit_file', 'verify_tla', 'verify_lean']);
const LANGUAGES = new Set(['php', 'common-lisp', 'js', 'ts', 'svelte', 'tailwindcss', 'html', 'css', 'tla', 'lean']);
const KINDS = new Set(['outline', 'definition', 'references', 'diagnostics', 'hover', 'edit', 'verify']);
export const REQUIRED_SKILLS = ['kiokuko-single-purpose-functions', 'one-shot-software-completion'] as const;

function string(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function paths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 128 || !value.every(v => typeof v === 'string' && v.length < 1024 && !path.isAbsolute(v) && !v.split(/[\\/]/).some((p: string) => !p || p === '.' || p === '..'))) throw new Error('Invalid verification manifest paths');
  if (new Set(value).size !== value.length) throw new Error('Duplicate manifest path');
  return [...value] as string[];
}
export function validateDefinitions(raw: unknown, digest: string): SessionDefinition[] {
  if (!Array.isArray(raw) || raw.length > 64) throw new Error('Expected at most 64 definitions');
  const ids = new Set<string>();
  const skills = REQUIRED_SKILLS.map(name => `\n\n--- ${name} (full SKILL.md) ---\n${readBundledSkill(name, 'SKILL.md', false)}`).join('');
  return raw.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid definition');
    const allowed = ['id', 'title', 'tool', 'language', 'task-kind', 'instruction', 'max-turns', 'enabled', 'workflow', 'check', 'sources', 'protected'];
    if (Object.keys(row).some(key => !allowed.includes(key))) throw new Error('Unknown definition field');
    const id = string(row.id, 'id', 64);
    if (!/^micro-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.has(id)) throw new Error('Duplicate or unsafe microagent ID');
    ids.add(id);
    const tool = string(row.tool, 'tool', 64);
    if (!TOOLS.has(tool)) throw new Error(`Unknown tool: ${tool}`);
    const language = row.language ?? '';
    const taskKind = row['task-kind'] ?? '';
    if (language && !LANGUAGES.has(language)) throw new Error('Unknown language');
    if (taskKind && !KINDS.has(taskKind)) throw new Error('Unknown task kind');
    const maxTurns = row['max-turns'] ?? 4;
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 32) throw new Error('max-turns must be 1..32');
    if (typeof row.enabled !== 'boolean') throw new Error('Invalid enabled flag');
    if (row.workflow && row.workflow !== 'edit-verify') throw new Error('Unknown workflow');
    if ((tool === 'edit_file') !== (row.workflow === 'edit-verify')) throw new Error('edit_file requires edit-verify workflow');
    if (row.check && row.workflow !== 'edit-verify') throw new Error('Only edit workflows accept checks');
    const instruction = string(row.instruction, 'instruction', 8192);
    const definition: LocalDefinition = {
      system: `MoDKH microagent ${id}. ${row.workflow ? 'Edit only the explicit owner-approved source snapshots. Never change the verifier.' : 'Observe only using your assigned tools.'} Host/parent owns final acceptance. Skills do not add tools or authority. Unread references are not evidence.\n${DKH_SKILL_BINDING}\n${instruction}${skills}`,
      tools: tool === 'edit_file' ? ['read_file', 'edit_file'] : [tool],
      skillPolicy: 'none', maxTurns, requireAllTools: true,
      ...(language === 'tailwindcss' ? { languageServer: 'tailwind' as const } : {}),
      ...(row.workflow ? { workflow: 'edit-verify' as const } : {}),
    };
    if (row.check) definition.verificationCommand = string(row.check, 'check', 4096);
    if (row.sources || row.protected) {
      definition.verificationManifest = { sources: paths(row.sources), protected: paths(row.protected) };
      if (definition.verificationManifest.sources.some(p => definition.verificationManifest!.protected.includes(p))) throw new Error('Source and verifier paths overlap');
    }
    return { descriptor: { apiVersion: 1, id, version: 'session', title: row.title ? string(row.title, 'title', 256) : id,
      description: instruction, kind: 'local', entry: '', digest, builtin: false,
      capabilities: [...definition.tools], enabled: row.enabled && (tool !== 'edit_file' || !!(definition.verificationCommand && definition.verificationManifest)), language, taskKind }, definition };
  });
}

// This is Common Lisp evaluated by SBCL, not an S-expression parser in JavaScript.
const DRIVER = String.raw`
(defpackage :dkh (:use :cl) (:export :defmicroagent :register-agent :disable-agent :remove-agent :list-agents :set-agent-check))
(in-package :dkh)
(defvar *agents* (make-hash-table :test 'equal))
(defun agent-id (id) (string-downcase (string id)))
(defun register-agent (id &rest fields)
  (setf id (agent-id id))
  (when (gethash id *agents*) (error "Duplicate agent: ~a" id))
  (unless (evenp (length fields)) (error "Odd keyword list"))
  (loop for (key value) on fields by #'cddr
        unless (member key '(:title :tool :language :task-kind :instruction :max-turns :workflow)) do (error "Unknown field: ~a" key))
  (let ((keys (loop for (key value) on fields by #'cddr collect key)))
    (unless (= (length keys) (length (remove-duplicates keys))) (error "Duplicate field")))
  (when (>= (hash-table-count *agents*) 64) (error "Too many agents"))
  (setf (gethash id *agents*) (append (list :id id :enabled t) fields)) id)
(defmacro defmicroagent (id &rest fields) (list* 'register-agent (list 'quote id) fields))
(defun disable-agent (id) (let ((row (gethash (agent-id id) *agents*))) (unless row (error "Unknown agent")) (setf (getf row :enabled) nil)))
(defun remove-agent (id) (remhash (agent-id id) *agents*))
(defun list-agents () (loop for row being the hash-values of *agents* collect (copy-tree row)))
(defun set-agent-check (id command &key sources protected)
  (let ((row (gethash (agent-id id) *agents*)))
    (unless row (error "Unknown agent"))
    (setf (getf row :check) command (getf row :sources) sources (getf row :protected) protected
          (gethash (agent-id id) *agents*) row)))
(defun json-string (value out)
  (write-char #\" out)
  (loop for c across value do
    (case c (#\" (write-string "\\\"" out)) (#\\ (write-string "\\\\" out))
      (#\Newline (write-string "\\n" out)) (#\Return (write-string "\\r" out)) (#\Tab (write-string "\\t" out))
      (otherwise (if (< (char-code c) 32) (format out "\\u~4,'0x" (char-code c)) (write-char c out)))))
  (write-char #\" out))
(defun json-value (value out)
  (cond ((null value) (write-string "null" out)) ((eq value t) (write-string "true" out))
    ((stringp value) (json-string value out)) ((integerp value) (princ value out))
    ((listp value) (write-char #\[ out) (loop for v in value for i from 0 do (when (> i 0) (write-char #\, out)) (json-value v out)) (write-char #\] out))
    (t (error "Non-JSON value"))))
(let ((protocol *standard-output*))
  (let ((*standard-output* (make-broadcast-stream)) (*trace-output* (make-broadcast-stream))
        (*error-output* (make-broadcast-stream)) (*terminal-io* (make-two-way-stream (make-string-input-stream "") (make-broadcast-stream))))
    (load "input.lisp" :verbose nil :print nil))
  (write-char #\[ protocol)
  (loop for row being the hash-values of *agents* for i from 0 do
    (when (> i 0) (write-char #\, protocol)) (write-char #\{ protocol)
    (loop for (key value) on row by #'cddr for j from 0 do
      (when (> j 0) (write-char #\, protocol)) (json-string (string-downcase (symbol-name key)) protocol) (write-char #\: protocol)
      (if (eq key :enabled) (write-string (if value "true" "false") protocol) (json-value value protocol)))
    (write-char #\} protocol))
  (write-char #\] protocol) (finish-output protocol))
`;

export async function loadLispConfiguration(file: string, trustedDigest: string, options: { sbcl?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<LispConfiguration> {
  if (!/^[a-f0-9]{64}$/.test(trustedDigest)) throw new Error('Explicit --trust-lisp-sha256 required');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes: Buffer;
  try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Lisp input must be a file of at most 64 KiB'); bytes = fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
  if (bytes.length > 64 * 1024 || sha256(bytes) !== trustedDigest) throw new Error('Lisp trust digest mismatch; not evaluated');
  const dir = temporaryDirectory('modkh-lisp-');
  let settled = true;
  try {
    fs.writeFileSync(path.join(dir, 'input.lisp'), bytes, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'driver.lisp'), DRIVER, { flag: 'wx', mode: 0o600 });
    const receipt = await executeBounded(options.sbcl ?? 'sbcl', ['--noinform', '--no-sysinit', '--no-userinit', '--disable-debugger', '--script', 'driver.lisp'], {
      cwd: dir, env: privateEnvironment(dir), inputDigest: trustedDigest, timeoutMs: Math.min(options.timeoutMs ?? 10000, 10000), signal: options.signal,
    });
    settled = receipt.cleanup === 'settled';
    if (receipt.state !== 'exited' || receipt.exitCode !== 0) throw new Error(`Lisp evaluation ${receipt.state}/${receipt.exitCode}: ${receipt.stderr.slice(0, 4096)}`);
    return { digest: trustedDigest, entries: validateDefinitions(JSON.parse(receipt.stdout), trustedDigest) };
  } finally { if (settled) fs.rmSync(dir, { recursive: true, force: true }); }
}
