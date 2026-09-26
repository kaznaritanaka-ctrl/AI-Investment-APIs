# ソース台帳 — Phase 0

調査日時: 2026-09-26 18:23 UTC以降（2026-09-27 JST）。権限の判断と価格の取得日時は別。機械可読の全項目・9権限・対象範囲・有効期間・保持日数は config/sources/*.json、検証スキーマは src/schema.ts / config/source.schema.json。

| source_id | 投資上の用途・取得方法 | 初期判定 |
|---|---|---|
| ecb | EUR基準FX XML。EUR/USD・EUR/JPY原系列と明示した自前クロス計算 | 有効、外部LLM処理は未確認 |
| models_dev | 提供経路別AI価格の二次カタログ、JSON API | 選定2モデルの数値・条件のみ有効 |
| openrouter | モデル集約価格／provider別endpoint価格 | 全権限review_required、実HTTPなし |
| sakura_dok | 日本GPU、is1a、unit_prices API | 認証・蓄積/配信許諾の確認待ち |
| gpusoroban | 日本GPU、公式の石川県提供説明 | offer別地域・機械feed・許諾の確認待ち |
| lambda | 米国GPU、instance-types APIとregion | API key・価格履歴の利用範囲の確認待ち |
| runpod | 米国GPU、GraphQLとdatacenter | 規約の自動取得/データベース化条項の確認待ち |

## ecb

[公式FXとXML案内](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)、[統計再利用ポリシー](https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html)、[著作権・免責](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html)を確認。商用/非商用再利用、出典、metadata維持、第三者データ除外が条件。著作権条件3は加工の明示を求める。原EUR値を保持し、クロスは自前計算と明示する既知条件の実装ルールを採用。契約上の新規許諾を主張しない。

取得先: https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml 。参照為替であって実取引値ではない。日付しかない箇所はdateのまま保持。ECB由来情報を購入者に提供する場合も、元情報がECBから無償入手できることを事前およびアクセス時に示す。APIに利用条件を同梱する。

## models_dev

[公式サイト](https://models.dev/)は価格を含むopen-source databaseとJSON APIを案内。単なるAPI公開だけでは権利根拠にしていない。確認した[MIT LICENSE](https://github.com/anomalyco/models.dev/blob/473c291c9993c0200505f7287bd37836712f4eaf/LICENSE)と、同じcommitの[TOML読込・生成処理](https://github.com/anomalyco/models.dev/blob/473c291c9993c0200505f7287bd37836712f4eaf/packages/core/src/generate.ts)、[API JSON出力処理](https://github.com/anomalyco/models.dev/blob/473c291c9993c0200505f7287bd37836712f4eaf/packages/web/script/build.ts)を照合。root以外のデータ固有ライセンス/NOTICEは調査したtreeでは確認されなかった。無いことだけを許可根拠にせず、公開リポジトリ内データのMIT適用と生成経路を根拠に、限定した数値・識別子・比較条件を利用する。

対象は mistral/mistral-large-latest、mistral/mistral-small-latest。ライセンス版は上記commitを固定、価格観測はlive APIで行う。メーカー公式価格の検証済み代替とはしない。aliasの実体版・適用日は不明。ロゴ、説明文、任意provider URL、モデルウェイト利用権は対象外。全JSONを一時的に解析するが、保存は選定フィールド投影と応答全体ハッシュのみ。API raw配信と外部LLM処理はreview_required。

[READMEの価格単位](https://github.com/anomalyco/models.dev/blob/473c291c9993c0200505f7287bd37836712f4eaf/README.md)はUSD/million tokens。未知のtier/追加料金キーは隔離。取得時JSON tokenの十進精度は保持するが、upstream生成で既に失われた精度は回復できない。

初回live smokeでは古いAnthropic選定IDが欠落し、残り2件もcatalog_incompleteとして隔離した。自動で別モデルに差し替えず、既存2モデルへ範囲を明示変更しpolicy v2とした。初回結果は live-smoke-initial.json、最終結果は live-smoke-report.json。規約根拠・全フィールドに対する普遍的な第三者権利保証ではない。

## openrouter

[Models API仕様](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)、[endpoint API](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model)、[価格単位とpagination](https://openrouter.ai/docs/guides/overview/models)、[規約7項](https://openrouter.ai/terms)を確認。自動コピー制限と、APIによる価格履歴蓄積・外部データAPI提供の適用関係は未解決。禁止と法的に断定せずreview_required。モデル一覧とendpoint価格を同系列にせず、token/request単位を保持。実取得・保存・配信はdisabled、syntheticテストのみ。HTMLへの迂回なし。

## GPU候補の接続準備

- さくら: [公式API](https://manual.sakura.ad.jp/koukaryoku-dok-api/spec.html)に石狩is1aとunit_pricesが記載。year/month/dayとpagination、is_overriddenによるアカウント価格を区別。秒単位。認証必須。[約款一覧](https://www.sakura.ad.jp/corporate/agreement/)と[改定告知](https://www.sakura.ad.jp/corporate/information/announcements/2025/02/13/1968218534/)を確認。API文書のCC BY-ND-4.0はレスポンス価格データの許諾として使わない。
- Highreso: [公式サービス](https://soroban.highreso.jp/)に石川県のデータセンターからの提供説明。[規約2025-12-01](https://soroban.highreso.jp/terms)と[利用案内](https://soroban.highreso.jp/article/article-002)を調査。offer単位のregion、価格feed、継続保存・再配布条件が未確認。国は事業者本社から推測しない。
- Lambda: [API](https://docs.lambda.ai/public-cloud/cloud-api/)にinstance typesの価格・容量・地域、[region一覧](https://docs.lambda.ai/public-cloud/on-demand/)にVirginia/California等。[規約](https://lambda.ai/legal/terms-of-service)はAPI keyにCloud Termsを適用すると説明。API利用ができることと価格履歴の外部配信許諾を分離し、認証・許諾確認まで停止。インスタンス作成は行わない。
- Runpod: [GraphQL仕様](https://graphql-spec.runpod.io/)、[公式datacenter資料](https://github.com/runpod/docs/blob/main/runpodctl/reference/runpodctl-datacenter.mdx)はUS-GA-1の例を含む。[規約](https://www.runpod.io/legal/terms-of-service)は自動アクセス・体系的なデータベース作成に制約を置く。正規APIの本用途への適用範囲を確認するまで停止。サンプルの在庫をlive availabilityと扱わない。

GPU型・adapter interfaceは src/gpu.ts。入力はpolicy版、証拠、提供地域、GPU仕様、台数、契約/割込み条件、課金単位、税、availabilityの証拠。schema検証後に共通取得/保存/公開gateへ接続する。ノード価格を勝手に単GPU価格にしない。月額時間換算は別仮定が必要。具体的GPU collectorはPhase 2。

## 後続台帳

memory / electricity / rates_credit / capex_utilization / gpu_index は候補名のみ。operatorやendpointを捏造せずnull/未選定。権限9区分すべてreview_required、disabled。HBMの日次spot、GPU先物の実在/開始日/清算指数は未確認。報道値、推定、契約、実取引、提示を区別してから追加する。
