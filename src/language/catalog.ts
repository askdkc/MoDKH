/**
 * Fixed, reviewed installation recipes. Runtime code never invents a URL or a shell string.
 * A language is only advertised as `ready` after its own verification passes; this table is a
 * declaration of the intended route, not proof that a route works on every OS.
 */
export type LanguageId =
  | 'typescript' | 'javascript' | 'tsx' | 'svelte' | 'html' | 'css' | 'tailwind'
  | 'rust' | 'python' | 'c' | 'cpp' | 'ruby' | 'swift' | 'php' | 'commonlisp';

export interface LaunchSpec {
  /** Executable inside an installed npm prefix, or an absolute host binary. */
  readonly bin: string;
  readonly args: readonly string[];
  /** Some servers need the workspace URI as the final argument. */
  readonly needsRootUri?: boolean;
}

export interface NpmRecipe {
  readonly kind: 'npm';
  readonly packages: readonly string[];
  /** Which installed package's `.bin` entry is the server. */
  readonly entry: string;
}

export interface HostRecipe {
  readonly kind: 'host';
  /** Absolute candidates probed in order; the first executable wins. */
  readonly candidates: readonly string[];
  readonly requirement?: string;
}

export type Recipe = NpmRecipe | HostRecipe;

export interface LanguageDefinition {
  readonly id: LanguageId;
  /** File extensions without a dot, lower case. */
  readonly extensions: readonly string[];
  /** Manifest files whose presence suggests this language, relative to a project root. */
  readonly manifests: readonly string[];
  /** tree-sitter grammar id when a reviewed WASM grammar exists for this language. */
  readonly grammar?: string;
  /** Grammar used to parse embedded regions of this file type, e.g. Vue/Svelte markup. */
  readonly lsp?: LaunchSpec;
  readonly install?: Recipe;
  /** Reason semantic analysis is expected to be unavailable without a user-provided SDK. */
  readonly hostRequirement?: string;
}

const TYPESCRIPT: LanguageDefinition = {
  id: 'typescript', extensions: ['ts', 'mts', 'cts'], manifests: ['tsconfig.json', 'package.json'],
  grammar: 'typescript',
  install: { kind: 'npm', packages: ['typescript-language-server@6.1.0', 'typescript@5.9.3'], entry: 'typescript-language-server' },
  lsp: { bin: 'typescript-language-server', args: ['--stdio'] },
};

