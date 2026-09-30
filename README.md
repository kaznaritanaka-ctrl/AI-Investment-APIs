# AI-Investment-APIs

AI投資研究向けの出典・時刻・単位・比較条件・権利付き観測履歴APIです。投資判断や「AIバブル指数」を出すサービスではありません。

Phase 0/1のFX・AI API価格、Phase 2のGPU処理を維持し、Models.devのprovider別カタログ・価格・掲載履歴を追加しました。**現在の設定はstage=enabled、既存3 CronとAPI custom domainを維持しています。本番の稼働記録は今回未検証です。** Models.dev拡張は未承認の設定案で、稼働設定は従来のMistral 2モデルのままです。GPU実ソースもdisabledのままです。合成試験を実観測の開始とは扱いません。

- [Phase 2納品報告](docs/phase2-delivery-report.md)
- [P0 Models.dev設計・policy案](docs/models-expansion.md) / [有効化・停止手順](docs/models-enablement.md) / [検証報告](docs/models-validation.md)
- [設計](docs/architecture.md) / [権利方針](docs/rights-policy.md)
- [GPUソース調査](docs/gpu-source-review.md) / [方法](docs/gpu-methodology.md)
- [Cloudflare初期設定](docs/cloudflare-runbook.md) / [運用](docs/operations.md)
- [データ辞書](docs/data-dictionary.md) / [コスト](docs/cost-model.md) / [OpenAPI](openapi.json)

## 構成

collector Worker → private R2の最小証拠 → private D1のimmutable履歴 → 権利/品質/完全取得gate → public D1 → API Worker。公開Workerはprivate DB、R2、取得用Secretsを持ちません。

GPUはrun/partition/page/snapshotを分離し、leaseとcheckpointで再開します。1,051件のsynthetic listingをworkerdで分割検証します。出品消失はnot_seen、API障害はpartialです。正常な大幅変動、条件変更の隔離、統計除外を分けます。日常の価格転記、CSV移動、Web巡回は運用に含めません。LLM常駐は不要です。

## 開発・検証

Node 24、pnpm 11.19.0。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:runtime
pnpm build
pnpm preflight
```

buildはWrangler dry-runだけです。preflightは現行設定を検査し、blockerがあればexit 2を返します。拡張案は `pnpm preflight --proposal config/proposals/models_dev.v3.json` で実ファイルを変えずに評価できます。CIはnode scripts/preflight.mjs --allow-unconfiguredで構造を検査します。本番deployやlive収集をCIに含めません。

`pnpm models:status` はソースの設定・権利・認証待ちを表示します。DBを読まない既定モードで稼働中と判定しません。`pnpm models:benchmark`、`pnpm models:cost` はsyntheticの解析負荷と容量・費用の見積りです。Windowsで長い一時パスによりworkerdのSQLite起動が失敗する場合は、`AI_APIS_TEMP_DIR` を短い一時ディレクトリへ設定します。

pnpm smoke:liveは従来のFX/AIソースだけを対象とする明示ネットワークopt-inです。GPUを無断で追加していません。docs/live-smoke-report.jsonはPhase 1時点の記録で、Phase 2の実データ検証ではありません。

## API

既存/v1/observations、/latest、/changesにgpu_rental/gpu_secondaryとSKU/source/provider/country/region/contract/condition/basis/snapshot/as_ofフィルターを追加。履歴は最大100件のcursor pagination、期間上限366日です。latestは最大100系列で、GPUは最新の完全scopeに残るofferのみです。全件取得はcoverageのsnapshot IDでobservationsをページングします。

/v1/gpu/catalogは識別辞書、/v1/gpu/coverageは取得範囲、/v1/gpu/metricsは同条件統計、/v1/gpu/comparisonsは条件付き比較です。decimalは文字列、nullは0ではありません。すべてno-storeで現行権利を再検査します。

P0追加: `dataset=ai_model_catalog` と `model_snapshot` フィルター、`/v1/models/coverage`、`/v1/models/events`。既定のlatest/observationsには新catalog datasetを混ぜず、明示指定で取得します。価格は既存ai_api_pricesです。完全な同一scope間だけでnot_seenを生成し、掲載消失を提供終了としません。`latest` は最大100件なので全件はcoverageのsnapshotを指定してobservationsをページングします。

コード配布ライセンスは未選択です。全データに共通する再配布ライセンスを付けず、sourceごとの出典・条件を返します。

## Collector継続運用の修正（本番反映待ち）

UTC予定slotと旧秒付きrunの互換照合、安全な構造化ログ、処理種別ごとのsummary、idle continuation通知の抑制を追加しています。既存P0、権利、公開境界、Cronは維持しています。watchdog単独版は0001/0002で検証し、P0を含む全体版とは別にレビュー・リリースできます。[反映・通知・復旧計画](docs/collector-reliability-release.md)を参照してください。

`pnpm collector:benchmark before` / `after` は合成データだけのNode/workerd性能検証です。[改善前後の測定とFree/Paid比較](docs/collector-performance.md)には、ローカル経過時間・CPU代理指標と本番Cloudflare CPUを分けて記録しています。Free適合や本番反映済みを示す結果ではありません。
