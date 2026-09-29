# Phase 0 — 構成と判断

調査日: 2026-09-27 JST (2026-09-26 UTC)。開始時のmainは `c64950ec0612f03a3556457583e17906ec9d2e78`、README一行のみ。既存実装・AGENTS.mdなし。開発ブランチ `codex/phase-0-1-foundation`。本番リソースは作成しない。

Cloudflare Cron → collector Worker → 取得/保存の独立policy gate → 決定的HTTP → private R2証拠 → private D1の追記履歴 → 品質/公開gate → public D1。
API Workerはpublic D1のみをbindし、GET/HEAD以外を拒否する。AI runtimeは接続しない。

初期範囲はECB EUR/USD・EUR/JPY原系列とModels.devのMistral 2モデル。USD/JPYは加工した計算結果として明示する。Models.devの全市場網羅を主張しない。カタログ全体はサイズ上限付きで読み、価格・識別子・比較条件の許可した部分だけを証拠保存する。ロゴ・説明文・認証情報は保存しない。ライセンスの根拠はsource-register参照。

## 時系列と故障境界

- sourceと予定UTCスロットからrun IDを作り、期限付きleaseで同時実行を制御する。HTTP実時刻と予定時刻を別に保存。
- R2のrun別固定キーに証拠envelopeを保存してからD1へ登録。DB登録前の失敗でも、同じキーを読んで再開できる。
- observation IDはrun・entity・parser版・内容から決める。同日再処理は冪等、翌日同価格は別観測。訂正は旧ID参照の新行。
- 公開batchをstagingで作り、全行挿入後にcompleteへ変更。読者はcomplete batchのみ参照。D1間の分散トランザクションは仮定しない。
- 現在の公開policyと全入力lineageを毎回確認。失効時は公開を遮断し、APIはCache-Control: no-store。初期版はCDN/ブラウザキャッシュを使用しない。
- ソース単位で例外を捕捉する。watchdogは未完了runを検出し、保存済み証拠の処理を再開できる。過去日に後刻の価格を偽装しない。
- 通知outboxと日次summaryはprivate D1。Webhook未設定をsetup warningとし、送信済みにしない。

## 負荷と安全性

20秒timeout（body読取も含む）、最大3試行、Retry-After、有限backoff。403とredirectは追従しない。設定の固定endpoint以外へアクセスしない。Models.dev全体JSONは上限を設け、超過時にsourceだけ停止。公開バッチは20 SQL文以下、privateは関連行を最大80文の単一トランザクションで保存する。各文100 bound parameters未満。

2026-09-27確認のCloudflare制限: Workers Free CPU 10ms、memory 128MB、D1 50 queries/invocation・500MB/DB、Paid 1000 queries/invocation・10GB/DB、bound parameters 100。カタログの厳密JSON解析はFree CPUに収まると保証しない。クラウドCPU未測定。ローカル実測と本番の適合確認を分け、有料化は別承認。

出典: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)。GitHub ActionsはCIのみで、本番日次収集はCronを使う。

## Phase 2の追加（2026-09-27）

既存2 Worker / 2 D1 / private R2の構成を維持。source adapterとdataset dispatchを明示し、GPUをAI価格として扱わない。0001不変、0002でobservations.dataset CHECKと関連index/trigger/FKを保って拡張する。

GPUのprivate保存はgpu_snapshots / gpu_pages / gpu_snapshot_members / gpu_rental / gpu_secondary / gpu_lifecycle_events。observationsの共通履歴とderived_observationsを継続使用し、gpu_metric_lineageでsnapshot入力とFX原観測を関連付ける。別の保存基盤は追加しない。

Evidenceは許可した最小投影を先にR2へ固定保存する。page単位で再開し、最大20 SQL文のbatchはレコード境界で区切る。run leaseと永続checkpointで重複を防ぐ。公開priceはsnapshot単位のstaging/complete。private/publicの分散transactionには依存しない。部分取得のcoverageは別の安全なpublic投影とする。

日次CronはFX/AIを処理し、GPU runを登録する。continuationは最終進捗時刻で公平に1source・1pageを再開し、保存済みsnapshotから統計を1cohortずつ確定する。watchdogは保存済み証拠だけを復旧する。6時間内に取れないpageはpartial/expired。新しい取得を過去の観測時刻へ偽装しない。

公開GPU統計はpublished_gpu_metricsとpublished_metric_lineageに投影。全入力policyをread時にも検査する。snapshot membershipは固定され、訂正は別snapshot/observationとして追加。as_ofはrecorded/completed時刻を越える情報を返さない。public healthは最終collector完了時刻だけを投影し、外部監視の未接続を明示する。

詳細は[gpu-methodology](gpu-methodology.md)、[runbook](cloudflare-runbook.md)、[P2計画](phase2-plan.md)。

## P0 Models.dev拡張（2026-09-30）

作業開始時のdefault branchはmain、HEADは25f4983158d11dafcac32b9c52ea3e3936d0f651。作業ツリーを確認してcodex/models-catalog-historyを作成しました。既存stage=enabled・3 Cron・独自domain・2 D1/private R2を維持し、Adminリポジトリは変更しません。

`Source.models` があるsourceだけを新しいboundedパイプラインへdispatchします。未設定の既存ECB/Models.devは旧経路です。0003だけでobservationsのdataset CHECK、catalog domain、snapshot/membership/event、public投影を追加。raw全体の永続化や汎用EAV化はありません。

日次intakeでカタログ全体を最大16 MB・有限retryで1回取得し、承認provider/fieldだけ投影します。既存continuation Cronで25モデルずつ保存、50件ずつnot_seen処理、件数照合、公開確定を進めます。lease・checkpoint・固定証拠キーで再実行可能。原JSONの解析はintakeに残り、投影JSONも各再開時に解析するため、SQL分割だけでCPU問題を解決したとは扱いません。

public snapshotはstaging中非表示、完全取得と価格適格性を分けます。partial coverageのみ理由付きで公開可能。catalog/価格/eventは現在の権利と入力lineage、expiry、公開完了時刻を検査します。詳細・制限・計測は[Models設計](models-expansion.md)、有効化は[専用手順](models-enablement.md)。
