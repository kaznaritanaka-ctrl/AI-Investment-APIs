# Cloudflare → NAS ローカルsynthetic検証結果

2026-10-18。branch `codex/public-gpu-private-research-20261018`、base HEAD `560c872289ad0e9cb0253175918f59d2e29417ba` 上の未コミット変更。実装と受入範囲は [実装資料](personal-cloud-nas-implementation-20261018.md) を参照。

## 結果

| 検査 | 結果 |
|---|---|
| `pnpm check` | 成功。format、TypeScript、public/private境界・source grant・fixture混入検査 |
| 全件 `pnpm test` | **39ファイル、380件成功、失敗0、skip 0**。1013.13秒 |
| 最終NAS変更後の対象再実行 | `tests/personal-nas.test.ts` **5件成功**、53.67秒。処理途中の取消しも永続化し、marker消失後の再開を拒否 |
| `pnpm test:runtime` | 成功。既存FX／Models／GPU、private GPU、personal v1、continuing、Cloud版の全runner |
| `pnpm build` | Collector/API両方 `wrangler deploy --dry-run` 成功。deployなし |
| offline preflight | `static_valid=true`、`errors=[]`、`blockers=[]`、networkなし。既存の通知先／外部監視未接続等はpendingのまま |
| generateと差分確認 | source/research schema、OpenAPI再生成差分なし、`git diff --check` 成功 |
| NAS CLI | offline plan成功。disabled設定によるonce／restoreは期待どおり拒否。通信・実NAS書込みなし |

全件実行には対象checkoutだけのprocess-local Git safe.directoryを設定し、既にlockfile依存が揃った状態でpnpmの事前installを抑制した。コマンド本体は以下。既定のserial Vitest設定は変更していない。

```powershell
pnpm.cmd --config.verify-deps-before-run=false test --fileParallelism --maxWorkers=2 --reporter=verbose --reporter=json --outputFile=work/personal-cloud-nas-full-test.json
```

JSON結果はignored `work/personal-cloud-nas-full-test.json`。最後のNAS変更は全件実行後に同じ5試験を再実行し、checkも再実行した。Linux CI・NAS実機・本番Cloudflareの実行結果ではない。

## 全件が終わらなかった原因

1. WindowsのNode→workerd間の逐次RPCが累積し、Models.devの複数日試験が30秒を超えた。実測で約35〜52秒。該当describeとrecoveryの1試験だけ120秒に変更し、assertionは維持した。本番CPUやHTTP timeoutは変更していない。
2. checkout所有者と実行ユーザーの相違で `admin-release` 内のgitが拒否された。この絶対パスだけを子プロセスのsafe.directoryへ設定して解消。グローバルGit設定は無変更。
3. Cloud対応前のboundary試験はCollectorへのpersonalコード同梱を禁止していた。新しい要件に合わせ、APIへのpersonal混入禁止、両WorkerへのNAS/localコード混入禁止、Collectorの未有効化を検証する形に更新した。

最初のserial診断は33分25秒で完了し、上記2・3とrecovery timeoutの計3件が失敗した。Models.dev timeoutはその前の単独診断で再現済み。verboseにより、停止と長いファイル完了待ちを区別できた。pnpmの事前installや診断用 `--input-type=module -e` 起動のMiniflare待機も、製品・通常testの停止と分けて調査した。

## 検証した動作

- 2sourceの初回dispatchは別flagと24時間窓が必須。再実行でもmock HTTPは増えず、別契約IDやDB復元でもsourceの一回制限は戻らない。
- 正規化履歴は11年後も保持し、review更新後に元の履歴を含む新規snapshotを作成する。世代期限を履歴TTLに転用しない。
- export中断／再開、完成manifestだけの受入、期限付き世代削除、最新review・取消し・削除の独立保持。
- age実バイナリによるsynthetic鍵での暗号化／復号、D1への実復元、FK・整合性・append-only、staging再起動後の残存と上書き拒否。
- stale／欠落／malformed／partial／429、暗号文改ざん、source別失敗分離、処理途中の取消しと後続の巻戻し拒否。
- 通常test/runtimeでは外部source HTTP、Cloudflare API、NASへの通信なし。

## 変更しなかった対象

Wrangler2設定、deployment、active source/grants、SQL migrations、package/lockfile、Cron、公開API仕様は差分なし。実データ取得、実鍵設定、実NAS変更、Cloudflare resource作成、remote migration、deploy、権利grant変更は行っていない。新しいフラグとNAS設定は未有効化。鍵は試験用のみで運用転用しない。

初回一run・48観測の保守／復元基盤の受入であり、継続的な日次新規取得、複数runの大規模export、NAS実機ACL、外部死活監視、remote D1への復旧完了を表すものではない。
