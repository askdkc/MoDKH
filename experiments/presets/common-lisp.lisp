(in-package :dkh)

(defmicroagent micro-common-lisp-outline
  :title "common-lisp outline"
  :tool "code_outline"
  :language "common-lisp" :task-kind "outline"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-common-lisp-definition
  :title "common-lisp definition"
  :tool "code_definition"
  :language "common-lisp" :task-kind "definition"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-common-lisp-references
  :title "common-lisp references"
  :tool "code_references"
  :language "common-lisp" :task-kind "references"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-common-lisp-diagnostics
  :title "common-lisp diagnostics"
  :tool "code_diagnostics"
  :language "common-lisp" :task-kind "diagnostics"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-common-lisp-edit
  :title "common-lisp edit"
  :tool "edit_file" :workflow "edit-verify"
  :language "common-lisp" :task-kind "edit"
  :instruction "指定ソースだけを修正し、受入テストや設定を変更しない。"
  :max-turns 8)

; Editors remain disabled until set-agent-check supplies command and owner manifest.
