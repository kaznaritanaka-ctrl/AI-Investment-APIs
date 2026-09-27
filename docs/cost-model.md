# コストと上限

確認日2026-09-27 JST。金額は米ドル、見積りであって料金保証ではない。Workers/DB/R2の課金契約は作成していない。

[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)と[制限](https://developers.cloudflare.com/workers/platform/limits/): Free 100,000 requests/day、CPU 10ms、128MB memory。Paidの基礎料金は月額5ドルから。Cron wall timeは15分。初期処理が無料で収まると断言しない。

[D1料金](https://developers.cloudflare.com/d1/platform/pricing/)と[制限](https://developers.cloudflare.com/d1/platform/limits/): Free rows read 5M/day、rows written 100k/day、500MB/DB、queries/invocation 50。Paid 10GB/DB、queries/invocation 1000。SQLは100 parameters/query、row最大2MB。indexの維持も書込みに含む。

[R2 Standard料金](https://developers.cloudflare.com/r2/pricing/): storage $0.015/GB-month、Class A $4.50/M、Class B $0.36/M。free allocationは10GB-month、A 1M、B 10M/月。丸めと既存アカウント使用量、将来改定は別。通知サービスの費用も別。

pnpm costで前提付きの容量・操作数を表示する。式: 観測数=選定entity数×1日取得回数×保存日数、DB概算=観測数×metadata/domain bytes×index/複製係数、R2=日次証拠bytes×raw日数＋日次archive bytes×archive日数。API query件数×平均走査行数が追加のread。外部HTTP=source数×1日実行回数×平均試行数。LLM token/呼出しは現在0。

D1の実測metaは全体料金ではなくwrite batchのrows_read/rows_writtenを記録。live-smoke-report.jsonは応答bytes、壁時計時間、Node host CPU/RSSを区別する。Miniflare host RSSは128MBのWorkers isolate使用量と比較できない。Workers本番CPU・cloud billed usage・network差は未測定。

初期対象4原観測/日と派生1件/日でも、取得・権利・品質・archive・公開処理のD1 query数は価格件数より多い。全工程50query以内を保証しない。Paid契約が必要なら開始前に承認が必要。無料quota超過で取得が止まる場合は通知し、手動CSVで代替しない。

## Phase 2追加見積り・ローカル計測

2026-09-27に[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)、[D1上限](https://developers.cloudflare.com/d1/platform/limits/)、[D1料金](https://developers.cloudflare.com/d1/platform/pricing/)、[R2料金](https://developers.cloudflare.com/r2/pricing/)を再確認。GPU処理は1回50件、公開確定・統計を別段階に分けます。Freeの50 SQL/呼出には収まらないためpreflightはGPU有効化にWorkers Paidの確認を要求します。有料化の契約承認とは別です。

pnpm cost --gpu --entities 1000 --days 90 --evidence-bytes-per-day 500000 --raw-days 30 --archive-bytes-per-day 3000000 --archive-days 90の例は、9万観測、DB約0.675 GB（1観測3KB・index係数2.5という仮定）、R2約0.285 GB、日次20 data request＋認証/再試行、概算20,600 D1 write rows/日です。DBはprivate/publicで複製されるので両方の容量を確認します。R2保存だけのfree割当前は約$0.0043/月ですが、サービス総額ではありません。

| 日次listing数 | 50件/pageのpage数 | 90日の片側DB概算 | 注意 |
|---|---:|---:|---|
| 1,000 | 20 | 0.675 GB | stats/消失判定/他sourceもcapture枠を使う |
| 5,000 | 100 | 3.375 GB | 既定72 continuation枠を超えpartial見込み |
| 10,000 | 200 | 6.75 GB | query上限、API権利、capture設計の再審査が必要 |

GPUの新規保持日数は未承認のため、上記90/30日は見積りシナリオです。設定に許可日数として転記していません。Workers Paidの基本料金は公式表の$5/月からで、アカウント既存利用・CPU・D1超過・税・外部API・通知料金は別です。無料稼働や費用上限を保証しません。

[workerd計測記録](runtime-phase2-report.json)は1,051件・22ページ・23分割のsynthetic実行です。SQL文数、D1呼出数、R2操作数、mock HTTP数と応答サイズを記録します。D1 metaは取得できた呼出分だけの部分計測です。Node→Miniflare RPC往復の遅さとWorker内の処理を混ぜず、scale試験は実際のworkerdで行いました。local_workerd_elapsed_msはローカル経過時間であり、Cloudflare課金CPUではありません。実アカウントでのCPU、課金、全cohort比較負荷、expiry追従能力は未計測です。

LLM呼出・token使用は定型pipelineでは0です。実測が現在の予算を超えた場合はQueues/Workflows等のADRと追加費用の承認を先に行い、巨大transactionや日次手作業で補いません。
