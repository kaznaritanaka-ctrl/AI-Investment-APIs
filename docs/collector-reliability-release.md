# Collector継続運用の修正・リリース計画（2026-09-30）

これは**ローカル実装・合成検証済みの変更案**です。本番deploy、remote migration、契約、権利、Secret、Cron、DNS、Access、MFA、IAM、通知送信は実行していません。現在のECB／Models.dev 2モデル収集は停止していません。実環境の根拠は同日read-only監査と今回の通知metadata SELECTに限られ、このコードが本番稼働したという意味ではありません。

## レビュー単位と依存関係

開始時点はcleanな `codex/models-catalog-history`、HEAD `481eca7f6de575d9b17edf8889b3f583caa1081e`。そのP0実装を保持し、`codex/collector-reliability`へ分岐しました。

| 単位 | 内容 | DB依存 |
|---|---|---|
| `ae0967e` | 共通slot照合、旧run互換、watchdog回帰9件 | 0001/0002だけで動作 |
| `c3a3237` | P0の旧run／checkpoint統合 | 既存P0の0003 |
| `d3df069` | UTF-8重複削減、synthetic性能比較 | 新migrationなし |
| `4c13889` | 安全な構造化ログ、処理種別別summary、idle通知抑制 | P0を含む現在ブランチは0003が必要 |

**watchdogだけ先行リリースできます。** GitHub main基準 `25f4983158d11dafcac32b9c52ea3e3936d0f651` から作った `codex/watchdog-only` の `2a12725` が独立版です。別worktreeで0001/0002のみの回帰、既存workerd runtime、両Workerのdry-run buildを確認しました。API deployもmigrationも不要です。この独立版にはP0／性能改善／新telemetry／idle通知抑制は含みません。既存のFree CPU問題も解決しません。

`codex/collector-reliability`全体を0003未適用の本番へそのままdeployしてはいけません。拡張sourceがdisabledでも、P0のcontinuation／retentionには新テーブル依存があります。今回新しいmigrationは追加せず、既存0001/0002/0003は変更していません。

本番で監査したCollector versionは `f5c1cab6-79e4-4426-bc9e-a914b3e18785`、API versionは `fdb1a474-60f4-472d-abbc-7f1daa710bff`。**Git commitとの完全一致は未証明**です。これらは次回deploy時の最新versionとは限りません。実施直前に再確認し、所有者が基準コードを承認してください。

## 原因と互換性

旧Collectorはevent.scheduledTimeの秒を含む `18:17:35.000Z` をhashし、watchdogは `18:17:00.000Z` をhashしていました。修正はUTCの論理的な日次slotを共通関数で決め、同source・同minute範囲内の既存runを既存indexで探します。成功した旧runを誤missing行より優先し、旧run ID／scheduled_for／R2 key／checkpointを維持します。再試行が翌日になっても元scheduledTime・保存slotへ対応させます。observed_at／recorded_atは実時刻のままです。

collection_runsは収集のnamespaceを維持し、watchdogとcontinuationはそれを確認・再開する別process_kindです。別source・別slot・異なるnamespaceの行は成功の根拠にしません。保存証拠限定の復旧では欠落時に新規HTTPへ切り替えません。lease、有限復旧予算、immutable観測／証拠／訂正履歴は維持します。

旧誤missing行を今回変更していません。将来の訂正は誤missing run IDと実際の成功run ID、理由、実施者、review参照、訂正記録時刻を対応付ける追記の監査記録とします。観測値や旧finished_atを書換えず、成功実行をもう一度起動しません。本番DB訂正は別承認です。

## ログ・summary・通知

`src/telemetry.ts` は決めたフィールドだけをJSONにします。collector／sourceの開始・終了、source_id、解決済みrun_id、UTC logical_slot、event_scheduled_at、process_kind、state、件数、許可リスト化したcode、実測elapsed_ms、collector版と設定上のparser版を記録します。開始時に未解決の旧run IDはnullです。未知Error.message、URL、Secret、認証header、カタログ本文、private R2本文、任意のresult追加プロパティは出しません。Collector最上位で再throwする例外も安全なcodeに置き換えます。

