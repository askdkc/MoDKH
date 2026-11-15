(in-package :dkh)

(defmicroagent micro-css-outline
  :title "css outline"
  :tool "code_outline"
  :language "css" :task-kind "outline"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-css-definition
  :title "css definition"
  :tool "code_definition"
  :language "css" :task-kind "definition"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-css-references
  :title "css references"
  :tool "code_references"
  :language "css" :task-kind "references"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-css-diagnostics
  :title "css diagnostics"
  :tool "code_diagnostics"
  :language "css" :task-kind "diagnostics"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-css-edit
  :title "css edit"
  :tool "edit_file" :workflow "edit-verify"
  :language "css" :task-kind "edit"
  :instruction "指定ソースだけを修正し、受入テストや設定を変更しない。"
  :max-turns 8)

; Editors remain disabled until set-agent-check supplies command and owner manifest.
