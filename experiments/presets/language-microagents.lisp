(in-package :modkh)

; Add this roster to a reviewed head configuration, or use it on its own.
; IDs are formed as micro-<language>-<task-kind>.
(flet ((register-language-role (language label kind role-name tool instruction turns)
         (register-agent (format nil "micro-~a-~a" language kind)
                         :title (format nil "~a~a担当" label role-name)
                         :tool tool :language language :task-kind kind
                         :instruction instruction :max-turns turns)))
  (dolist (language '(("ts" "TypeScript")
                      ("js" "JavaScript")
                      ("php" "PHP")
                      ("common-lisp" "Common Lisp")
                      ("svelte" "Svelte")
                      ("html" "HTML")
                      ("css" "CSS")))
    (destructuring-bind (code label) language
      (dolist (role '(("outline" "構造" "code_outline" "指定ファイルの構造を取得し、主要な宣言と位置を返す。" 30)
                      ("definition" "定義" "code_definition" "指定位置の定義を探し、定義元と位置を返す。" 4)
                      ("references" "参照" "code_references" "指定位置のシンボルを参照している箇所を列挙し、位置と検索範囲を返す。" 4)
                      ("diagnostics" "診断" "code_diagnostics" "指定ファイルの診断を取得し、位置と重大度を返す。" 4)))
        (apply #'register-language-role code label role))
      (when (member code '("ts" "js" "php" "html" "css") :test #'string=)
        (register-language-role code label "syntax-search" "宣言検索" "code_syntax_search"
                                "指定ファイル一件で指定名をTree-sitterで検索し、各候補の宣言全体の範囲を返す。" 4))))
  (register-language-role "tailwindcss" "Tailwind CSS" "hover" "クラス情報" "code_hover"
                          "指定位置のクラス情報を取得し、根拠を返す。" 4)
  (register-language-role "tailwindcss" "Tailwind CSS" "diagnostics" "診断" "code_diagnostics"
                          "指定ファイルのTailwind CSS診断を取得し、位置と重大度を返す。" 4))
