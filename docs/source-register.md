# ソース台帳 — Phase 0

## 2026-10-22 e-Stat公開用2統計（所有者承認済み・収集無効）

所有者承認 `Kaz owner approval 2026-10-22T09:43Z estat` を反映し、経済産業省生産動態統計00550200と鉱工業指数00550300を `config/sources/estat_meti_seidou.json` / `estat_meti_iip.json` に登録した。取得・非公開保存・内部分析・公開表示・正規化再配布・派生再配布・商用再配布はallowed、raw再配布と外部LLM処理はdenied。両sourceはenabled=false、ESTAT_ENABLEDもfalse。新しい実観測・実HTTP・Secret作成・本番操作は0件。

提供済みの2026-10-22規約調査と所有者判断を根拠とし、対象をMETI自身の統計に限定する。外部DB・第三者コンテンツは含めず、出典・加工明示・APIクレジットを付ける。[統合設計と根拠](supply-chain-stats.md#rights)に利用条件・取得範囲・保持・マスク運用・未検証事項を記録した。従来の候補sourceに許諾を広げるものではない。

## 2026-10-21 ライセンスmetadataレビュー

所有者委託の[ライセンス／再配布レビュー](license-review-20261021.md)を既存のterms_url/license_url、rights_checked_at、rights_evidence_ref、attribution_text、known_limitationsとpolicyへ記録しました。ライセンス名・再配布判断は下表とknown_limitations、機械判定は既存9権限で表現し、新schemaは追加しません。disabled設定の確認日時は`2026-10-21T00:00:00.000Z`です。これは提供元への再照会や実データ取得の日時ではありません。

| source_id | ライセンス／規約・根拠 | 再配布判断・表示条件 |
|---|---|---|
| ecb | [ESCB statistics reuse policy](license-review-20261021.md#ecb)（独自利用条件） | 既存公開範囲維持。Source: ECB statistics.、metadata維持、加工明示、第三者データ除外 |
| models_dev | [MIT](license-review-20261021.md#models_dev) | 承認済み5 provider / 17 fieldの数値・識別子・条件のみ。MIT全文通知、raw配信denied維持 |
| openrouter | [Terms of Service §7](license-review-20261021.md#openrouter) | 自動scrape/copy禁止を記録。公開5権限denied、新policy版。取得等はreview_required |
| runpod | [Terms of Service 2026-03-24](license-review-20261021.md#runpod) | 書面許諾なしの体系的取得・DB化／scraper禁止。公開5権限denied、新policy版。取得等はreview_required |
| ccir | [Data Terms](license-review-20261021.md#ccir) | 系列・履歴再配布等は書面許諾必要。公開5権限denied、新policy版。引用時CCIR (ccir.io)・系列ID・日付、引用条件を配布許可にしない |
| lambda | [Terms of Service](license-review-20261021.md#lambda) | 価格データ再配布許諾の記載未確認。非公開、全権限review_required |
| gpusoroban | [利用規約 第13条](license-review-20261021.md#gpusoroban) | 知財帰属条項あり、データ再配布許諾記載なし。非公開、全権限review_required |
| sakura_dok | [約款一覧](license-review-20261021.md#sakura_dok) | API価格データの再配布許諾未確認。非公開、全権限review_required。文書CCライセンスを転用しない |
| price_of_compute | [APIページの利用条件](license-review-20261021.md#price_of_compute) | Data: Price of Computeと可視リンクが条件。再配布・商用範囲／上流条件は曖昧。2026-10-06オーナー承認済みの非公開H100-SXM PoC（enabled=true）で、限定範囲の収集・非公開保存・内部分析はallowed、外部LLM処理・raw再配布はdenied。公開不可（公開表示・正規化／派生／商用再配布はreview_required） |
| ebay_browse | [API License Agreement](license-review-20261021.md#ebay_browse) | JS描画で本文・条項未確認。非公開、全権限review_required |
| capex_utilization | [提供元未選定](license-review-20261021.md#capex_utilization) | terms_url/license_url=nullの理由: 提供元・dataset未選定、評価不能。非公開、全権限review_required |
| electricity | [提供元未選定](license-review-20261021.md#electricity) | terms_url/license_url=nullの理由: 提供元・dataset未選定、評価不能。研究EIA/JEPXとは別。非公開、全権限review_required |
| gpu_index | [提供元未選定](license-review-20261021.md#gpu_index) | terms_url/license_url=nullの理由: 提供元・dataset未選定、評価不能。非公開、全権限review_required |
| memory | [提供元未選定](license-review-20261021.md#memory) | terms_url/license_url=nullの理由: 提供元・dataset未選定、評価不能。非公開、全権限review_required |
| rates_credit | [提供元未選定](license-review-20261021.md#rates_credit) | terms_url/license_url=nullの理由: 提供元・dataset未選定、評価不能。非公開、全権限review_required |
| Rebro (G3) | [Q&A／利用条件記載なし](license-review-20261021.md#rebro) | 非公開・要確認。docsのみ、source設定なし。公式feed・取得/保存/分析/継続保存の所有者確認待ち |
| eia_retail_co_ind（研究案） | [EIA public domain / reuse statement](license-review-20261021.md#eia) | 一般的な利用・配布根拠とEIA出典推奨をmetadataに記録。license_urlは命名ライセンスIDではなく公式再利用方針URL。grantなし、URLキー問題でblocked、保持unapproved |
| jepx_tokyo（研究案） | [JEPX免責・著作権](license-review-20261021.md#jepx) | 出所表示条件あり、再配布・商用の明示許諾は曖昧。非公開・要確認、grantなし、blocked・保持unapproved |

新規allowed・収集有効化は0件。OpenRouter/Runpod/CCIRの公開5権限以外は変更しません。license_url=nullは「データ再配布ライセンス未確認」を意味し、規約がないとの主張や内部取得の許可ではありません。ECB/Models.devの2026-10-21確認は本節とレビューにのみ追記し、稼働JSON全体（policy/hash・endpoint・選定・確認日時を含む）はそのまま保持します。履歴として残す以下の初期判定と異なる場合は本節を優先します。

2026-10-15追加: [全分野の実査台帳](source-expansion-20261015.md)へ、国内GPU/電力/メモリ/DC/水/ラボ/Physical AIと既存ソースの優先判断を分離しました。稼働用sourceは増やしていません。EIA/JEPXの承認待ちproposalはconfig/proposals/researchに置き、Private合成検証のみです。以下の過去台帳と10/15の配信版には差分があるため、最新のmetadata確認は追加台帳を参照してください。

10/18最終指示の反映: 次の有効化候補は[Highreso/GPUSOROBANとRebroの2件だけ](research-long-retention-20261016.md#次の有効化候補は2つだけ)。所有者が公式feed・自動取得/保存/分析・契約終了後の継続保存・認証/費用を確認します。有限holdは提供者が認める場合の任意例外で、通常取得の追加条件ではありません。許諾済みならuntil_revokedを検討し、3〜5年を自動廃棄期限にしません。内部review_dueは取得/read停止と再レビューへ進め、保存許諾内の履歴を保持します。新sourceの実観測数=0、新allowed/source enable/商用許諾=0。EIA/JEPXはblockedでcritical path外。5年容量/80%は参考でありソース獲得の停止条件ではありません。

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

## Phase 2追補（2026-09-27）

[GPU調査台帳](gpu-source-review.md)が最新のGPU確認結果です。Lambda/さくらのadapterを準備し、eBay Browse/Price of Compute/CCIRを登録しました。Runpod/Highresoはcandidateです。GPUの9権利区分は全件review_required、enabled=false。日本地域のさくら接続コードはsynthetic検証のみで、実接続済みではありません。

GPU各sourceのowner承認、4種retention、利用目的、認証とproduction用途審査は別欄として設定します。FX/AIの既存許諾は変更していません。Phase 1のlive結果を今回の検証実績として再利用しません。

## P0拡張追補（2026-09-30 JST）

Models.devの現在の生成仕様・MIT・provider設定をcommit `747925c4fb0142db3e508cac02202c2748a34cf0` で再調査しました。確認範囲はソースコード・仕様で、拡張価格カタログのlive収集成功ではありません。[根拠とfield案](models-expansion.md#policy-proposal)、[承認待ち設定](../config/proposals/models_dev.v3.json)を参照してください。

| source / scope | 接続コード・synthetic | 認証 | 権利・有効化 | 今回のlive / 本番 |
|---|---|---|---|---|
| ECB既存2原系列 | 既存実装・回帰試験 | 不要 | 既存enabled・grant維持 | 未実行 / 稼働未検証 |
| Models.dev Mistral既存2モデル | 旧経路維持・回帰試験 | 不要 | v2 enabled・grant維持 | 未実行 / 稼働未検証 |
| Models.dev openai/anthropic/google/xai/mistral | catalog/価格/履歴/coverage実装、50/250/1000合成試験 | 不要 | v3提案、provider/field/9区分/retention・実行予算の承認待ち | 未実行 / deploy・拡張開始待ち |
| Lambda / さくら / eBay / Price of Compute | 既存Phase 2 adapter・回帰試験 | 既存台帳のSecret名参照、今回値の確認なし | disabled、権利待ち維持 | 未実行 / 未開始 |
| Runpod / Highreso / CCIR | 既存候補・調査のみ | 未確定 | disabled、仕様/権利待ち | 未実行 / 未開始 |

後続分野を重複台帳や大量のdisabledファイルとして増やしません。P1のrate limit/tierは公開条件とアカウント固有枠を分離、agent/tool価格はrequest・時間・storage単位の拡張が必要です。P2メモリーは規格/spot/contract/retailと利用契約、電力はEIA等の正式仕様・キー・改定履歴、benchmarkは版・測定条件・データ配布権を確認してから接続します。今回それらの最新権利調査・adapter追加は未実施です。P3金利/信用/DC案件も既存候補のままです。これらをP0の実装・レビューの前提にはしません。

## 2026-10-22 DC案件トラッカー（非公開・8社grant承認済み、配備未実施）

[統合設計の更新](dc-project-tracker.md#dc-sources-20261022)に従い、自動取得をブロックするMETI候補を削除。Kaz owner approval 2026-10-22T09:43Z dc-sourcesを根拠に、ソフトバンク・KDDI・さくら・Highreso企業ニュース・GMO・MCDR・EdgeConneX・NTT DATAをHighreso GPUと同じprivate research設定へ登録した。指定番号の11案件を追跡し、取得・非公開保存・内部分析のみallowed。外部LLM本文送信と公開5権限はdenied、365日履歴/7日証拠。DC_TRACKER_ENABLEDはfalseで、配備・実取得・ネットワーク照会は未実施。既存Cronの月曜UTC枠を使うコードを追加したが新Cronはない。config/sourcesと公開APIは変更しない。TDnet、EDINET、自治体、OCCTOは引き続き個別の規約/wire/保持/承認前に取得も保存もしない。新聞・業界誌・調査会社は対象外。
