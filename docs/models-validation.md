# P0検証・納品記録（2026-09-30 JST）

対象はModels.devのprovider別拡張です。変更前mainは `25f4983158d11dafcac32b9c52ea3e3936d0f651`。`codex/models-catalog-history`で独立したレビュー単位にしました。本番への反映やP1以降の新規ソース接続はこの納品に含めません。

## 実装内容

- `src/models*.ts`: provider/field投影、catalog/価格/lifecycle、scope固定、25モデルずつのcheckpoint、lease・冪等復旧、完全取得の公開確定、訂正/as_of、expiry、運用status。
- private/public `0003_models_catalog.sql`: 既存観測を保持する前進migrationとdomain・snapshot・membership・event表。0001/0002を変更しません。
- `config/proposals/models_dev.v3.json`: 5 provider・field/retention/予算の未承認案。既存source設定や権利grantを変更しません。
- 共通APIの明示catalogフィルター、models coverage/events、型付きOpenAPI。既定の価格APIレスポンスを維持します。
- status、明示opt-inの隔離liveコマンド、synthetic benchmark/cost、preflight、有効化/停止手順。

## 検証

| 検証 | 結果と範囲 |
|---|---|
| pnpm install --frozen-lockfile | 成功、依存/lockfile変更なし |
| pnpm check | 整形、型、公開binding/fixture境界の検査成功 |
| pnpm test | 最終コードで全102件成功（9 files、exit 0）。既存FX/AI/GPUとP0を含む |
| 最終差分の再検証 | 訂正scope互換変更後にModels 25件、公開DBへの隔離価格イベント防止後に統合12件を再実行し成功 |
| pnpm test:runtime | workerd: 既存2合成source/1停止source、GPU 1051 listing・22 page・23 invocation、Models 50/250/1000件 |
| pnpm models:benchmark / models:cost | ローカルNode CPU/RSSとデータ量/費用推計。実カタログ・本番CPUではない |
| pnpm build | collector/APIともWrangler --dry-run。deployではない |
| pnpm preflight | 現行設定: ready=true、blockerなし。通知先/外部監視/disabled sourceはpending |
| proposal preflight | 想定どおりexit 2。未承認の取得/保存/分析、Free予算、owner/runtime/retentionを検出 |
| schema/OpenAPI生成 | 再生成の一致とgit diff --checkを確認 |

最初の全テストでは、既存gpu-contractのCron検査が実設定stage=bootstrapを仮定して1件失敗しました。テスト内にbootstrap用設定を作ることで修正し、実設定enabled・Cron・D1 IDは維持しました。

Windowsでの全件再実行では、5日分の掲載状態を順に保存する1試験が30秒でtimeoutしました。この試験だけ上限を60秒にし、全assertionと本番コードを維持しています。修正後の全102件再実行は成功しました。Workerの実行制限を変更するものではありません。

P0合成試験は複数provider、十進精度、明示tier/mode、0/欠損/unknown/unsupported、per-model隔離、日次同値、初回baseline/追加/再出現/not_seen、条件・metadata・canonical変更、lease、証拠保存後/途中archive失敗、再実行、権利停止、private-only、公開境界、retention、訂正/as_of、既存データ入りmigrationを確認します。parser失敗と未承認scopeがFX収集を止めないことも確認しています。

## 計測の読み方

最終の[機械可読記録](models-measurements.json)にはworkerd、Node、費用推計を別区分で保存します。実データのレスポンスや実価格を含みません。

| 合成モデル数 | invocation | 最大SQL/invocation | 最大private batch | R2 get / put | mock HTTP |
|---:|---:|---:|---:|---:|---:|
| 50 | 5 | 415 | 6 | 6 / 3 | 1 |
| 250 | 13 | 415 | 6 | 14 / 11 | 1 |
| 1,000 | 43 | 415 | 6 | 44 / 41 | 1 |

上表は3 component/モデル、初回baselineでの処理計測です。not_seen大量発生、再試行、定常削除、全collectorのsummary/通知処理は別の予算です。最大SQLとbatch sizeは異なる指標で、少数batchでも1 invocation合計がFreeの50 queryを超えます。D1 read/writeの実測値とprivate/publicのindex込み容量はJSONに記録しています。

長い未使用文字列を含む約8 MB追加ケースで、数値lexemeを保つnative JSON reviverへの変更によってメモリー増加を抑えました。NodeのRSSはライブラリ等を含むprocess値であり、Workerの128 MB isolateとの直接比較やPaidプランの適合認定には使いません。full JSONの解析と、各continuationでの投影読込は残っています。

workerdでも約8 MBの未使用文字列を含む1000モデルのintakeを通し、元の長い十進数値が丸められないことを検証しました。全件保存の50/250/1000試験とは別のintake負荷試験です。隔離価格はAPIで非表示にするだけでなく、その金額を含む変更eventを公開DBへ書かないことも検証しています。

1,000件のbounded処理成功は、その規模での日次本番運転の承認ではありません。削除・最大入替も含む日次枠は104で、現行72枠を超えます。長期容量も[コスト資料](cost-model.md)の条件ではD1上限に達します。実カタログの件数/価格component/CPU・長期queryは有効化前の審査対象です。

## 状態の区別

| 対象 | 実装済み | synthetic | 今回live検証 | 権利/承認・キー | deploy / 本番収集中 |
|---|---|---|---|---|---|
| Models.dev拡張5 provider | はい | 成功 | 未実施 | provider/field・各権利・retention・実行予算の承認待ち。APIキー不要 | remote migration/deploy待ち。拡張未開始 |
| Models.dev既存Mistral 2モデル | 維持 | 回帰成功 | 未実施 | 既存grant/設定維持 | 設定enabled。本番の最新runは未検証 |
| ECB既存FX | 維持 | 回帰成功 | 未実施 | 既存grant/設定維持 | 設定enabled。本番の最新runは未検証 |
| 既存GPU adapter | 維持 | 1051件を含む回帰成功 | 未実施 | 権利待ち、認証値は今回未確認 | disabled維持。市場観測開始とは報告しない |
| P1以降の候補 | 既存調査/拡張点のみ | 新規試験なし | 未実施 | source別権利/仕様/認証待ち | 今回の接続対象外 |

Models.dev GitHubの仕様・生成コード・LICENSEの調査は行いましたが、それを価格カタログのlive検証成功とは数えません。Phase 1の過去live-smoke報告も今回の実績へ転用しません。

## 承認・設定待ち

[有効化手順](models-enablement.md)に操作順序と実在するWrangler binding/configのコマンドを記載しました。必要なのは新policyのprovider/field・権利区分・保持期間、Paid等の実行予算と費用、実測の確認、両D1の前進migrationとWorker deployの承認です。現行Free設定は変更していません。通知先・外部監視も未設定のままです。

この作業でproduction deploy、remote migration、権利grant変更、契約、問い合わせ、main mergeは実行していません。日常の収集は承認後に既存Cronで動き、モデル選択の毎日の手入力やCSV移動は要求しません。
