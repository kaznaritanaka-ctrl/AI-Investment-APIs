# PR #18: 日次消失・完全cohort・比較系列

2026-10-20の[追加指示](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/pull/18#issuecomment-6293225572)への修正。検証日は2026-10-21 JST。Highreso/Rebroの実市場観測は各0件、本番日次稼働0日。今回、提供者サイトとCloudflare本番へのアクセスはない。

PR #16はmain `c228ef81d6c987078b63677d5b8b4373dddca14f`へマージ済み。そのmain履歴をPR #18にmergeして依存を整理し、0014の監査DELETE防護を維持する。PRのbaseをmainへ変更することは、PR #18をmainへmergeすることではない。

## P0-1: 消失と再掲載

新規日次取得は`daily-history-v2`。同じ比較系列・data_originのcomplete runだけを比較する。`not_seen`は前回の完全cohortに見えたkeyが今回見えないという観測で、売却・契約終了・在庫0・価格0・取引日時ではない。`domain_json / record_hash`はnull、前観測IDと当日の観測時刻を持つ専用unionで保存する。

| 日 | Aの掲載 | immutable event | 完全snapshotの意味 |
|---|---|---|---|
| 1 | あり | first_seen | 原値と条件を保存 |
| 2 | 不在 | not_seen → 日1のID | 掲載消失を初めて確認 |
| 3 | 継続不在 | 追加eventなし | complete coverageと前complete run IDを保存 |
| 4 | 再掲載 | reappeared → 日2のID | 再掲載の原値と条件を新規保存 |

不在は1回のtransition。各complete runのseen集合とcoverageを辿ってその日の観測範囲内の状態を再構築する。欠測日を補間しない。価格未掲載はseenの`amount_decimal=null / missing_reason=not_reported`で、not_seenとは異なる。

partial/failed、403/429、規約hash不一致、DOM変化、上限超過では消失を確定しない。処理途中はseen行だけをcheckpoint保存する。全seen行の照合後、最大128件のnot_seen挿入とcompleteへの変更を同じ2 SQLのD1 batchで確定し、件数不一致はtriggerで全体rollbackする。前日のpartialが残る間は新日をholdし、遅い復旧によるlineageの順序逆転を防ぐ。証拠期限切れのpartialは従来の保守でfailedとなり、その日を空の市場として扱わない。

## P0-2: 一回のHTMLからbounded保存

| 項目 | 新日次checkpoint契約 | 境界 |
|---|---|---|
| HTTP | source/UTC日1試行、robots→terms→固定HTMLの最大3 GET | retry/backfillなし。復旧は保存projectionだけ |
| cohort | Highreso A100/H100・明記1GPU、Rebro A100/H100公開事例 | 既存method v2と同じ。容量のために対象を削らない |
| 入力 | 最大256 table行 | 対象外も数え、超過は停止 |
| seen | 最大128 price slot | Highreso 64行×時間/月額2枠。Rebro 128掲載行 |
| event | 最大128 seen + 128 not_seen = 256 | GPU台数や取引数ではない |
| SQL | 19 seen INSERT + 1 checkpoint UPDATE、最大20文/batch | 最後の消失とcompleteは最大128行のboundedな2文batch |
| 証拠 | projection/plan各最大512KiB、projection part各128KiB/最大4 | raw HTMLを永続化しない |
| export | snapshot最大512KiB、part各128KiB/最大4 | 件数内でもbytes超過はcomplete前に停止 |
| 旧経路 | 初回Cloud/local・通常researchの48枠、共有SourceSchemaの100件上限は維持 | capture_record_limitは日次専用 |

入力行・cohort行・除外行・model/GPU数別の除外理由・price slots/row・seen/event件数をcoverageに保存する。部分保存はcheckpoint、確定時はcoverageとrecord_countで照合する。v2のrecord_countはseen+not_seenのイベント数で、今回の価格枠数にはseen_countを使う。月額を時間単価へ換算しない。

durable projectionを先にR2へ保存し、part/manifestを発行する。immutable planに前観測ID・記録時刻・coverageを固定する。plan内の消失候補は未確定で、complete前の観測履歴やNAS exportに出さない。DB checkpointとplan hashにより復旧でも同じIDを使う。[2026-10-21の再レビュー修正](pr18-review-20261021.md)で、最初のdurable projectionは同じ応答を使って最大3 PUTまで試す。各回で権限/leaseを再確認し、応答喪失時は既存hashを読み戻して解決する。全PUT失敗で保存元がなければ、その日のHTTP試行は消費済みのまま停止する。新しいsource GETで埋め直さない。

## P1: 許諾契約と比較系列

contract_hashは許諾・期限・review・resource pinを含む元契約の識別子。series_idはdaily-comparison-v1定義のcanonical SHA-256で、source ID、固定endpoint、method_version、整列した対象モデル/GPU数、normalization_version、unit_definitionを含む。

単純な規約/許諾review更新・同条件の契約更新・保存期間/容量budget変更では系列を切らない。モデル・GPU数・method・正規化・単位の変更は別系列。自動互換aliasはない。comparisonの明示宣言にはreview refが必要で、それ自体が値を変換するわけではない。将来正規化の意味を変える際はversionも更新する。

旧契約JSON/hashを変更せず、最大20契約ずつ比較定義を追加indexする。index未完了ならsource HTTP前に保留する。syntheticとliveを結合しない。Highresoの同一instance IDでも異cohortを前回値や消失候補にしない。Rebroは内容hash+出現番号による公開multisetで、取引IDではない。内容変更は旧公開内容のnot_seenと新内容のfirst_seenとし、同一約定の訂正と断定しない。

## 前進migrationと旧履歴

0015_daily_series_events.sqlのみ追加。0001〜0014は不変。日次観測表の9列と旧行を保ちunionへ対応し、UPDATE/DELETE制約を再作成する。比較契約index、immutable coverage、単調checkpoint、complete件数triggerを追加する。0007〜0009/0012/0014の一般研究・assessment防護を維持する。

完了済み旧snapshot v1の検証/export/NAS復元を残す。旧hash・期限・証拠を遡及変換しない。未完了の旧保存projectionは元objectを保持し、別keyのv2 checkpointから共通の比較・消失確定へ再開する。既存行の値/recorded_atは不変で、比較仕様と合わない既存lineageは改変せず明示holdする。v2 export/復元はnull消失行・前観測ID・plan hash・coverageをそのまま保持する。NAS専用export分離、現在control/取消し確認、暗号化/staging復元は既存機構を使い、新NAS機能を追加しない。

正規化履歴は承認された継続保存のままで、30日/10年TTLを追加しない。証拠期限・backup世代寿命とは別。明示の保存終了/取消しでは観測と新coverage/checkpointを削除し、再取得防止slot/削除markerを維持する。Time Travelや実NASの実効削除は本番受入事項のまま。

## source別受入と本番ブロッカー

| 確認点 | Highreso | Rebro |
|---|---|---|
| 既存構造確認 | 2026-10-18 06:47 UTC、A100 1GPU 24行/48枠、H100対象0 | 同日、20入力行中4選定事例 |
| 今回 | live GETなし。64×2=128枠はsynthetic | live GETなし。重複/内容変更はsynthetic |
| 完全性 | 25×2=50、64×2=128を完了可能。対象cohort維持 | 選別公開事例のみ。市場全件/実売全件ではない |
| 実市場観測 | 0件 | 0件 |
| 規約 | 国内旧版は2026-10-31T15:00Zまで。11/1以降は別文書/hash/適用評価の別契約が必要 | 別途参照されるサイト規約の適用未確定を残す |
| 許諾 | provider unconfirmed、通常grant review_required/disabled | 同左 |

所有者による非公開・個人研究例外と継続保存は承認済みで再承認を要求しない。無返信/robots許容を提供者許諾にしない。実取得・grant変更・deploy・remote migration・Cron/Secret・実bucket/鍵・NAS実機変更は未実施。

新日次の非実行案はpersonal-execution-20261018/*.daily-checkpoint-draft.json。旧案は不変。method v2/明記cohort/128枠/256入力行を表し、実行窓・account/DB/bucket・鍵・daily approvalはnull、statusはdraft、通常grantはreview_required。config hashのみ整合させた実行不可のレビュー資料。初回専用契約を日次へ無断昇格しない。

残件はsource別適用評価・最新fingerprint・取得窓と日次運転の実行承認、専用export実IAM、鍵custody/復元、実NAS、CPU/容量/費用、配信中Collectorとの差分/migration適用状況、migration/deploy/rollback承認。PoC Private・ECB/Models・bindings/Cronを配信版基点で維持する統合が必要で、旧Git設定を丸ごとdeployしない。rollbackは取得停止と確認済み直前versionへの切戻しを準備し、down migrationや履歴/control削除はしない。

## 検証・merge条件

追加試験はA→不在→継続不在→再掲載、0/nullと消失の区別、再実行、失敗時の誤消失防止、48/50/128枠、DB/R2中断、256イベントexport/age暗号化/空D1復元、比較系列、旧DB前進migration。workerdでも128枠を3 mock GET/複数checkpointで保存する。正確な全件数と最新HEADのCI結果はPR本文へ記録する。

main base整理後の最新HEADでcheck/test/runtime/dry-run build/offline preflight/生成物整合が成功し、旧migration・ECB/Models/PoC・Public境界の回帰がなく、意味と上限がレビューされることがmainへのmerge判断条件。merge自体は別承認待ちで、本番有効化とは分離する。synthetic成功を実価格収集/本番稼働済みと報告しない。
