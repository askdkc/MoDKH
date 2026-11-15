(in-package :dkh)
(defmicroagent micro-zenki :title "前鬼" :tool "verify_tla"
  :language "tla" :task-kind "verify" :max-turns 4
  :instruction "指定モデルと設定をTLCで検査し、有限探索範囲・不変条件・反例・制約を返す。実装との等価性は別問題。")
(defmicroagent micro-goki :title "後鬼" :tool "verify_lean"
  :language "lean" :task-kind "verify" :max-turns 4
  :instruction "Lean受理と対象定理の妥当性を区別する。PROOF_UNVERIFIEDを証明成功と報告しない。")
