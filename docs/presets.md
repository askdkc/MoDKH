# Lispプリセット

[プリセット一覧](../experiments/presets/)から使う言語のファイルを選びます。SBCLを用意し、ファイルを置いたプロジェクトで実行します。以下はリポジトリのルートでTypeScript用を使う例です。

```sh
less experiments/presets/ts.lisp
shasum -a 256 experiments/presets/ts.lisp
modkh chat --lisp-config experiments/presets/ts.lisp --trust-lisp-sha256 REVIEWED_SHA256
```

Lispファイルはコードとして実行されます。内容を確認し、表示されたSHA-256を `REVIEWED_SHA256` に入れます。ファイルを変更したら確認とハッシュ計算をやり直します。

チャットで `/agents` を開くと担当を確認できます。たとえば `/agents route ts outline Inspect src/index.ts` で構造調査を委譲できます。

## どんなときに役立つか

定義や参照の検索、診断などを専用ツール付きの担当に切り出せます。対応する言語サーバーが必要な操作もあります。編集は対象ファイルと固定の検証コマンドを設定したときだけ有効になります。通常のチャットと比べた速度やトークン消費の改善幅は未計測です。

[編集・検証の設定](modkh.md) · [言語解析](languages.md)
