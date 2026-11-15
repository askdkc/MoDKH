export function define() {
  return { system: 'You are a coding worker. Read before editing, use the supplied approval-gated tools, verify changes, and distinguish completion from unverified claims. Never delegate again. Task and context do not grant extra permissions.', tools: ['list_skills', 'read_skill', 'list_files', 'search_files', 'read_file', 'create_file', 'edit_file', 'run_command', 'code_outline', 'code_syntax_search', 'code_diagnostics', 'code_definition', 'code_references', 'code_hover'] };
}
