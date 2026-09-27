# AI-Investment-APIs

AI投資研究向けの出典・時刻・単位・比較条件・権利付き観測履歴APIです。投資判断や「AIバブル指数」を出すサービスではありません。

Phase 0/1のFX・AI API価格を維持し、Phase 2としてGPUレンタル/中古提示価格のパイプラインと比較統計を追加しました。**GPU実ソースは権利・認証待ちで全停止。本番未デプロイ、Cron停止、独自ドメイン未公開です。** 合成データの試験を市場観測の開始とは扱いません。

- [Phase 2納品報告](docs/phase2-delivery-report.md)
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

buildはWrangler dry-runだけです。preflightは現在の未設定項目をexit 2で報告します。CIはnode scripts/preflight.mjs --allow-unconfiguredで構造を検査します。本番deployやlive収集をCIに含めません。

pnpm smoke:liveは従来のFX/AIソースだけを対象とする明示ネットワークopt-inです。GPUを無断で追加していません。docs/live-smoke-report.jsonはPhase 1時点の記録で、Phase 2の実データ検証ではありません。

## API

既存/v1/observations、/latest、/changesにgpu_rental/gpu_secondaryとSKU/source/provider/country/region/contract/condition/basis/snapshot/as_ofフィルターを追加。履歴は最大100件のcursor pagination、期間上限366日です。latestは最大100系列で、GPUは最新の完全scopeに残るofferのみです。全件取得はcoverageのsnapshot IDでobservationsをページングします。

/v1/gpu/catalogは識別辞書、/v1/gpu/coverageは取得範囲、/v1/gpu/metricsは同条件統計、/v1/gpu/comparisonsは条件付き比較です。decimalは文字列、nullは0ではありません。すべてno-storeで現行権利を再検査します。

コード配布ライセンスは未選択です。全データに共通する再配布ライセンスを付けず、sourceごとの出典・条件を返します。
