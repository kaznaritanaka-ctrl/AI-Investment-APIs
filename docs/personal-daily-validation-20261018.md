# 日次履歴・Cloudflare → NAS synthetic検証

2026-10-18、branch `codex/public-gpu-private-research-20261018`、base HEAD `560c872289ad0e9cb0253175918f59d2e29417ba`。先行の未コミットCloud/NAS実装を保持した上での追加変更。対象は[日次実装](personal-daily-cloud-nas-20261018.md)。実収集・実鍵・実NAS・本番変更なし。

## 実行結果

| 検査 | 結果 |
|---|---|
| `pnpm check` | 成功。format/TypeScript/公開private境界・source grant・fixture検査 |
| 全件 `pnpm test` | **41ファイル・392件成功、失敗0・skip 0**。1149.77秒（約19分10秒）。今回追加の12件も含む |
| `pnpm test:runtime` | 5runner成功。既存FX/Models/GPU、personal、continuing、初回Cloud、日次Cloud。最終監視修正後の日次runner単独再実行も成功 |
| `pnpm build` | Collector/API両方のWrangler dry-run成功。最終コードで再確認。deployなし |
| offline preflight | errors/blockers空、networkなし。既存設定に対する検査であり、新しい日次契約の本番有効化承認ではない |
| generate / diff | source/research schema・OpenAPIの再生成差分なし。`git diff --check` 成功 |
| NAS CLI | daily-plan成功、disabled設定のdaily-onceは通信前に拒否（期待したexit 1） |

既存通知先未設定・外部監視未接続はpreflightのpendingとして残る。Wrangler、active source/grants、deployment、旧migration0001〜0012、public migration、package/lockfileは変更なし。新規0013のみローカル追加・適用検証。

全件記録はignored `work/daily-full-test.json`。最終コードでの追加9件（日次・migration・監視）と3件（NAS）を含めて完走した。これはcommit前の作業ツリーでのローカル結果であり、GitHub CIの結果や本番受入を表すものではない。公開後のCI結果はPR #18の対象commitに紐づくchecksを参照する。

## 追加検証範囲

- populated 0012から0013への前進migration、旧観測不変・FK・immutable trigger。
- source/UTC日1試行、同時起動、契約更新でも同日再取得禁止、同価格の翌日再観測、欠測日の補間禁止。
- flag OFF、productionとsyntheticの境界、resource/hash pin、public capability拒否。
- scheduled dispatchのsource別失敗分離、新規取得OFFでの保守、空DB復元によるR2 catalog巻戻し拒否。
- stale/missing/改ざん/巻戻しreceiptは取得前に停止。NAS正常復旧時に古い観測日だけで永久停止しない。
- 429のsource-wide Retry-After、保存済み証拠からの復旧、証拠期限切れや予約後中断の自動失敗確定。失敗件数を0にしない。
- 複数run export、11年後の履歴保持、backup世代の期限、取消しの削除。
- age実バイナリとsynthetic鍵による暗号化・復号・ローカルD1復元。暗号文破損、catalog page欠落、非連続pageの走査、複数runのcheckpoint復元。
- health送信は別bucket固定PUT・明示opt-in・最小schema、data readerはGET-only。バックアップ失敗時にも署名付き失敗receipt。未知のbodyを送信前に拒否。
- workerd内で40日・40run・80観測、mock GET 120回、分割catalog、SQL batch最大20、80回に分けた処理。1回の巨大transactionは使わない。

## 全テストが完了しなかった原因と対処

先行調査は[前回の記録](personal-cloud-nas-validation-20261018.md)を参照。Windowsの逐次Node/workerd RPCによるModels/recoveryの30秒超過、checkout所有者に伴うGit safe.directory拒否、古い「Collectorにpersonalコード不可」境界テストが原因だった。該当試験だけの120秒timeout・process限定safe.directory・新しいOFF境界の検証に変更済み。既定serial設定、本番timeout、assertionは緩めていない。

今回も依存関係がlockfile通り揃った状態で、pnpm事前installを抑制し、テストファイル2並列・verbose・JSON記録で実行する。個々のテスト用DBは独立している。全件終了待ちとハングを区別できるようにした。グローバルGit設定は変更しない。

```powershell
pnpm.cmd --config.verify-deps-before-run=false test --fileParallelism --maxWorkers=2 --reporter=verbose --reporter=json --outputFile=work/daily-full-test.json
```

今回の直接runtime診断では、Windows既定Tempの長いパスでMiniflare R2初期化が失敗した。通常の `scripts/run.mjs` が設定するrepo内 `work/tmp` を使って再実行する。これはprovider通信障害ではない。また、INSERT OR IGNOREでSQLiteのordinalが再実行ごとに消費されることを検出した。不要なINSERTをWHERE NOT EXISTSで抑え、catalogは欠番があっても明示page一覧で辿るようにした。連番の仮定で成功を判定しない。

## 非実施・未確認

Cloudflare実行、remote migration、実ソースHTTP、grant変更、実鍵生成/設定、実NASのmount/ACL/timer変更、通知送信は実施していない。Highreso/Rebroの実観測0件。schema 0013と新flag/bindingは本番に未適用。

本番CPU・10年間の実容量、NAS実機権限/復旧鍵、external deadman通知、remote D1復元/本番昇格、Linux CIの新結果は未検証。synthetic成功を本番稼働と記載しない。