elapsed_msはD1/R2待ちを含む実経過時間でCPUではありません。parserの修正再解析では設定上の版と保存済みsnapshotの版を混同しないでください。履歴の実parser版はsnapshot／観測metadataで確認します。

新しい完了処理のFX／Models.devは対象publication batchをAPIと共通の可視性条件で数えます。取消済み権利やpartialを公開件数へ含めません。この測定はsource終了時に追加1 SELECTを使い、失敗はnull／measurement_failedとして収集を失敗させません。再実行済み・watchdogによる確認・GPUなど未計測の場合はnullで、0に推定しません。性能比較はこのscheduled telemetryの追加負荷を含まないため、本番CPU／SQLは反映後に再計測が必要です。

summaryはcollection／watchdog／continuationを区別し、同種の直前の非空summaryと比較します。idle continuationも実行記録を残しますが、新規outboxは作りません。旧summary／pendingは保持し、処理種別不明の旧行を推測して比較対象にしません。初回の新形式summaryは通知対象になり得ます。既存outboxの送信機能・送信上限・idempotency-keyは再利用し、監視サービスは追加していません。

- `last_collector_completed_at` は処理の完了時刻のみ。idle continuationでも進みます。
- `observation_completed_sources` とsource別last_success_at／observed_at、public batchの完了をデータ更新の根拠にします。watchdogのalready_processedは新観測に数えません。
- 価格不変でも次回の正常取得は新観測です。changes=0を失敗にしません。
- summaryの旧`stale`は未完了状態の一覧で、休日カレンダーの鮮度判定ではありません。`freshness_evaluation=source_calendar_not_evaluated`を併記します。ECBのsource_date／TARGETカレンダー、Models.devの日次観測、policy停止、partial／failedは別々に評価します。休業日のsource_date据置だけで障害にしません。未取得を休日として補完もしません。

### pending 5件のread-only分類

2026-09-29 UTCのmetadata、source_id／state／理由／件数だけをSELECTし、本文やSecret値は取得しませんでした。全件pending、attempts=0。

| 記録UTC | 分類 | 将来の処理案（未実施） |
|---|---|---|
| 18:00:36 | 対象なしcontinuation | 監査記録を維持し、通知不要として個別扱いを承認 |
| 18:17:35 | ECB／Models.dev成功、各2観測 | 過去成功通知として保持。即時一括再送はしない |
| 18:20:35 | 対象なしcontinuation | 同上のidle扱い |
| 18:47:35 | 両sourceの誤missing | 実成功runへの訂正参照を付けた扱いを個別承認 |
| 18:50:35 | 対象なしcontinuation | 同上のidle扱い |

Wrangler経由のSELECT結果はrows_written=0、changed_db=falseです。最初の`d1 execute --file`試行はWranglerのimport経路の認証段階で失敗し、upload／SQL実行に至っていません。成功した照会は固定SELECTを`--command`で渡しました。MCPは未接続のままであり、Wrangler成功をMCP接続成功と呼びません。

**ALERT_WEBHOOK_URLを追加すると、現在の送信処理は旧pendingも次のscheduled処理で送信対象にします。** 先に5件の個別扱いと監査記録を承認してください。outboxはpending/sentのみの既存schemaなので「送信しない処理済み」をsentに偽装してはいけません。抑制状態が必要なら別の前進migration／選択条件のレビューが必要です。今回、一括再送・削除・既読化は一切していません。

### 有効化待ち

[Workers Logs公式](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)（2026-09-30確認）ではFree 200,000 events/day・3日保持、Paid 20 million/month込み・7日保持、超過USD 0.60/million eventsです。提案はCollectorのみsample率1.0、まずプラン既定の短期保持で監視し、APIログやLogpush等の外部保管は別判断とします。低頻度でも上限・費用を監視します。Wranglerのobservability設定は今回変更していません。

所有者承認後だけ、同一Wrangler設定の `observability.enabled=true`、`observability.head_sampling_rate=1` をレビューしてdeployします。保持期間を任意の日数へ変更できると仮定せず、選んだプランの実設定を確認します。通知先の確定、既存pendingの扱い、`ALERT_WEBHOOK_URL`登録、最初の試験通知、外部read-only死活監視は別承認です。Secret値をGit／チャット／CLI引数へ記録しません。外部監視は公開healthとsource別の鮮度を読み、collector起動停止とデータ未更新を分けます。通知先、頻度、休日条件、課金は未決定です。

