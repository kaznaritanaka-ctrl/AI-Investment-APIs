# Private研究履歴の長期保持と次の有効化判断（2026-10-16 JST）

[PR #16追加指示](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/pull/16#issuecomment-6216092355)への回答。**新sourceのlive観測=0、本番変更=0、新しい権利grant=0**。以下はローカル実装と承認待ちの設計であり、有効化の指示ではない。

## 選択：初回はD1で長期履歴、R2は短期証拠と削除記録

少数source・上限付きの段階では、正規化履歴をprivate D1に残す。1 source 1日50行を2つという容量比較の仮定では、5年182,500 observation、metadata込み約381 MBを見込む。これは実測でもFree適合の保証でもない。既存DBの空き容量・既存Modelsの増分を含む5年見積りが満たせなければ有効化を停止する。保存済み系列を90日で消して容量を確保しない。

`target_days` は1095〜3650日の研究設計目標、`normalized_days` はsource別に承認された実際の期間。候補EIA/JEPXはtarget=1095、normalized=nullのまま。Rebroは1825、Highresoは1095を交渉案とするが、両者とも設定・grantは未作成。期間が未承認なら取得前に停止し、目標から許諾を推定しない。

| 比較 | D1に長期履歴（今回実装） | D1直近90日＋private R2 immutable履歴（比較案、未実装） |
|---|---|---|
| 保持 | 取得時に承認期間と期限を固定。証拠7日と独立 | 90日は検索用D1の配置期限だけ。R2に同じ承認期限まで保持するので、90日削除仕様ではない |
| クエリ | run/key/dateをSQL検索、訂正前後を直接比較。再観測も別行 | manifestからobjectを取得・hash検証・展開。長期SQL集計には別処理が必要 |
| 原本性 | observation/config/期限のUPDATEをtriggerで拒否 | source/config/run/expiryごとに固定object、条件付きPUT、順序・件数・hashを固定 |
| 復元 | D1復元後、現行設定と外部削除記録を再適用 | D1 manifest喪失時もobjectから復元できる形式が必要。許可・期限の検査なしに再投入しない |
| 削除 | 1run最大20行ずつ。D1 Time Travel残存期間も記録 | 同一objectへ異なるsource/期限を混在させない。manifest撤回後object削除。R2自体を不変ロックせず削除義務を優先 |
| 複雑性 | 小さな追加migrationで検証可能 | checkpoint、読戻し確認、D1からの移行中断、R2喪失、旧版検索、削除後復元を別途試験する必要 |

R2案の将来の移行は、1run最大192行・128KiB以下のchunk、1 invocation 1 chunkで始める。**現在の短期証拠をそのまま長期archiveへ昇格させない**。新たに許諾された正規化フィールドだけを書き、hash/件数/期限を読戻し確認し、manifest complete後にD1正文を段階削除する。コピー失敗ではD1を残す。Public binding/APIには接続しない。archive権限・実装・復元検証が未承認の今はschemaも`strategy=d1_history, archive_days=0`のみを許す。

## 3年・5年の容量と費用

再現コマンド: `node scripts/research-retention-cost.mjs`。日数は依頼の1095/1825を採用し、365日=12か月で積算。実データ・為替は使用しない。100 observation/日、D1本文/provenance/indexを2KiB/行、2 run/日、D1 metadataを2KiB/run、R2履歴を1KiB/行と仮定する。行幅が2倍なら本文相当も2倍になり、全体容量を再審査する。

| 期間 | observation / run | D1長期保持 | R2案のD1 / R2 | D1案の期間累計・保管料係数 | R2案の期間累計・保管料係数 |
|---|---:|---:|---:|---:|---:|
| 3年 | 109,500 / 2,190 | 228.74 MB | 22.92 / 102.91 MB | $3.09 | $0.56 |
| 5年 | 182,500 / 3,650 | 381.24 MB | 25.91 / 177.66 MB | $8.58 | $1.05 |

係数は無料枠控除前・端数処理前の保存費だけで、請求見積り総額ではない。5年末の在庫量を1年間保管する係数はD1約$3.43、R2案約$0.27。1年分の新規行は36,500、D1約76.25 MB。今回の新sourceの収集費増分実績は0。

参照した2026-10-16の料金は[D1](https://developers.cloudflare.com/d1/platform/pricing/)の超過保存$0.75/GB-month、[R2 Standard](https://developers.cloudflare.com/r2/pricing/)の$0.015/GB-month。D1の5GB、R2の10GB-month等の含有枠はアカウント全体で共有する。枠が残ればこの小規模保存の追加請求は0になり得るが、現在の残枠を本資料では測定していない。R2はGB-monthとリクエストの課金単位を切り上げるため、上の連続値は実請求額ではない。保存枠消費済みなら小量のR2保存でも1GB単位/月、操作枠消費済みならClass A/Bの追加単位で費用が発生する。

R2案のarchive追加量は定常時最大62 object/月、検証GETも同数。Class Aは$4.50/百万、Class Bは$0.36/百万という段階的な料金なので、両方の含有枠を使い切ったアカウントで追加単位が各1つ発生すれば$4.86/月（3年$174.96、5年$291.60）が保管料とは別にあり得る。既存利用量による単位境界を確認してから請求差分を求める。短期証拠のPUT/GET、権限/削除記録のHEAD、retention、障害retryも予算に含める。

共通の証拠上限は2 source×1 page×128KiB×7日=1.75MiB。削除記録は本文なし約1KiB/runと仮定すると5年約3.65MB。これら、既存データ、provider/feedの契約費（unknown）、Workers基本料/CPU、D1 read/write/index更新は表の外。市場データの提供費を無料と仮定しない。D1 lineage検索は保持行数に伴って増えるため、5年最大件数でrows_readとCPUを測り、Source単位の予算を定める。現在のテストは時間境界の検証で、5年分の負荷試験ではない。

[D1制限](https://developers.cloudflare.com/d1/platform/limits/)ではFree 500MB/DB、Paid 10GB/DB。既存DBと合算で余裕を確保し、追加データの将来容量が残容量の80%を超える見込みなら、scope/頻度を承認し直すかR2案を実装してから有効化する。既存履歴の自動短縮、有料化、DB新設をこのPRでは行わない。

## 保持契約とコード

- `0008_research_retention.sql` は0007へ追記する前進migration。config版のimmutable台帳、runの保持snapshot、全コピー期限、削除日時/backup残存期限を追加。0001〜0007、public migrationは変更しない。
- 新規runに取得時のevidence/archive/normalized/backup、Time Travel日数、権利上限、review refを固定。normalized期限はrun開始時から計算し、後のpageや再実行で延長しない。source_dateが過去でも過去の観測と誤認せず、保持起算は実取得runの時刻とする。
- `normalized_days + backup_days <= retention_limit_days`、証拠期限、実Time Travel日数<=backup上限を取得前に検査する。limit=nullは無制限許諾を意味せず、具体的な期間のowner reviewが別途必要。
- `adoptReviewedResearchConfig` は別policy版・期待current hash・既存field/scopeを検査してローカル登録する。取得済みconfig hashを`history_access`で明示承認した場合だけ過去版を読める。未許諾期間を後から許諾済みにしたり、旧runの期限を延長したりしない。
- historical readは現在のprivate_storage/internal_analysisとtermsを要求する。取得停止（enabled=false、取得権失効）と履歴の利用権失効を分離する。取得だけ停止しても、有効な履歴利用権があれば保持/read可。suspend/revoke、保存権失効、review期限超過はreadを閉じる。収集には従来どおりprivate 3権限が必要。
- `historyExpiry` は取得時期限と現行の短い保持上限の早い方を使う。古い履歴を現在値のfreshnessだけでstale/purgeにしない。既存runを90日で削除するfallbackはない。0007時代のsnapshotがない行はunreviewedとして読取停止し、migration時の長期grantを付けない。
- `reconcileResearchRun` は失効/不承認/期限切れ/削除済みの1runを判定し、最大20行ずつ削除する。証拠だけの期間短縮も現行条件と元期限の早い方で適用し、長い正規化履歴を巻き込まない。新規収集停止時も実行する必要がある。未承認の旧履歴を保留したまま無期限に保存する運用にしない。
- `disclosureRevision` は発表日・対象日・構造化された掲載内容のhashと観測IDを区別する。観測/証拠/内部policy版だけの更新はreobserved。発表や採択を稼働実績へ変換しない。raw記事本文のhash/全文保存やニュースcrawlerは追加しない。

## R2 lifecycle・復元・取消し

prefix `research/<source_id>/` は短期projectionだけ。source別に取得時承認のevidence期間でcleanupする。R2 lifecycleは補助であり、[通常削除に遅延がある](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)ため厳密期限の唯一の削除手段にしない。実装のexpiry read gateとbounded DELETE、backlog/失敗監視を併用する。生のHTTP bodyやbackup exportは追加しない。

prefix `research-control/revocations/` と `research-control/deletions/` はsource/run ID、日時、理由のみの取消し・削除記録。短期lifecycle/backup restore/本文削除から除外し、復活防止のため存続させる。R2全bucketに7日/90日のruleがある環境では有効化不可。許可前にprefix/ruleの実状態をread-onlyで確認し、専用rule変更を別承認する。現在lifecycleは変更していない。

取消しはR2 deny記録を先に作り、D1のsourceをsuspendして各runを削除する。in-flight leaseがあっても新たな読取/収集はdeny記録で停止し、本文削除はlease後に再開する。R2書込み失敗時も現行D1をsuspendするが、復元保護は未完了としてエラーを返す。R2への再試行が完了するまで復元後の利用を再開しない。両storeの障害を跨ぐatomic性はなく、外部gateと未完了監視が本番統合条件。sourceのrevoke記録をこの実装から消す操作はない。

[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)はD1全体の復元で、既存bookmarkを消さない。Free 7日/Paid 30日という実環境の値を別途確認する。row削除だけでbackup即時消去を主張しない。`backup_residual_until` は削除完了時刻+確認したTime Travel日数の見込み。`backup_deadline_missed`がtrueなら、許可期限内の全コピー削除を証明できない状態として停止・owner対応事項にする。これはCloudflareの実消去証明ではない。backup残存猶予を認めないsourceは、このD1案では有効化しない。

復元順序は、(1)研究利用/収集を停止、(2)最新のレビュー済み設定を復元DBより先に用意、(3)D1復元、(4)外部deny記録を保持したままcurrent configを再登録、(5)全対象runの`reconcileResearchRun`をcheckpoint付きで反復、(6)残行0/期限/backup backlogを確認、(7)許可のある利用だけ再開。古い設定も復元して許可を取り戻す操作は禁止。R2本文も復元した場合は同じprefixの証拠expiryを再適用する。復元実行・本番掃除は今回行わない。

## 次の有効化候補は2つだけ

いずれもownerが交渉する候補で、接続可能との断定ではない。未返信/未送信を許可済みにしない。feedと保存条件が揃わなければ実装済みの受入契約までで停止する。EIA/JEPXを前提作業にしない。

| 承認事項 | Rebro / GPU買取センター | Highreso / GPUSOROBAN |
|---|---|---|
| 公式経路 | [公開事例](https://gpu-kaitori.com/reason/)・[Q&A](https://gpu-kaitori.com/q-a/)は存在。非公開成立系列のAPI/CSV/feed URLはunknown。提供者から正規仕様を受領して固定endpointにする | [公式instances](https://soroban.highreso.jp/compute/instances)・[利用規約](https://soroban.highreso.jp/terms)。条件付き価格feedのAPI/CSVはunknown。HTML自動巡回で代替しない |
| 利用根拠 | 自動取得、private保存、内部分析、匿名化、契約終了後の保持、訂正版提供を個別書面で確認。公開事例と全取引のcoverageを明記 | 同じ3権限と長期保持、標準/個別契約価格の使用範囲を確認。サービス利用規約を価格DB化の一括許諾にしない |
| 対象と比較条件 | 初期A100/H100の明示SKUのみ。買取提示/買取成立/販売提示/販売成立、取引時刻の精度、状態、VRAM/PCIe/SXM、台数/lot、税/送料、通貨を保持。個人・取引相手情報は受け取らない | 提供確認済みSKUだけ。GPU数/フォーム/地域証拠、専有/共有、割込み、最低利用、ポイント/通貨、時/分/月、税を分離。availabilityから稼働率を計算しない |
| 頻度・費用・認証 | 1日1run、最大50新規/訂正記録・1page案。feed料金/rate/認証方法はunknown。個別承認し、Secretを今回取得/追加しない | 1日1run、最大50offer・1page案。消える価格条件の同価格再観測も保存。feed費/rate/認証はunknown、契約/Secretは別承認 |
| 4種保持の交渉案 | evidence 7 / archive 0 / normalized **1825** / backup最大30日。契約上限と実Time Travelに照合。全部review_required | evidence 7 / archive 0 / normalized **1095** / backup最大30日。必要なら別審査で延長案、取得済み期限は自動延長しない。全部review_required |
| 監視と受入 | 正常空差分と取得失敗、全page完了、重複/訂正、日次完了率、欠測、初回/最新時刻、保持backlog、更新元根拠を検証。初回live smokeは別承認 | 上記に条件変更・掲載消失・通貨/課金単位の変更を追加。schema変更は停止、価格急変だけで隔離しない |
| lifecycle・rollback | source別短期prefix、control記録除外、backup残存を許諾。collector呼出し停止→権限停止→対象runをbounded削除。既存ECB/Models/PoCを止めない | 同左。契約終了で履歴利用が継続できるかを事前に確定する。復元後も現行許可を再適用 |
| 外部へ出せる範囲 | 現在は**0**。Public/商用/派生/LLM/rawの許諾は別。匿名化すれば自由とはしない | 現在は**0**。個別価格と一般公開価格を混ぜず、将来もscope別審査 |

owner reviewには、上表の未確定事項、具体的なpolicy差分、storage予算、live smoke許可、0007/0008と実Collectorへの接続・自動retentionの実装、無効状態での受入、初回本番収集の順で提出する。これらは次の独立した有効化PRの完了条件で、今回新PRは作らない。Highreso/Rebroの交渉が不成立なら無断で3つ目を有効化しない。

## KPIと次の完了条件

| 指標 | 定義 | 今回の新source |
|---|---|---|
| 有効な実観測source数 | 承認済み・非synthetic・complete・有効な観測を少なくとも1件持つsource | 0 |
| 初回/最新実観測日時 | 非syntheticのobserved_at。Collector処理完了日時は代用しない | null / null |
| 連続観測日数 | 承認した運転開始以降、予定slotのcompleteを連続して満たした日数。同価格も1正常日 | 0（未開始） |
| 欠測日数 / 取得完了率 | 予定slotを分母。partial/失敗/期限切れを成功へ数えない。休業日はsource calendarに従う | null / null（運転予定なし） |
| 保存された改定前版 | 現在も許諾・期限内で読める改定前の非synthetic版。観測時刻だけの変更は改定ではない | 0 |
| 年間増分保存費用 | 実usage差分と上の仮定モデルを別表示。provider料金とCloudflareを分離 | 実績追加0、将来費用は仮定 |
| 商用利用許諾 | source/field/条件/版/有効期限ごとの権限状態 | review_required |

次の有効化PRは初回live日時・出典・completeな観測IDを証拠付きで記録し、承認済みの日次運転が続くことを確認して完了とする。合成fixtureの件数、コード行数、idle continuation、価格が変わらなかったという事実だけをデータ取得実績に数えない。日々のCSV転記/ダウンロード/アップロードは運転要件にしない。

## mainと本番の統合計画（実行していない）

2026-10-16にGitを再確認: main=`1d42d98...`、PR開始HEAD=`3369118...`。10/15にread-only確認したCollectorの配信annotationは`0abf2b6...`。今回Cloudflare実状態を再監査したとは報告しない。mainと当該commitには57ファイルの差があり、PoCだけでなくcontinuation/operations/Admin/NAS/lockfile等も含む。private migrationは両参照とも0001/0002/0003/0005/0006で、今回の0007/0008とは別。remote適用状況は有効化前に読み取り確認する。

1. 配信Worker version/annotationと現行main/開発HEADをread-onlyで再取得し、比較を固定する。最新配信源が不明ならdeployを止める。
2. 所有者レビュー用の統合ブランチを本番配信の再現可能なcommitから用意し、PoC enabled/profile、ECB、Models scope、3 Cron、2 D1/private R2、AGENT=false、collector非公開を固定した差分表を作る。今PRのmainベースをそのままdeployしない。
3. 本PRのresearchファイル、前進migration、生成schema/test/docsだけを取り込み、networkの小差分は3-wayで確認。main/本番双方にある機能を旧版で置き換えない。Admin/Public/NASの既存差分は所有者が別に統合判断する対象で、今回まとめて変更しない。
4. 本番基準のschemaからのローカルmigration、ECB/Models/PoC/continuation/watchdog、rights/retention、public境界と既存NASバックアップ対象外の確認を行う。新しい研究正文が既存exportに入るなら、無許可でbackup期間を増やさずrelease blockerとする。
5. source別の承認・現在の容量/plan/Time Travel/lifecycle確認後、dry-runと具体的diff/rollback版を提示する。remote migration・deploy・Secret・source enableの実行承認は別々に得る。
6. rollbackは新sourceの呼出し停止と必要な対象削除を優先。既存本番配信版を保持し、D1全体の巻戻しや旧mainの再deployで他の履歴/設定を失わせない。
