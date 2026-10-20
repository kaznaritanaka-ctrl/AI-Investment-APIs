# Private研究履歴の長期保持と次の有効化判断（10/18最終修正）

[PR #16の最終修正指示](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/pull/16#issuecomment-6236225676)を適用する。**新sourceの実観測数=0、本番変更=0、新しい権利grant=0**。内部レビュー期限は削除義務ではない。許諾済みの履歴を残し、次の成果はHighreso/GPUSOROBANとRebroの承認後の連続実観測とする。本書はローカル実装と承認待ちの手順であり、有効化の指示ではない。

## 状態と次の対応

| 状態 | 新規取得 / read | 正規化履歴 / 次の対応 |
|---|---|---|
| active | 現行の取得・保存・分析権とtermsが有効な場合のみ可 | 承認された保持契約に従う |
| review_due | 両方停止 | 保存権の根拠が有効なら保持。terms再確認、新policy版、過去config hashの利用承認後にreadを復旧。永久削除マーカーを作らない |
| collection_stopped | 取得停止、履歴readは別判定 | 保存・分析権が有効なら保持/read可。収集停止だけで削除しない |
| rights_unknown | 未確認の取得/readを停止 | 分析だけ未確認なら保存権は別評価。保存も不明なら事前承認済み有限holdだけ適用。holdがなければstorage=unknownとし、権限・削除期限の判断を即時人間レビューへ |
| retention_expired | read停止 | 明示された元の固定期限、または短くなった許諾期限で段階削除 |
| delete_required | read停止 | 保存権の明示終了、適用される削除要求、revoke、承認済みholdの終了。R2マーカーを先に保存しD1/R2とbackup期限を処理 |

`research_retention_assessments` はrun/current config hash、評価時刻、状態、取得/保存/分析権、根拠参照、期限、次の対応をimmutableに記録する。短期証拠は `within_retention_unverified / expired / deleted`、再検証は `requires_projection_check / unavailable` と記録する。期限内というだけでR2 objectの実在・全page・hash一致を検証済みと表示しない。証拠が消えても許諾内のnormalized履歴は消さない。

## 保持モードと必要な根拠

| normalized_mode | normalized_days | 意味 |
|---|---|---|
| unapproved | null | 未承認。取得前に停止 |
| fixed_days | 正の整数 | 承認された期間・契約期限を適用 |
| until_revoked | null | 明確な継続保管許諾とowner承認がある場合だけ暦日数で強制削除しない |

`target_days` は3〜5年以上という研究目標であり許諾でも廃棄期限でもない。EIA/JEPXはunapproved、target=1095、normalized=null。Rebro1825/Highreso1095は初期交渉の目安で、両GPU候補とも設定/grantは未作成。nullだけでは取得できない。

`until_revoked` はprivate_storage=allowed、対象fieldの根拠、`ongoing_storage.basis_ref`、`ongoing_storage.owner_approval_ref`、通常のowner/wire/retentionレビュー、実Time Travel・lifecycle確認を要求する。期限付きの `policy.valid_until` / `retention_limit_days` があるsourceをこのモードへ読み替えない。研究経路の内部再確認はterms.review_afterに置き、policy.valid_untilを内部リマインダーの代用にしない。後の許諾延長やモード変更でも旧runの期限は延長しない。

通常取得の一律条件に `storage_review_hold` を含めない。fixed_daysは取得/保存/分析権、field・出典/規約、owner/wire/retentionレビュー、有限保持期間とbackup/Time Travel条件が有効ならhold=nullでも取得できる。until_revokedも上記の実際の継続保存許諾が揃えばhold=nullでよい。現在の保存許諾が通常保存を既に認めているため、将来の不確実性だけを理由に別の例外許諾を要求しない。実候補の許諾・保持条件は未確認なので取得不能のまま。

holdは、保存権が実際に不明になったときに限って利用する任意の例外。提供者条件等に根拠のある**有限の保存専用許諾**をbasis_ref、owner_approval_ref、all_copies_delete_byとして取得時snapshotへ固定する。元holdと現行条件の早い期限までに再確認し、未解決ならbackup_daysを差し引いた日から削除する。通常の許諾が有効なら古いholdの期限だけで取得を止めず、review_dueだけでもholdを発動しない。

保存権不明で取得時holdがない場合（旧v1も含む）はHTTP/readを停止し、storage=unknown、next_action=review_rights、review_deadline=評価時刻として即時人間レビューへ上げる。現在も保存が許可されるか・適用される全コピー削除期限を根拠付きで判断する。既知の固定期限は維持し、期限到来・明示終了・削除要求なら削除する。期限nullは未確定であり無期限保管の許可ではない。根拠のない猶予や架空の削除期限を作らず、定期レビュー待ちだけでは永久削除マーカーを作らない。後から現行configにholdを追加しても過去runへ遡及適用しない。本番scheduler/レビュー通知は未接続であり、この状態を放置してよい運用ではない。

`requestResearchDeletion` は適用される削除要求のbasis_refと全コピー期限を必須とするローカル関数。期限がTime Travelより短ければ消去を約束せずdeadline missedを返す。操作APIや本番操作口は追加しない。

## 保存方式とmigration

現在のprivate D1に正規化履歴を残す。R2は短期projectionと本文なしの取消し/削除記録だけ。新しい長期archive、DB分割、新DB、追加の費用分析基盤は作らない。strategy=d1_history、archive_days=0を維持する。

- 0008のimmutable config版・保持snapshot・全コピー期限を維持。0009はresearch親子テーブルをコピーしてmode/null期限を追加し、旧0007/0008の行と期限をそのままfixed_daysへ移す。過去SQLやPublic migrationは変更しない。状態評価台帳も追加する。populated DB/FK/triggerをローカル検証し、本番へ適用しない。
- 新規runにevidence/archive/normalized/backup、Time Travel、権利上限、レビュー根拠、保存権終了日、任意の有限hold（なければnull）を固定。既存0009のJSON制約でnull holdを保存できるため、この最終修正にSQL追加/変更は不要。旧snapshotや期限は書き換えない。期限は取得run時刻から計算し、page追加や再実行で延長しない。source_dateは保持起算や実観測時刻の代用にしない。
- fixed_daysではnormalized_days + backup_days <= retention_limit_daysを検査。Time Travel実日数<=承認backup上限、証拠期限も独立検査。until_revokedでも明示的なrevoke/削除要求/より短い現行条件は有効。
- `adoptReviewedResearchConfig` は新policy版・期待current hash・履歴の同一scopeを検査する。enabled版は取得権等の全gateを要求。disabled版はownerのレビュー記録としてunknown/deniedも登録できるが、利用許可を付与するものではない。過去config hashの `history_access` 承認と現在の権利/termsが揃って初めて読める。
- `historyExpiry` は元期限と現行の短い期限の早い方。古い観測をfreshnessだけでstale/purgeにしない。snapshotのない旧0007行は読取停止し、migrationで長期grantを付けない。
- `reconcileResearchRun` は上表を1runずつ評価。review_due・分析権の未確認だけでは削除しない。明示された削除義務だけ最大20行ずつ処理し、短期証拠は独立に削除する。収集停止時も評価が必要だが本番schedulerは未接続。

## R2 lifecycle・復元・取消し

`research/<source_id>/` は短期projectionだけ。1回最大5run×4pageの削除で未checkpointのcaptureも対象にする。R2 lifecycleには[削除遅延](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)があるため、厳密期限の唯一の削除手段にせず、expiry gate、bounded DELETE、backlog監視を併用する。raw全体やbackup exportは追加しない。

`research-control/revocations/` と `research-control/deletions/` はID、日時、理由、根拠参照、全コピー期限の本文なし記録。review_dueには作成しない。短期lifecycle/backup restore/本文削除から除外し、復活防止のため存続させる。旧版で既に作られた削除マーカーは理由を問わず維持し、自動解除しない。bucket全体の短期lifecycleがcontrol記録を消すなら有効化不可。実ruleの確認と変更承認は次段階。

取消しはR2 deny記録を先に作りD1をsuspendする。lease中も新しいread/収集はdenyし、本文削除はlease後。R2失敗時も現行D1をsuspendするが、復元保護は未完了としてエラーを返す。両storeを跨ぐatomic性はなく、マーカー保存まで復元後利用を再開しない。source revokeを取り消す操作は未実装。

[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)はDB全体の復元で、row削除だけで既存bookmarkを消さない。実日数は別確認し、`backup_residual_until` は削除完了時刻+確認済み日数の見込みとする。`backup_deadline_missed=true` は全コピー期限の充足を証明できない状態。Cloudflareの実消去証明ではない。backup残存を認めない契約はこのD1方式で有効化しない。

復元手順は (1)研究利用/収集を閉じる、(2)最新承認config/termsとR2 control記録を確保、(3)D1復元、(4)current configを再登録、(5)全runをcheckpoint付きでreconcile、(6)削除対象の残行/backup期限とreview対象を確認、(7)許可された利用だけ再開。review_dueは保持して再レビューへ、delete_requiredは再削除へ分ける。R2本文も復元したなら証拠期限を再適用。旧設定を復元して許可を取り戻すことは禁止。本番復元・掃除は未実行。

## 容量は観測のみ

10/16の5年試算（2 source合計100行/日、本文等2KiB/行ならmetadata込み約381MB）と80%閾値は**参考値**。実測でもFree適合の保証でもなく、ソース獲得・ローカル実装の停止条件にはしない。元の比較計算は `scripts/research-retention-cost.mjs` とGitの264d773版に残す。今回、料金再調査・archive比較・追加分析は行わない。

最小限の運用確認として、既存read-only metricsのD1 storage/rows read/write/容量エラー、R2 storage/operationsと日次増分を確認し、記録日時・実上限との差・観測期間を残す。実増分で次のレビューまでの余裕不足が判明したら警告し、その実測を元に対策を別提案する。Cloudflare物理上限、既存データ保護、提供者の保持上限は必須。既存履歴の自動短縮、有料化、新DB作成は行わない。日次の人間によるCSV作業は要件にしない。

## 次の有効化候補は2つだけ

所有者が提供者に対応する。未返信/未送信を許可済みにせず、公式feed・許諾前のliveや権限昇格を行わない。EIA/JEPXはcritical pathから外したまま。

| 確定事項 | Highreso / GPUSOROBAN | Rebro / GPU買取センター |
|---|---|---|
| 公式経路 | 価格feedのAPI/CSVはunknown。HTML自動巡回で代替しない | 公開事例と非公開成立seriesを分離。正規API/CSV/feedはunknown |
| 権利 | 自動取得・private保存・内部分析を個別確認。契約終了後の保持と分析、until_revokedまたは固定期限を確認。有限holdは提供者が認める場合だけ任意で記録 | 同左。匿名化だけで自由な利用権を推定しない |
| 比較条件 | 提供確認済みSKU、GPU数/フォーム/地域証拠、専有/共有、割込み、最低利用、point/通貨、時/分/月、税 | 初期A100/H100の明示SKU。買取提示/買取成立/販売提示/販売成立、日時精度、状態/VRAM/PCIe/SXM、台数/lot、税/送料。個人・相手情報を受け取らない |
| 頻度・費用・認証 | 1日1run、最大50offer/1page案。feed費/rate/認証はunknown、契約/Secretは別承認 | 1日1run、最大50新規/訂正記録/1page案。coverage・feed費/rate/認証はunknown |
| 保持 | evidence7/archive0、研究目標1095、backup最大30日案。継続保管許諾ならuntil_revoked、期限付きならfixed_days | 同左、研究目標1825。3〜5年を強制廃棄期限にしない |
| 受入 | 同価格再観測、掲載条件変更/消失、通貨/単位、partial/失敗、全page/件数/訂正を検証。availability≠稼働率 | 正常空差分≠取得失敗、重複/訂正、出品消失≠成立、一業者≠全市場を検証 |
| 監視・rollback | 日次完了率/欠測/初回・最新観測、retention backlog。取得停止後は保存/分析を別評価、削除義務があるrunだけ削除 | 同左。既存ECB/Models/PoCを止めず、復元時も現行権利を適用 |
| 公開 | 現在0。Public/商用/派生/LLM/rawは別許諾 | 現在0。非公開成立例も未取得 |

次の手順は公式仕様/許諾の受領→具体的policy差分→個別live smoke承認→本番版を基準にした接続・自動retention実装→0007/0008/0009のmigration/deploy承認→無効状態の受入→source別初回収集承認。今回新PRやgrantは作らない。2社の交渉が不成立でも無断で3社目を有効化しない。

## KPIと次の完了条件

新sourceの有効な実観測source数=0、実観測数=0、初回/最新observed_at=null、連続観測日数=0、保存された実改定前版=0。欠測日数/完了率は運転予定がまだないためnull。商用権限はreview_required。synthetic件数、idle continuation、Collector処理完了日時を実観測に数えない。

次の有効化では初回liveの日時・出典・complete観測IDを記録し、承認された日次運転の連続性を確認する。同価格の正常再観測も正常日。手動価格転記/CSV download/uploadを運転要件にしない。

## mainと本番の統合計画（未実行）

10/16時点のmain=1d42d98、10/15のread-only配信annotation=0abf2b6。今回の最終修正基準はPR HEAD=7801891。本番状態を再監査したとは報告しない。mainと本番はPoC/continuation/operations/Admin/NAS等で異なり、**mainベースの本PRをそのままdeployしない**。

1. 現在の配信version/annotationとmain/開発HEAD、remote migration適用状況をread-onlyで固定する。
2. 本番を再現するcommitから統合案を作り、PoC/ECB/Models scope、3 Cron、2 D1/private R2、AGENT=false、collector非公開を維持する。
3. research前進migration/実装/テストだけを取り込み、本番schemaからの移行、既存処理と公開境界、NAS等への無許可exportがないことを検証する。Admin/Public/NASの別差分は今回扱わない。
4. source別権利、Time Travel/lifecycle、実測容量を確認しdry-runとrollback版を提示。remote migration/deploy/Secret/source enableは個別承認を得る。
5. rollbackはsource単独停止と必要な削除を優先。DB全体巻戻しや旧main再deployで既存履歴・本番設定を失わせない。
