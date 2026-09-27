# 最初だけ必要な設定

現時点はローカル検証済みの実装で、本番未稼働。日々のWeb巡回、コード手書き、価格転記、CSV操作は必要ない。以下の一度きりの接続・承認後、collectorが日次実行する。

1. Cloudflareの対象アカウントを指定する。2つのD1（private/public）と非公開R2を用意する。R2のpublic accessは有効にしない。ここではリソースを作成していない。
2. Wranglerのplaceholder database_idを実IDに置き換え、private/publicそれぞれのmigrationを適用する。設定作業とコマンドは担当エージェントが行える。ユーザーが手書きする前提ではない。
3. R2に evidence/ecb/ 365日、evidence/models_dev/ 90日、archive/ 365日のlifecycleを設定する。孤立オブジェクトにも適用されるため本番開始条件とする。観測D1履歴は保持し、raw消失後はarchiveとハッシュに基づく監査に切り替わる。
4. 通知先Webhookを選び、collectorのALERT_WEBHOOK_URL secretに設定する。JSONサマリーを受けるHTTPS endpoint。未設定でも収集は動くが通知は送信しない。通知テストは接続後に別途行う。
5. アカウントの現行プランとCPU/D1上限を確認する。約5MBのカタログ解析は無料CPU 10msに収まる保証がない。有料契約は別承認。既存Paidアカウントでも本番CPUを観測してから継続判断する。
6. API公開先を指定し、本番公開を明示承認する。現設定はworkers_dev=false、preview_urls=false、routeなし。公開APIはpublic D1とrate limiterのみ。collectorはHTTP操作口を持たない。
7. CronはUTC 18:17（日次、日本時間翌03:17）、18:47（watchdog）。変更時はCOLLECTION_CRON/HOUR/MINUTEとcronsを同時更新する。GitHub scheduleに日次収集を依存させない。
8. コードの配布ライセンスを選ぶ。現時点では未選択。データに一律MIT/CC0を付けない。

必要な秘密名: CLOUDFLARE_ACCOUNT_ID、CLOUDFLARE_API_TOKEN（CIからの承認済みデプロイを将来追加する場合）、ALERT_WEBHOOK_URL。ECB/Models.devにはAPI key不要。OpenRouter/GPUはkeyを入れるだけでは有効化しない。agent runtime・LLM課金設定は不要。

## 開発担当者のコマンド

Node 22以降、pnpm 11.19.0（lockfile固定）。pnpm install --frozen-lockfile → pnpm check → pnpm test → pnpm test:runtime → pnpm build。buildはWrangler dry-runのみ。pnpm smoke:live は許可済みの2ソースにアクセスするopt-inで、ローカルD1/R2を使い本番にデータを入れない。

Windowsの長いパスではSQLiteがSQLITE_CANTOPENになることがある。AI_APIS_TEMP_DIRとAI_APIS_LOCAL_STATE_DIRをworkspace内の短いworkパスに指定する。これは端末の初期設定であり日次作業ではない。内部のDB/rawはGit ignore対象。

CIはネットワークソースを取得せずsynthetic fixtureのみ。GitHubの実行結果はローカル結果と別に記録する。本番デプロイworkflowは未接続で、pushしてもCloudflare公開は行わない。

初期設定の確認が必要なものは上記だけ。権利の新規許諾、規約変更、schema変更、異常値、障害復旧は例外作業として通知される。
