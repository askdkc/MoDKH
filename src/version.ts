import manifest from '../package.json' with { type: 'json' };

/** アプリケーション版。CLIの表示と、プロバイダーへ送る user-agent の両方で使う。 */
export const APP_VERSION = manifest.version;
