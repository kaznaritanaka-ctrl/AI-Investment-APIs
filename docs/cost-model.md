# コストと上限

確認日2026-09-27 JST。金額は米ドル、見積りであって料金保証ではない。Workers/DB/R2の課金契約は作成していない。

[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)と[制限](https://developers.cloudflare.com/workers/platform/limits/): Free 100,000 requests/day、CPU 10ms、128MB memory。Paidの基礎料金は月額5ドルから。Cron wall timeは15分。初期処理が無料で収まると断言しない。

[D1料金](https://developers.cloudflare.com/d1/platform/pricing/)と[制限](https://developers.cloudflare.com/d1/platform/limits/): Free rows read 5M/day、rows written 100k/day、500MB/DB、queries/invocation 50。Paid 10GB/DB、queries/invocation 1000。SQLは100 parameters/query、row最大2MB。indexの維持も書込みに含む。

[R2 Standard料金](https://developers.cloudflare.com/r2/pricing/): storage $0.015/GB-month、Class A $4.50/M、Class B $0.36/M。free allocationは10GB-month、A 1M、B 10M/月。丸めと既存アカウント使用量、将来改定は別。通知サービスの費用も別。

pnpm costで前提付きの容量・操作数を表示する。式: 観測数=選定entity数×1日取得回数×保存日数、DB概算=観測数×metadata/domain bytes×index/複製係数、R2=日次証拠bytes×raw日数＋日次archive bytes×archive日数。API query件数×平均走査行数が追加のread。外部HTTP=source数×1日実行回数×平均試行数。LLM token/呼出しは現在0。

D1の実測metaは全体料金ではなくwrite batchのrows_read/rows_writtenを記録。live-smoke-report.jsonは応答bytes、壁時計時間、Node host CPU/RSSを区別する。Miniflare host RSSは128MBのWorkers isolate使用量と比較できない。Workers本番CPU・cloud billed usage・network差は未測定。

初期対象4原観測/日と派生1件/日でも、取得・権利・品質・archive・公開処理のD1 query数は価格件数より多い。全工程50query以内を保証しない。Paid契約が必要なら開始前に承認が必要。無料quota超過で取得が止まる場合は通知し、手動CSVで代替しない。
