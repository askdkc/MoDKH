import { realpathSync } from 'node:fs';
import type { Session, SessionStore } from '../session/store.ts';
import type { LiteConfig } from './config.ts';

export function selectInitialConnection(
  args: Readonly<Record<string, string | undefined>>,
  config: Pick<LiteConfig, 'model' | 'modelBaseUrl'>,
  session?: Pick<Session, 'model' | 'modelBaseUrl'>,
): { model: string | undefined; baseUrl: string | undefined } {
  const savedModel = typeof config.model === 'string' ? config.model : undefined;
  const savedUrl = typeof config.modelBaseUrl === 'string' && config.modelBaseUrl.length > 0
    ? config.modelBaseUrl : undefined;
  const resumedModel = session?.model === 'unconnected' ? undefined : session?.model;
  const explicitModel = args.model;
  const model = explicitModel ?? resumedModel ?? savedModel;
  const baseUrl = args['base-url'] ?? (resumedModel && !explicitModel
    ? session?.modelBaseUrl ?? (resumedModel === savedModel ? savedUrl : undefined)
    : !explicitModel || explicitModel === savedModel ? savedUrl : undefined);
  return { model, baseUrl };
}

export function loadResumedSession(store: SessionStore, id: string, cwd: string): Session {
  const session = store.load(id);
  if (realpathSync(session.cwd) !== realpathSync(cwd)) {
    throw new Error(`セッションの作業ルートが異なる: ${session.cwd} → ${cwd}。元のルートで再開するか新規セッションを使う`);
  }
  return session;
}