## 承認後の順序とコマンド候補

以下は**計画だけ**です。書込みコマンドを今回実行していません。各段階で対象account／DB／versionが承認記録に一致しなければ中断し、別環境へ推測で適用しません。

### 1. 事前確認（読み取り・ローカル）

```powershell
git status --short
git rev-parse HEAD
pnpm check
pnpm test
pnpm test:runtime
pnpm build
pnpm preflight
pnpm exec wrangler deployments list --config wrangler.collector.jsonc
pnpm exec wrangler deployments list --config wrangler.api.jsonc
pnpm exec wrangler d1 migrations list PRIVATE_DB --remote --config wrangler.collector.jsonc
pnpm exec wrangler d1 migrations list PUBLIC_DB --remote --config wrangler.collector.jsonc
```

`pnpm build`は2 Workerとも`deploy --dry-run`です。remote migrations **list**は照会です。`pnpm preflight:cloudflare`を使う場合は既存の設定済みAPI tokenでのみ実行し、未設定／権限不足を別blockerとして扱います。Wrangler OAuth成功とこの環境変数の準備は同じではありません。token取得表示や権限拡張をこの手順で行いません。現在の正常なcron3本／gate true／agent false／API domain／private-public bindingsを照合します。

D1 Time Travelの現時点の復元可能期間・bookmarkと現行policy版を記録し、復元手順と権限を確認します。本タスクは本番証拠本文・DB全体のexportを実行していません。復元訓練済みとは報告しません。予算は[CPU・費用比較](collector-performance.md)で承認を得ます。

### 2A. watchdogだけ先行する場合

`codex/watchdog-only`をレビュー済みHEAD `2a12725`で使います。本番基準の一致、Freeの未解決CPUリスクまたはPaid変更、deployを所有者が承認した後だけ実行します。

```powershell
git rev-parse HEAD
pnpm build
$releaseSha = git rev-parse HEAD
pnpm exec wrangler deploy --config wrangler.collector.jsonc --tag $releaseSha --message "Reviewed watchdog slot compatibility fix"
```

**Collectorのみ1回**です。API、0003、source grant、Cronを変更しません。既存Wrangler設定を使用し、別のCron登録コマンド／二重deployを足しません。独立版では新telemetryはまだ出ないため、次の自然な日次実行・watchdogをD1 metadataとCloudflare metricsで確認します。手動収集は起動しません。

### 2B. P0を含む全体を適用する場合

まずPaid契約とCPU上限案を個別承認し、実プランを確認してconfig根拠を更新します。CPU／D1予算、保持日数、バックアップをレビューします。P0のscope権利変更はコード適用とは別の承認です。

**0003 remote migration承認後だけ**、既存0001/0002の上へ両DBを前進適用します。

```powershell
pnpm exec wrangler d1 migrations apply PRIVATE_DB --remote --config wrangler.collector.jsonc
pnpm exec wrangler d1 migrations apply PUBLIC_DB --remote --config wrangler.collector.jsonc
```

private→public双方の適用とFKを確認してからコードへ進みます。片側が失敗したらdeployせず、適用履歴と原因を確認します。現在の既存Workerは追加schemaを残したまま維持します。DROP／既存migration編集／リセットを復旧手段にしません。

**全体deploy承認後だけ**、APIを先に新schemaへ対応させ、Collectorを適用します。既存source v2のままのコード適用と、承認後のscope有効化を区別します。

```powershell
pnpm build
$releaseSha = git rev-parse HEAD
pnpm exec wrangler deploy --config wrangler.api.jsonc --tag $releaseSha --message "Reviewed P0 schema-compatible API"
pnpm exec wrangler deploy --config wrangler.collector.jsonc --tag $releaseSha --message "Reviewed collector reliability and P0 support"
```

