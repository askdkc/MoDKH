---
name: cyber
description: MoDKH の /cyber で指定した URL の TCP ポートと応答ヘッダーや、作業ディレクトリの依存関係、ソースコード、秘密情報を点検する。
---

# /cyber

MoDKH の入力欄に `/cyber https://example.com/app` と入力すると、Nmap がそのホストの IP アドレスを1つ使い、URL の TCP ポートへの接続状態を表示する。ポートを省略した場合は HTTP が80、HTTPS が443になる。続いて `curl` がその URL に HEAD リクエストを1回送り、HTTP ステータスと次の応答ヘッダーの有無を表示する。`/cyber tools <URL>` でも同じ検査を実行できる。

- Content-Security-Policy
- X-Content-Type-Options
- Referrer-Policy
- Strict-Transport-Security（HTTPS の場合。TLS 証明書の検証結果も表示する）

パスとクエリはリクエストに含める。3xx の場合は転送元の応答を表示する。HEAD に対応していない URL ではステータスとその旨を表示する。

引数なしの `/cyber` は、現在の作業ディレクトリで次のツールを実行する。

| ツール | 確認する項目 |
| --- | --- |
| Trivy | ローカルの依存関係に含まれる既知の脆弱性 |
| OSV-Scanner | 対応するロックファイルなどから特定できるパッケージの脆弱性 |
| Semgrep | p/default ルールに該当するソースコード |
| Gitleaks | 作業ツリー内の秘密情報。検出値は伏せ字にする |
| sqlmap、Nmap | インストール状況とバージョンのみ |

`/cyber tools` は上記のツールと curl のバージョンを表示する。個別に実行するときは `/cyber gitleaks` のように小文字の実行ファイル名を指定する。Trivy、OSV-Scanner、Semgrep はデータベースの取得・照会やルールの取得に通信する場合がある。

結果をまとめるときは、検出内容と対象ファイル、実行エラー、対象ファイルがなかった項目を分ける。HTML から読み込む CDN ライブラリは、依存関係のスキャンで網羅できない。検査件数と対象形式は各ツールの出力で確認する。
