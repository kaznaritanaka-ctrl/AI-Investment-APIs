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

## Models.dev P0の容量・費用（2026-09-30）

`pnpm test:runtime` → `pnpm models:benchmark` → `pnpm models:cost` で再計算します。[保存した計測・全18シナリオ](models-measurements.json)は合成入力のみです。price componentは型付きJSON内の要素で、componentごとのSQL行ではありません。1モデル/日につきcatalogとpriceの2 observation＋2 domain行、membership、最低1 lifecycle event、publicの2 observationとeventを計上します。ローカルD1のsize_after差分でprivate/publicのindex込み増加量を測り、追加componentは1要素300 bytes・追加格納係数1.5と仮定しています。

| モデル/日 | component/モデル | 1年private / public GB | 3年private / public GB | 1年末状態の月額USD（割当前） |
|---:|---:|---:|---:|---:|
| 50 | 3 | 0.184 / 0.330 | 0.552 / 0.991 | 5.53 |
| 250 | 3 | 0.940 / 1.618 | 2.821 / 4.853 | 7.65 |
| 1,000 | 3 | 3.717 / 6.462 | 11.150 / 19.385 | 15.54 |
| 50 | 64 | 0.685 / 0.831 | 2.055 / 2.494 | 6.29 |
| 250 | 64 | 3.445 / 4.122 | 10.336 / 12.367 | 11.45 |
| 1,000 | 64 | 13.736 / 16.481 | 41.208 / 49.442 | 30.74 |

30日・365日・1095日、component数3/64、月次/年次の生成量、R2量、rows read/write、Class A/B、年額は機械可読レポートに含めます。3年で10GB/DBを超えるケースは現構成では継続できず、その費用値は計算式の出力にすぎません。500件という提案上限も、3 componentの単純比例では3年public約9.7GBになるため、実際のcomponent分布・他source・index増加を含む保持/容量レビューが必要です。

料金式は[Workers](https://developers.cloudflare.com/workers/platform/pricing/)の基本$5/月、[D1](https://developers.cloudflare.com/d1/platform/pricing/)の$0.75/GB月・write $1/M行・read $0.001/M行、[R2 Standard](https://developers.cloudflare.com/r2/pricing/)のstorage $0.015/GB月・A $4.50/M・B $0.36/Mを使います。共有割当を全く消費していない仮定の値も併記し、アカウント使用量が不明なまま無料枠内とは保証しません。Worker CPU、公開API負荷、課金単位の丸め、税、追加変更イベント、長期化に伴うquery走査増加、backupの物理容量は除外しています。年額は表示状態の月額×12で、初年度請求額の積分ではありません。

R2は証拠90日＋archive365日、normalized/public/eventは1095日、Time Travelの許諾余裕は最大30日という提案です。現在のFree設定をPaidへ変更していません。P0ローカル計測は最大415 SQL/モデルingest呼出であり、[D1のFree 50/Paid 1000 query制約](https://developers.cloudflare.com/d1/platform/limits/)からPaid確認を有効化gateにしています。取得成功時は1日1 HTTPで、失敗時は1呼出最大3 HTTP試行・最大3復旧の有限予算です。

intake/ingest/not_seen/finalize/定常削除を含む保守的な日次枠は、50件9枠、250件29枠、500件54枠、1000件104枠です。既存72枠を超える1000件やGPU同時有効化は別設計レビューなしに開始しません。1,000件の処理試験成功と、1,000件の本番継続容量を区別します。

大きなカタログでは数値lexemeを保持するnative JSON reviverを使い、未使用長文の解析によるメモリー増加を抑えました。約8 MBの追加文字列を含む計測で改善を確認していますが、host RSS/Node CPUは128 MBのWorker isolateや課金CPUの実測ではありません。投影も各再開時に読み直します。実カタログ、上限16 MB付近、最大component、長期DBの本番検証は未実施です。
