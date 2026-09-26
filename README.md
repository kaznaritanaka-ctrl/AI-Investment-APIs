# AI-Investment-APIs

AI投資の検証材料を、出典・時刻・単位・比較条件・利用権限付きで日次観測するCloudflare Workers / D1 / R2基盤です。価格の手入力やCSV転記を正常運転に要求しません。

Phase 0の調査・設計とPhase 1の縦方向パイプラインを実装。実取得はECB EUR/USD・EUR/JPYとModels.devのMistral 2モデル。自前USD/JPY計算には入力IDと方法を付けます。権利不明なOpenRouter/GPUは停止。**本番未公開・日次Cron未稼働**です。

- 読む順序: [ソース台帳](docs/source-register.md) → [構成](docs/architecture.md) → [初期設定](docs/setup.md)。
- データ: [辞書](docs/data-dictionary.md)、[計算方法](docs/methodology.md)、[権利](docs/rights-policy.md)、[第三者通知](docs/third-party-notices.md)。
- 運用: [例外対応・復元](docs/operations.md)、[コスト](docs/cost-model.md)、[残作業](docs/roadmap.md)。
- 検証: [実取得結果](docs/live-smoke-report.json)、[最初の隔離結果](docs/live-smoke-initial.json)、tests/（全fixtureはsynthetic）。

Node 22+ / pnpm 11.19.0: pnpm install --frozen-lockfile、pnpm check、pnpm test、pnpm build。buildはdry-run。pnpm smoke:liveは明示的なネットワーク実取得で、ローカルdevelopment DBだけに保存します。CIでは実取得しません。

公開API: /health、/openapi.json、/llms.txt、/v1/datasets、/v1/sources、/v1/observations、/v1/latest、/v1/changes、/v1/fx、/v1/methodology/{id}。公開Workerはpublic D1のみを参照し、rawや契約・秘密情報を持ちません。

未実装: GPU live collector、その他投資分野、常時AI修復runtime、課金・会員・売買・MCP、長期archive-only一括復元。Cloudflare認証・本番ID・route・通知先・実行プランが未接続です。コードの配布ライセンスは未選択、データにはソース固有の条件が適用されます。

[Implementation and limitations](docs/delivery-report.md) | [Validation evidence](docs/validation.md)
