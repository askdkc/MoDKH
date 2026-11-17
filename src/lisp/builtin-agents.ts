import { validateDefinitions, type SessionDefinition } from './config.ts';
import { sha256 } from './runtime.ts';

const LANGUAGES = ['php', 'common-lisp', 'js', 'ts', 'svelte', 'html', 'css'];
const OBSERVATION_TOOLS = {
  outline: 'code_outline',
  'syntax-search': 'code_syntax_search',
  definition: 'code_definition',
  references: 'code_references',
  diagnostics: 'code_diagnostics',
  hover: 'code_hover',
};

function observationRole(language: string, taskKind: keyof typeof OBSERVATION_TOOLS) {
  return {
    id: `micro-${language}-${taskKind}`,
    title: `${language} ${taskKind}`,
    language,
    'task-kind': taskKind,
    tool: OBSERVATION_TOOLS[taskKind],
    instruction: taskKind === 'syntax-search'
      ? `${language} の宣言検索担当。指定ファイル一件と宣言名を code_syntax_search に渡し、候補のファイルと宣言全体の範囲を返す。`
      : `${language} の ${taskKind} 担当。指定対象を実ツールで調べ、根拠と未確認事項を返す。`,
    enabled: true,
  };
}

let builtins: readonly SessionDefinition[] | undefined;

/** Use the same role validation and tool limits as explicitly configured Lisp agents. */
export function builtinMicroagents(): readonly SessionDefinition[] {
  if (builtins) return builtins;
  const roles = LANGUAGES.flatMap(language =>
    (['outline', 'definition', 'references', 'diagnostics'] as const).map(kind => observationRole(language, kind)));
  roles.push(...['php', 'js', 'ts', 'html', 'css'].map(language => observationRole(language, 'syntax-search')),
    observationRole('tailwindcss', 'hover'), observationRole('tailwindcss', 'diagnostics'));
  builtins = validateDefinitions(roles, '').map(({ descriptor, definition }) => ({
    descriptor: {
      ...descriptor, id: `modkh-${descriptor.id}`, version: 'builtin', builtin: true,
      digest: sha256(JSON.stringify({ descriptor, definition })),
    },
    definition,
  }));
  return builtins;
}
