(in-package :dkh)

(defmicroagent micro-php-outline
  :title "php outline"
  :tool "code_outline"
  :language "php" :task-kind "outline"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-php-definition
  :title "php definition"
  :tool "code_definition"
  :language "php" :task-kind "definition"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-php-references
  :title "php references"
  :tool "code_references"
  :language "php" :task-kind "references"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-php-diagnostics
  :title "php diagnostics"
  :tool "code_diagnostics"
  :language "php" :task-kind "diagnostics"
  :instruction "指定対象を実ツールで調べ、根拠と未確認事項を返す。"
  :max-turns 4)

(defmicroagent micro-php-edit
  :title "php edit"
  :tool "edit_file" :workflow "edit-verify"
  :language "php" :task-kind "edit"
  :instruction "指定ソースだけを修正し、受入テストや設定を変更しない。"
  :max-turns 8)

; Editors remain disabled until set-agent-check supplies command and owner manifest.
