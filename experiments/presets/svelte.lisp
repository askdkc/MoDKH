(in-package :dkh)

(defmicroagent micro-svelte-outline
  :title "svelte outline"
  :tool "code_outline"
  :language "svelte" :task-kind "outline"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-svelte-definition
  :title "svelte definition"
  :tool "code_definition"
  :language "svelte" :task-kind "definition"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-svelte-references
  :title "svelte references"
  :tool "code_references"
  :language "svelte" :task-kind "references"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-svelte-diagnostics
  :title "svelte diagnostics"
  :tool "code_diagnostics"
  :language "svelte" :task-kind "diagnostics"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-svelte-edit
  :title "svelte edit"
  :tool "edit_file" :workflow "edit-verify"
  :language "svelte" :task-kind "edit"
  :instruction "指定ソースだけを修正し、受入テストや設定を変更しない。"
  :max-turns 8)

; Editors remain disabled until set-agent-check supplies command and owner manifest.
