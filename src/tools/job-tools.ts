import { ToolError, type Tool } from '../agent/types.ts';
import { resolveInRoot, assertRealInRoot } from './guard.ts';
import { describeShellResult, SHELLS, type ShellName } from './shell-process.ts';
import type { JobRegistry, JobView } from './jobs.ts';

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ToolError('INVALID_ARGS', `${name} は空でない文字列で指定する`);
  }
  return v;
}

function optionalString(v: unknown, name: string, max: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > max) throw new ToolError('INVALID_ARGS', `${name} は${max}文字以内の文字列で指定する`);
  return v;
}

function shellArg(v: unknown): ShellName {
  const value = optionalString(v, 'shell', 8);
  if (value === undefined) return 'sh';
  if (!(SHELLS as readonly string[]).includes(value)) {
    throw new ToolError('INVALID_ARGS', `shell は ${SHELLS.join(' | ')} のいずれか`);
  }
  return value as ShellName;
}

/** Shared with the foreground tool so both paths resolve and approve identically. */
export function prepareCommand(args: Record<string, unknown>, root: string): { command: string; cwd: string; cwdRel: string; shell: ShellName; description?: string } {
  const command = requireString(args.command, 'command');
  const cwdRel = args.cwd === undefined ? '.' : requireString(args.cwd, 'cwd');
  const shell = shellArg(args.shell);
  const description = optionalString(args.description, 'description', 200);
  const cwd = resolveInRoot(root, cwdRel);
  assertRealInRoot(root, cwd);
  return { command, cwd, cwdRel, shell, ...(description === undefined ? {} : { description }) };
}

function statusLine(view: JobView): string {
  const parts = [`[status: ${view.status}]`];
  if (view.exitCode !== undefined && view.exitCode !== null) parts.push(`[exit code: ${view.exitCode}]`);
  if (view.detail) parts.push(`[${view.detail}]`);
  const elapsed = Math.round(((view.finishedAt ?? Date.now()) - view.startedAt) / 1000);
  parts.push(`${elapsed}秒`);
  return parts.join(' ');
}

/**
 * job_output / job_list / job_kill.
 *
 * Reads are cursor-based: a stream job returns only what is new since the previous read, so
 * repeated polling during a long build does not re-send the whole log into the context.
 */
export function jobTools(jobs: JobRegistry): Tool[] {
  const output: Tool = {
    name: 'job_output',
    readOnly: true,
    description:
      'バックグラウンドジョブの出力を読む。前回の読み取り以降に増えた分だけを返す。'
      + 'wait を指定すると、新しい出力が出るかジョブが終わるまで待つ。'
      + '応答の末尾に [status: ...] が付く。status が running ならまだ実行中。',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'run_command が返した job_id' },
        wait: { type: 'boolean', description: '新しい出力か終了を待つ(既定 false)' },
        timeout_ms: { type: 'number', description: 'wait の上限(ミリ秒、既定30000、上限300000)' },
      },
      required: ['job_id'],
    },
    async execute(args, ctx) {
      const id = requireString(args.job_id, 'job_id');
      const wait = args.wait === true;
      const timeoutRaw = args.timeout_ms;
      const timeout = timeoutRaw === undefined ? 30_000
        : typeof timeoutRaw === 'number' && Number.isSafeInteger(timeoutRaw) && timeoutRaw > 0 && timeoutRaw <= 300_000 ? timeoutRaw
        : null;
      if (timeout === null) throw new ToolError('INVALID_ARGS', 'timeout_ms は1〜300000の整数で指定する');
      if (wait) await jobs.wait(id, timeout, ctx.signal);
      const read = jobs.read(id);
      const parts = [statusLine(read.job)];
      if (read.dropped > 0) parts.push(`[前回の読み取り位置より古い出力 ${read.dropped} 文字は保持上限を超えて破棄された]`);
      if (read.stdout) parts.push(`--- stdout ---\n${read.stdout}`.trimEnd());
      if (read.stderr) parts.push(`--- stderr ---\n${read.stderr}`.trimEnd());
      if (!read.stdout && !read.stderr) parts.push(wait ? '(新しい出力なし)' : '(まだ出力なし)');
      return parts.join('\n');
    },
  };

  const list: Tool = {
    name: 'job_list',
    readOnly: true,
    description: 'バックグラウンドジョブの一覧と状態を返す。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const views = jobs.list();
      if (views.length === 0) return '(実行中のジョブはない)';
      return views.map(view => {
        const head = `${view.id}  ${view.kind}  ${view.status}  ${view.label}`;
        return view.detail ? `${head}  [${view.detail}]` : head;
      }).join('\n');
    },
  };

  const kill: Tool = {
    name: 'job_kill',
    description: 'バックグラウンドジョブを停止する。停止の確認まで待ってから結果を返す。',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '停止するジョブ' },
        reason: { type: 'string', description: '停止する理由(記録用)' },
      },
      required: ['job_id'],
    },
    async execute(args) {
      const id = requireString(args.job_id, 'job_id');
      const reason = optionalString(args.reason, 'reason', 200);
      const started = await jobs.kill(id, reason);
      // Report the settled state, not just the request: a kill that silently failed is worse
      // than no kill, because the human believes the work stopped.
      const deadline = Date.now() + 5000;
      for (;;) {
        const view = jobs.get(id);
        if (!view) throw new ToolError('NOT_EXECUTED', `不明なジョブ: ${id}`);
        if (view.status !== 'running' && view.status !== 'stopping') {
          const read = jobs.read(id);
          const parts = [statusLine(view)];
          if (read.stdout) parts.push(`--- stdout ---\n${read.stdout}`.trimEnd());
          if (read.stderr) parts.push(`--- stderr ---\n${read.stderr}`.trimEnd());
          return parts.join('\n');
        }
        if (Date.now() > deadline) {
          throw new ToolError('ABORTED', `停止を要求したが、確認できないまま時間切れ: ${id}(status=${view.status})`);
        }
        await jobs.wait(id, 100);
      }
      void started;
    },
  };

  return [output, list, kill];
}

export { describeShellResult };
