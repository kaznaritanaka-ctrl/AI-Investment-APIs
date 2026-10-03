# 初期設定

2026-10-01の本番候補はstage=enabled、Workers Paid、Collector CPU 5,000ms、D1 Time Travel 30日です。既存Account/zone/domain/D1 ID、3 CronとAPI routeを維持します。scope・権利・容量審査は[専用手順](models-enablement.md)を参照してください。本番反映はmigrationとWorkerごとの別途承認が必要です。通知先・外部監視は未設定です。

[Cloudflare runbook](cloudflare-runbook.md)を正規手順とします。まずpnpm preflightで不足を一覧化します。必要なものはAccount ID/zone/domain、既存private/public D1 ID、private R2、Workers planとTime Travel、source別許諾/retention、collector Secrets、通知先、外部監視です。

本番作成・追加deploy・scope拡張・有料契約は別承認です。既存環境へbootstrapのcrons=[]/COLLECTION_ENABLED=falseを再適用しません。Wranglerだけをデプロイ元とし、GitHub ActionsはCIに留めます。Models.dev P0は[専用有効化手順](models-enablement.md)を参照してください。現行2モデル設定・grantは変更していません。

ローカルfixtureはENVIRONMENT=testの一時Miniflare、local liveはdevelopmentと別stateディレクトリ、本番はproductionと実リソースです。fixtureをliveやproductionへ投入すると停止します。GPU実ソースはdisabledなので、現状の準備だけでは観測開始になりません。

秘密はcollector側だけです。LambdaはLAMBDA_API_KEY、さくらはSAKURA_ACCESS_TOKEN/SAKURA_ACCESS_SECRET、eBayはEBAY_CLIENT_ID/EBAY_CLIENT_SECRET。OAuth tokenはメモリ内だけで更新し、証拠・ログ・publicへ保存しません。権利確認は認証とは独立です。

正常運転にユーザーの毎日の作業はありません。例外時は通知outboxと保存済み証拠を使って復旧し、権利や契約判断が必要な場合だけ承認事項として扱います。
