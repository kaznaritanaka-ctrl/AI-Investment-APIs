# データ辞書

schema_versionは1。金額・rateはdecimal string。欠損null、実際の数値0、未知条件unknownを区別する。JSON numeric tokenはlossless-jsonで元の十進表記を維持し、decimal.jsで計算する。

共通: observation_id、source_id、source_policy_version、source_record_key、entity_key、scheduled_for、observed_at、source_published_at、source_effective_at、source_date、first_seen_at、recorded_at、native_frequency、source_url、raw_artifact_ref、raw_payload_hash、record_fingerprint、collector_version、parser_version、schema_version、observation_basis、quality_status、quality_flags、supersedes_observation_id。

observed_atはHTTPを検証した時刻、recorded_atは永続化時刻、first_seen_atは同じ内容を最初に記録した時刻。source_dateを00:00の公開時刻に置き換えない。モデルrelease_date/last_updatedを価格適用日時に流用しない。後日の再解析はobserved_atを維持しrecorded_atだけを進める。

private D1: sources、source_policy_versions、collection_runs、fetch_attempts、raw_artifacts、observations共通表、fx_observations、ai_api_prices、quality_events、change_events、derived_observations、lineage、daily_summaries、notification_outbox。共通表のJSONには共通metadataのみ、domain JSONは型検証して別表へ保存。

public D1: source_publications（公開権限の最小投影）、publication_batches、published_observations、published_lineage、published_changes。rawキー・契約根拠・運用エラーを公開表へ入れない。

FX: base_currency=EUR、quote_currency、rate_decimal、reference_rate_type=ECB_reference、calendar=TARGET、source_date。USDJPYなどはderived_observationsに入力ID・計算版付きで別保存。

AI API: model_author/model_version/region/service_tier/provider_endpoint_idは不明ならnull。model_idとserving_providerとsourceを別にする。pricing_scope=provider_catalog（OpenRouter一覧fixtureはaggregated_catalog）。componentはinput/output/cache_read/cache_write/reasoning/input_audio/output_audio。通貨USD、Models.devはmillion_tokens、OpenRouter token。tier_conditionsとcache_ttl、tax_status、platform_fee_status、billing_notes、modality、context_limitを残す。未対応tier/課金構造は品質隔離し、無料と推定しない。

GPU型・schema・fixtureは `src/gpu.ts` と `tests/fixtures/gpu.synthetic.json`。country/regionは提供場所の証拠が必要、unknownをUSにしない。advertised_quoteはavailabilityの証拠ではない。

## Phase 2の追加

| 項目/テーブル | 意味 |
|---|---|
| gpu_rental / gpu_secondary | レンタル提示額と中古提示額等を別dataset・別domain表で保持 |
| gpu_sku_id / classification_version | 根拠付き辞書照合。不明はnull/candidate、統計除外理由付き |
| sale_unit / gpu_count_in_lot | listing/server/rackとGPU台数を区別 |
| price_scope | public / account_specific / promotion / unknown |
| observation_basis | advertised_quote / observed_transaction / third_party_reported_transaction / modeled_estimateを区別 |
| source_effective_date / until_date | 日付精度の有効範囲。UTC時刻を推測しない |
| scope_hash / scope_json | query/filter/marketplace/sort/分類版/page条件等の固定取得範囲 |
| snapshot / page / run | 日次実行、検索partitionの集合、ページcheckpoint。partialは0件でない |
| gpu_snapshot_members | 固定のrecord IDと観測ID、比較cohort、統計適格性・除外理由 |
| revises_snapshot_id / supersedes_observation_id | 元snapshot/観測を残した訂正関係 |
| observed_at / recorded_at / backfill | 元資料の取得時刻と今回の知識記録時刻を分離。過去証拠の再解析を当日の新取得とはしない |
| first_seen_at / last_seen_at | collectorの観測範囲。元の出品開始や滞留期間は推測しない |
| not_seen | 次回の同一検索範囲で未観測。成約ではない |
| gpu_metric_lineage | 入力snapshot・source/policy、必要時はFX原観測ID |
| sample_count / observed_offer_count | 統計適格な独立観測数と観測offer/listing数。GPU市場在庫ではない |
| availability_evidence | 状態が明示された割合と、その中のavailable割合。稼働率ではない |

/publicのAPI契約は[OpenAPI](../openapi.json)、計算定義は[GPU方法](gpu-methodology.md)。
