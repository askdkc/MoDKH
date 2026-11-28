---
name: cyber
description: MoDKH の /cyber で、指定した URL の DNS・ポート・TLS・HTTP 応答や各種脆弱性を点検し、任意で対応するソースの依存関係・コード・秘密情報も点検する。
---

# /cyber

MoDKH の入力欄で `/cyber <URL>` を実行すると、その URL を対象に次の順で点検する。承認画面にはクエリを伏せた URL、接続するポート、実行する検査、起動しない検査を表示する。接続先は指定したホストだけで、リダイレクトは追跡しない。

## 1. ソース・依存関係・秘密情報を調べる

MacやCIで、本番にデプロイしたコミットのリポジトリルートから実行する。結果はリポジトリ外に保存する。

```bash
umask 077
out=$(mktemp -d "$HOME/security-audit.XXXXXX")
printf '保存先: %s\n' "$out"

trivy fs --scanners vuln,misconfig . > "$out/trivy.txt"
osv-scanner scan source -r . > "$out/osv.txt"
semgrep scan --config p/php --config p/javascript --metrics=off . > "$out/semgrep.txt"
gitleaks git --redact=100 . > "$out/gitleaks-history.txt" 2>&1
gitleaks dir --redact=100 . > "$out/gitleaks-files.txt" 2>&1
```

- **Trivy / OSV-Scanner**：`composer.lock` や `package-lock.json` から既知CVEを調べる。TrivyはDockerfile等の設定も検査する。コンテナ運用では、実際にデプロイしたイメージのダイジェストを指定し、`trivy image --scanners vuln IMAGE@sha256:DIGEST` も実行する。
- **Semgrep**：危険な実装候補を調べる。**Gitleaks**：Git履歴と現在のファイルを別々に確認する。Git履歴の検査範囲は手元に取得した履歴まで。実際のキーが見つかったら先に失効・再発行する。
- 検出ゼロとスキャン失敗を混同しない。終了コード、警告、期待したロックファイルやソースが検査対象になったかを確認する。
- ホストOSは別確認。RHELでは `sudo dnf --refresh updateinfo list --updates --security` で未適用のセキュリティ更新を確認し、Ubuntu/RHELとも、個別CVEはベンダーの情報とインストール済みパッケージを照合する。上流の版番号だけで判定しない。

## 2. 不要なポートが開いていないか確認する

**Linuxサーバー上**で待ち受けアドレス、ポート、プロセスを確認する。

```bash
sudo ss -lntup
```

**別マシン**から、自分のサーバーのIPを1台ずつ確認する。公開側はVPNを通らない外部回線から、LAN・Tailscale側はそれぞれの経路から実行し、結果を別名で保存する。CDNの共有IPはオリジンの代わりに検査しない。以下は手順1と同じシェルを想定。別シェルなら先に `out` を設定する。

```bash
target='203.0.113.10'  # 自分のサーバーのIPに変更
scope='internet-ipv4' # 経路ごとに変更
nmap -n -Pn -sT -p- --max-rate 50 --reason \
  -oN "$out/ports-${scope}-tcp.txt" "$target"
```

- `-p-` はTCP全ポート。IPv6を公開していれば `-6` を付け、IPv6アドレスも別に検査する。
- UDPは別途確認する。待ち受けやFWで気になるポートだけを選ぶ。例：DNSとHTTP/3を確認するなら `sudo nmap -n -Pn -sU -p 53,443 --max-rate 10 --reason "$target"`。`open|filtered` は開いていると確定したわけではない。
- **公開してよいポートを先に決める。** 例：443は公開、80はHTTPS転送用なら公開、22は管理網のみ。5432（PostgreSQL）、6379（Redis）、9200（Elasticsearch）、9000（PHP-FPM）、8888（AI API）が想定外の経路から `open` なら優先して確認する。
- 不要サービスは停止。必要な内部サービスは待ち受け先、FW、クラウド側の許可ルール、ポート転送を見直す。変更後は**同じ接続元**から再検査し、閉じたいポートが到達不能になり、必要なサービスは使えることを確認する。

## 3. ステージングでWeb設定とSQLの扱いを確認する

**Nikto**は設定不備・デフォルトファイルの検査に限定する。実ユーザーのCookieや実データは使わない。応答遅延や5xxが増えたら中止する。制限時間に達した結果は未完了として扱う。

```bash
nikto -h 'https://staging.example.com' -Tuning 2 \
  -Pause 1 -maxtime 5m -Format txt -output "$out/nikto.txt"
```

**SQLインジェクション**：稼働先に対する `sqlmap` の実施をする。

## 4. 修正後に再検査する

対象、接続元、日時、デプロイ版、検出・修正内容、再検査結果を記録する。スキャン結果を公開せず、疑わしい検出は実際の設定・パッケージ・コードで裏づけを取る。

参考：[Trivy](https://trivy.dev/docs/latest/guide/target/filesystem/)・[OSV-Scanner v2](https://google.github.io/osv-scanner/usage/scan-source)・[Semgrep](https://docs.semgrep.dev/cli-reference)・[Gitleaks](https://github.com/gitleaks/gitleaks#readme)・[Nmap](https://nmap.org/book/man-port-specification.html)・[Nikto](https://www.cirt.net/nikto2-docs/options.html)・[sqlmap](https://github.com/sqlmapproject/sqlmap/wiki/usage)
