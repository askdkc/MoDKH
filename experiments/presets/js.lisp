(in-package :dkh)

(defmicroagent micro-js-outline
  :title "js outline"
  :tool "code_outline"
  :language "js" :task-kind "outline"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-js-definition
  :title "js definition"
  :tool "code_definition"
  :language "js" :task-kind "definition"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-js-references
  :title "js references"
  :tool "code_references"
  :language "js" :task-kind "references"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-js-diagnostics
  :title "js diagnostics"
  :tool "code_diagnostics"
  :language "js" :task-kind "diagnostics"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-js-edit
  :title "js edit"
  :tool "edit_file" :workflow "edit-verify"
  :language "js" :task-kind "edit"
  :instruction "指定ソースだけを修正し、受入テストや設定を変更しない。"
  :max-turns 8)

; Editors remain disabled until set-agent-check supplies command and owner manifest.