現在のproposalをallowedへ自動変更しません。[P0有効化手順](models-enablement.md)に従い、権利・owner/runtime/retention review、最小scopeのlive検証と実行予算が承認された設定だけを別リリースします。本番収集開始は既存の日次Cronからです。今回live取得は未実行です。

### 3. 反映後確認

- 新Worker version ID／Git SHA／各DB migration／各source policy版を下の記録に対応付けます。collectorにroute、workers.dev、preview、AGENT_ENABLED=trueを追加していないことを再確認します。
- `GET https://api.ai-investment-research.net/health` と公開datasetのsource別observed_at／source_date／件数を確認します。healthだけで新観測完了と判定しません。collector HTTP操作口は使いません。
- 自然なcollection→continuation→watchdogで、同source・元slot・旧run IDの照合、duplicateなし、true missingのみの警告、lease/checkpoint進捗、partial非公開を確認します。昔の誤missing行は残るので`state=missing`単純件数だけで再発と断定しません。
- Cloudflare公式metricsでprocess別CPU／wall／errors／memory／D1 queries・rows／R2使用量を確認します。改善後本番CPUはこの段階まで未検証です。memoryはPaidでも128 MBで、合成Node RSSを代用しません。
- Logsを別承認で有効化した場合だけ、allowlist化ログ、通知未設定／送信確認、過去pendingの承認済み扱いを確認します。API本文・private evidenceをログへ貼らず、metadata照会に限定します。

read-only run照会例（本文なし）:

```powershell
pnpm exec wrangler d1 execute PRIVATE_DB --remote --config wrangler.collector.jsonc --command "SELECT source_id,run_id,scheduled_for,state,finished_at,observation_count,accepted_count,error_code FROM collection_runs ORDER BY scheduled_for DESC LIMIT 30"
```

### 4. 失敗時

コード障害なら、直前に記録した**当該schemaと互換なWorker version**へ戻す案を所有者が承認してから実行します。versionを推測しません。

```powershell
pnpm exec wrangler rollback $approvedCollectorVersion --config wrangler.collector.jsonc --message "Approved recovery to recorded compatible collector version"
```

これはWorkerコードのrollbackです。D1 migration、データ、Cron、Secret、domainまで戻ったと考えず、個別に照合します。0003が適用済みでも追加table／履歴は残し、旧Workerへの復帰でDROPしません。P0 scope有効化後に旧Collectorへ戻す場合は、新scopeを古い設定と暗黙置換しないよう、対象sourceの安全な停止／policy対応を別レビューします。ECBや全Cronをまとめて止める操作は既定にしません。

本当にDB破損がある場合は、通常のcode rollbackと分離した事故対応です。所有者承認の下、復元境界、private/public整合、以後の観測の保全、現在のrights停止とretentionを確認します。Time Travelはその後の書込みを失う可能性があるので単純な巻戻しコマンドを提示して実行しません。まず別環境の復元検証、必要な前進修正・追記を優先します。

## 今回と分ける作業

Admin Custom Domain drift、Access／MFA／IAM、Cloudflare MCP認証・権限拡張、GPU等のsource有効化、P0の本番適用・権利grant拡張は別作業です。通知先・外部監視未設定、exact deployed Git SHA、変更後の本番CPU／長期容量／最大component数の実容量は未解決です。日次の手入力・CSV作業を解決策にしません。

## リリース記録テンプレート

```text
release date (UTC/JST):
owner approval reference and approved scope:
git branch / full SHA / clean tree:
collector version before / after:
API version before / after (unchanged if watchdog-only):
verified account / database IDs / R2 bucket:
PRIVATE_DB migration versions / applied timestamps:
PUBLIC_DB migration versions / applied timestamps:
source policy versions / approved scope / retention review:
Workers plan evidence / CPU setting / monitoring plan:
Time Travel bookmark / recovery window / preservation plan:
local check / test counts / runtime / dry-run / preflight:
natural daily slot / legacy matching / duplicate check:
source observed_at / source_date / visible counts / complete or partial:
Cloudflare CPU / wall / memory / errors / D1 and R2 usage:
notification approval / pending disposition (no Secret values):
compatible rollback versions / decision owner:
unverified items / follow-up decisions:
```
