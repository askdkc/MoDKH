(in-package :dkh)

(defmicroagent micro-ts-outline
  :title "ts outline"
  :tool "code_outline"
  :language "ts" :task-kind "outline"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-ts-definition
  :title "ts definition"
  :tool "code_definition"
  :language "ts" :task-kind "definition"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-ts-references
  :title "ts references"
  :tool "code_references"
  :language "ts" :task-kind "references"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-ts-diagnostics
  :title "ts diagnostics"
  :tool "code_diagnostics"
  :language "ts" :task-kind "diagnostics"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-ts-edit
  :title "ts edit"
  :tool "edit_file" :workflow "edit-verify"
  :language "ts" :task-kind "edit"
  :instruction "指定ソースだけを修正し、受入テストや設定を変更しない。"
  :max-turns 8)

; Editors remain disabled until set-agent-check supplies command and owner manifest.
