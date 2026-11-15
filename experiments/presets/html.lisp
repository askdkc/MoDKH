(in-package :dkh)

(defmicroagent micro-html-outline
  :title "html outline"
  :tool "code_outline"
  :language "html" :task-kind "outline"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-html-definition
  :title "html definition"
  :tool "code_definition"
  :language "html" :task-kind "definition"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-html-references
  :title "html references"
  :tool "code_references"
  :language "html" :task-kind "references"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-html-diagnostics
  :title "html diagnostics"
  :tool "code_diagnostics"
  :language "html" :task-kind "diagnostics"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-html-edit
  :title "html edit"
  :tool "edit_file" :workflow "edit-verify"
  :language "html" :task-kind "edit"
  :instruction "指定ソースだけを修正し、受入テストや設定を変更しない。"
  :max-turns 8)

; Editors remain disabled until set-agent-check supplies command and owner manifest.
