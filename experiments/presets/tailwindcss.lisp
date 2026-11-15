(in-package :modkh)

(defmicroagent micro-tailwindcss-hover
  :title "tailwindcss hover"
  :tool "code_hover"
  :language "tailwindcss" :task-kind "hover"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-tailwindcss-diagnostics
  :title "tailwindcss diagnostics"
  :tool "code_diagnostics"
  :language "tailwindcss" :task-kind "diagnostics"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-tailwindcss-edit
  :title "tailwindcss edit"
  :tool "edit_file" :workflow "edit-verify"
  :language "tailwindcss" :task-kind "edit"
  :instruction "指定ソースだけを修正し、受入テストや設定を変更しない。"
  :max-turns 8)

; Editors remain disabled until set-agent-check supplies command and owner manifest.
