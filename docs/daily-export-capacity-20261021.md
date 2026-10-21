# 日次exportの10年規模対応（2026-10-21 JST）

PR #19の`90ae31d`を基点に日次export容量を修正。今回の承認は実装・ローカルsynthetic・commit/push・CIまで。main merge、実収集、remote migration、deploy、通常grant、実鍵、NAS実機変更は行わない。私的研究例外とowner_continuing保存は承認済み。提供者許諾unconfirmed、source disabled、個人研究4flag/binding未設定、ECB・Models.dev・private PoCと既存Cronは不変。

## 処理と上限

`dailyScheduled → refreshDailyExports → projectDailyExports → NAS_EXPORT → NAS自動cycle → 署名receipt`。

- 最大24 idle枠/source/dayを維持。Models/GPU優先、初回・legacy retentionの枠、source HTTP予算は変更しない。生成/転送は各source最大4run・2MiB/回、2source逐次で最大8run・4MiB。snapshotは512KiB、partは128KiB×最大4のまま。巨大transactionを追加しない。
- 最大4runと1,025イベントを一括読取りし、期限登録/転送記録を最大4件のJSON SQLで処理。期限削除だけ最大8件。bulk生成は20秒経過で次runの開始を止め、個々の5分lease/CASと現在authority検査を維持する。これはCPU設定ではない。
- 未exportの新runを優先し、その後は最古の世代から更新。90日契約は30日以降を更新対象とするが、一周30日を保証しない。短い旧契約は`min(30,max(1,floor((retention_days-2)/2)))`日で対象になる。旧snapshot/hash/時刻/期限は延長しない。
- forward private **0016**でretry・転送待ち・期限索引を追加。0001〜0015と公開migrationは不変。失敗はrunごとに隔離し、1時間後に自動再試行。再起動後もD1/R2から継続。origin生成と投影を分離し、一方の失敗で他履歴を止めない。
- 転送済み記録は **NAS backup成功ではない**。part/snapshot hash、source/resource scope、現在authority/取消し/leaseを確認した投影だけ記録する。全control走査が終わるまでNAS gateを閉じ、10分read windowと48時間freshnessを維持。NASの実受入/inventory/復元には従来の署名receiptを用いる。
- 取得済みcatalog membershipを再利用し、runごとの全catalog走査を削減。部分R2復元の欠落pageは別cursorで1pageずつ修復。ordinal欠番やfailedをゼロ観測へ読み替えない。
- 世代作成**前**に期限索引を永続化。1回最大8世代を各7 origin key/4 export keyの固定キーで期限削除。途中失敗なら索引を残し冪等に再開する。巨大root走査に期限削除を依存させない。正規化履歴と現在control/取消しは削除しない。旧世代の従来走査cleanupも維持する。
- NASは最新run優先＋履歴最大19run/cycle、固定ceiling、日次の実復元検査を維持。scale試験と実clientで同じinventory slice・staging importを使う。本番へ自動昇格しない。

## 容量・監視

計画値は16/24 idle枠/day、新規1run/dayを差し引き63run/source/day。3,660runなら切上げ59日、一周＋NAS走査2日＋障害余裕7日で68日。永久停止や優先sourceが全枠を使う場合を保証しない。

private originの`personal-daily/<source>/export-capacity.json`に未export・未投影・origin/投影先の最早期限・直近7日投影量・確認時刻を記録する。`catching_up`、7日実測不足`throughput_warning`、期限7日以内/計画不足`deadline_risk`を区別。Collector metadata logにも状態codeを追加。public API/NAS allowlistへ本文を出さず、通知送信は追加しない。確認時刻が止まれば監視不能であり、過去のhealthyやHTTP応答で代用しない。履歴削除・TTL延長・日次手作業で容量不足を隠さない。

## Syntheticと実環境の区別

`tests/daily-export-capacity.test.ts`は実SQLiteのmigration/trigger/SQL＋条件付きR2 object doubleを使用。2source各3,660run（計7,320run、各1件の合成価格、v1/v2混在）から120日、16枠/day、4日全停止、230件の新規到着、契約hash更新、永続checkpoint再入を試験する。part/snapshot hash/schema、最新優先/固定ceiling、全7,550runの空SQLiteへの共通importと旧観測完全一致/FK/quick_checkを検証。未来年は合成時計であり実観測/実契約ではない。

開発試験は初回全履歴受入63日、最大再世代化間隔62.92日、生成/投影各14,848回。最終全件/CIで再確認し確定件数/URLはPR本文へ記録。これは実R2、実CPU、7,550回の実age暗号化、実NAS性能の試験ではない。scale側NASは共通inventory/hash/schema/importを使う合成受入器。実age暗号化・復号・staging復元・Linux lock/containerは既存NAS tests/CIで別検証する。

workerd runtimeは既存40日履歴と128価格枠を維持し、新しいJSON SQL、lease、queue、期限処理をD1/R2 bindingで検証。4run小分け生成/転送、128価格multipart v2を含む17runを確認する。source HTTPはmock、Cloudflare APIへ接続しない。

## 負荷・費用と本番受入

scaleはSQL/R2呼出し数と生成bytesを出力するが、Cloud CPU・D1 rows read・課金量とは扱わない。実有効化前に既存resume/report/取得を含む**同じinvocation全体**のCPU、D1 query/rows、R2操作/容量を測る。最大4runを常にFreeで実行できるとは主張しない。予算を超えれば有効化を止め、構成/プランを別承認へ戻す。Paidへ勝手に変更しない。

上限見積りは1世代`2×3,660×512KiB ≒3.57GiB`。originはsnapshot＋partsでその2倍、専用exportは同量、NASは暗号化1コピーで同量＋overhead。約63日更新で最大2世代が重なるケースはCloud合計約21.45GiB。idle枠が多く30日周期へ近づけば最大3世代で約32.17GiB、期限削除直前の一時重複・metadata・他source・障害時orphanは追加余裕が必要。Free枠内と扱わない。128〜256イベント/runの実データ・10年D1 storageは1イベント/runの試験と異なり別受入。正規化履歴を削除して帳尻を合わせない。

単価は推測せず、採用時の[R2 pricing](https://developers.cloudflare.com/r2/pricing/)、[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)とaccount実使用量で算定。[R2 conditional writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)は公式仕様を参照。期限削除は次の成功した保守で進み、停止中の厳密な物理削除には別承認するR2 lifecycleが必要。

## 承認後の初期操作（今回は未実行）

1. 最終artifact、本番version/journal/bookmarkを再照合。[10本の非実行レビュー案](personal-execution-20261018/pr19-daily-export-review-20261021.json)でprivate0007〜0016を承認。旧8本/9本packetは履歴のまま。実journalを確認し、適用済みを再適用しない。
2. 実resource名、専用export/IAM/lifecycle、実鍵/回復経路、非root TOS runtime/path、5分timer、暗号化/復元・外部deadman、NAS容量/IOPS/排他を一度受入。SSH無効を維持。鍵/実pathをGitへ書かない。
3. Collectorだけを4flag OFFで段階反映し既存3sourceを受入。実profile/費用/Cloud→NAS end-to-end確認後、保守を別承認。切戻し時0016は加算schemaとして残し、旧1run codeで長期日次を再有効化しない。現在controlをbackupで巻き戻さない。
4. 規約版、source選択、契約hash/期限/取得窓を確定。初回1runと継続日次は別承認。通常grantは不変。その後はtimer/retry/receipt/期限索引で自動継続し、障害・鍵喪失・規約変更・容量警告だけ例外対応する。

Highreso/Rebro実市場観測0件、本番反映0件。synthetic成功を本番稼働と報告しない。