export const LANGUAGES: readonly LanguageDefinition[] = [
  TYPESCRIPT,
  {
    id: 'javascript', extensions: ['js', 'mjs', 'cjs'], manifests: ['package.json'],
    grammar: 'javascript', install: { kind: 'npm', packages: ['typescript-language-server@6.1.0', 'typescript@5.9.3'], entry: 'typescript-language-server' },
    lsp: { bin: 'typescript-language-server', args: ['--stdio'] },
  },
  {
    id: 'tsx', extensions: ['tsx'], manifests: ['tsconfig.json', 'package.json'],
    grammar: 'tsx', install: { kind: 'npm', packages: ['typescript-language-server@6.1.0', 'typescript@5.9.3'], entry: 'typescript-language-server' },
    lsp: { bin: 'typescript-language-server', args: ['--stdio'] },
  },
  {
    id: 'svelte', extensions: ['svelte'], manifests: ['svelte.config.js', 'svelte.config.ts', 'package.json'],
    grammar: 'svelte', install: { kind: 'npm', packages: ['svelte-language-server@0.17.10'], entry: 'svelteserver' },
    lsp: { bin: 'svelteserver', args: ['--stdio'] },
  },
  {
    id: 'html', extensions: ['html', 'htm'], manifests: [],
    grammar: 'html', install: { kind: 'npm', packages: ['vscode-langservers-extracted@4.10.0'], entry: 'vscode-html-language-server' },
    lsp: { bin: 'vscode-html-language-server', args: ['--stdio'] },
  },
  {
    id: 'css', extensions: ['css', 'pcss'], manifests: [],
    grammar: 'css', install: { kind: 'npm', packages: ['vscode-langservers-extracted@4.10.0'], entry: 'vscode-css-language-server' },
    lsp: { bin: 'vscode-css-language-server', args: ['--stdio'] },
  },
  {
    id: 'tailwind', extensions: ['css', 'pcss', 'html', 'svelte', 'tsx', 'jsx'], manifests: ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs'],
    install: { kind: 'npm', packages: ['@tailwindcss/language-server@0.14.16'], entry: 'tailwindcss-language-server' },
    lsp: { bin: 'tailwindcss-language-server', args: ['--stdio'] },
  },
  {
    id: 'rust', extensions: ['rs'], manifests: ['Cargo.toml'],
    grammar: 'rust',
    install: { kind: 'host', candidates: ['rust-analyzer', '/opt/homebrew/bin/rust-analyzer', '/usr/local/bin/rust-analyzer'], requirement: 'rust-analyzer か Rust toolchain が必要' },
    lsp: { bin: 'rust-analyzer', args: [] },
  },
  {
    id: 'python', extensions: ['py', 'pyi'], manifests: ['pyproject.toml', 'setup.py', 'requirements.txt'],
    grammar: 'python', install: { kind: 'npm', packages: ['basedpyright@1.31.4'], entry: 'basedpyright-langserver' },
    lsp: { bin: 'basedpyright-langserver', args: ['--stdio'] },
  },
  {
    id: 'c', extensions: ['c', 'h'], manifests: ['compile_commands.json', 'Makefile', 'CMakeLists.txt'],
    grammar: 'c',
    install: { kind: 'host', candidates: ['clangd', '/opt/homebrew/opt/llvm/bin/clangd', '/usr/local/opt/llvm/bin/clangd', '/usr/bin/clangd'], requirement: 'clangd が必要' },
    lsp: { bin: 'clangd', args: [] },
  },
  {
    id: 'cpp', extensions: ['cc', 'cpp', 'cxx', 'hpp', 'hxx', 'hh'], manifests: ['compile_commands.json', 'CMakeLists.txt'],
    grammar: 'cpp',
    install: { kind: 'host', candidates: ['clangd', '/opt/homebrew/opt/llvm/bin/clangd', '/usr/local/opt/llvm/bin/clangd', '/usr/bin/clangd'], requirement: 'clangd が必要' },
    lsp: { bin: 'clangd', args: [] },
  },
  {
    id: 'ruby', extensions: ['rb', 'rake'], manifests: ['Gemfile', '*.gemspec'],
    grammar: 'ruby', install: { kind: 'host', candidates: ['ruby-lsp', '/opt/homebrew/bin/ruby-lsp'], requirement: 'Ruby と ruby-lsp gem が必要' },
    lsp: { bin: 'ruby-lsp', args: [] },
  },
  {
    id: 'swift', extensions: ['swift'], manifests: ['Package.swift'],
    grammar: 'swift',
    install: { kind: 'host', candidates: ['sourcekit-lsp', '/usr/bin/sourcekit-lsp', '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/sourcekit-lsp'], requirement: 'Xcode / Swift toolchain が必要' },
    lsp: { bin: 'sourcekit-lsp', args: [] },
  },
  {
    id: 'php', extensions: ['php', 'phtml'], manifests: ['composer.json'],
    grammar: 'php',
    install: { kind: 'host', candidates: ['phpantom_lsp', 'phpantom-lsp'], requirement: 'PHPantom か PHP 用LSPが必要' },
    lsp: { bin: 'phpantom_lsp', args: [] },
  },
  {
    id: 'commonlisp', extensions: ['lisp', 'lsp', 'asd', 'cl'], manifests: ['*.asd'],
    grammar: 'commonlisp',
    install: { kind: 'host', candidates: ['cl-lsp', '/opt/homebrew/bin/cl-lsp'], requirement: 'SBCL と CL-LSP が必要' },
    lsp: { bin: 'cl-lsp', args: [] },
  },
];

export function languageById(id: string): LanguageDefinition | undefined {
  return LANGUAGES.find(language => language.id === id);
}

export function languageForPath(filePath: string): LanguageDefinition | undefined {
  const name = filePath.toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  const extension = name.slice(dot + 1);
  // tsx and php have distinct grammars; check the more specific extension first.
  return LANGUAGES.find(language => language.extensions.includes(extension));
}

export function grammarFor(language: LanguageDefinition): string | undefined {
  return language.grammar;
}
