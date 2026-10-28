# EffectStory GPU 価格表

## 範囲と権利

`effectstory` は [Cloud GPU Hourly Pricing](https://effectstory.com/en/data/cloud-gpu-pricing) の Full table を定期的に読む有効な公開ソース。所有者の 2026-10-29 承認、CC BY 4.0、表示条件、上流価格ページのライセンス未確認は [権利レビュー](license-review-effectstory-20261029.md) を参照。二次カタログの掲載価格であり、プロバイダーの実際の請求価格や在庫を保証しない。

<a id="retention"></a>

## 取得と保存

既存の日次 Cron `17 18 * * *`（翌日 03:17 JST）で固定ページを直接取得する。既存の正直な User-Agent を使い、最大 2,000,000 bytes、最大 50 行。51 行以上は切り詰めず全体を拒否する。HTTP の前に永続的な予約を記録し、失敗も含め 1 source・UTC 日あたり最大 1 HTTP に制限する。continuation と watchdog は新規 HTTP を行わず、保存済みの投影証拠からのみ再開できる。バックフィルはしない。

HTML 表を決定的に解析し、未知の構造、必須ヘッダーの欠落、価格の解釈失敗は停止する。生 HTML は public D1 に置かず、R2 は既存の最小投影証拠と保持ルールを使う。今回はネットワーク禁止のため実ページの HTML 形状を再検証していない。対応していない実際のマークアップは停止するため、最初の自然な収集結果を確認する。

既存の GPU snapshot 規約に従い、変更がなくても取得日ごとに不変の snapshot を作る。取得日時は上流価格の更新日時や鮮度を保証しない。運用上の保持期間は証拠 7 日、archive 7 日、正規化履歴 180 日、backup 30 日。権利 policy の再確認期限は 2027-01-27 で、CC BY 4.0 自体の失効日を意味しない。

## 公開の内容と確認

既存の `gpu_rental` と public projection を使い、新しい migration は不要。`/v1/latest?dataset=gpu_rental&source=effectstory` と `/v1/observations?dataset=gpu_rental&source=effectstory` で価格を確認でき、`/v1/gpu/coverage?dataset=gpu_rental&source=effectstory` で完全取得の状態を確認できる。各行の `value.provider`、`value.accelerator_model`、`value.amount_decimal` はそれぞれ提供者、カタログによる識別モデル、十進文字列の USD/GPU-hour。`value.effectstory` に `gpu_label`、`basis`、`checked_date`、`source_url` を保持し、`source_date` は `checked_date`。モデルが不明なら null として掲載ラベルを保持する。basis から地域、契約、GPU 台数などを推測しない。不明な属性は null、二次ソースとして独立サンプルの統計から除外する。

各行に `reuse.license_url` と `attribution` を付ける。表示は `Data: EffectStory, Cloud GPU Hourly Pricing (https://effectstory.com/en/data/cloud-gpu-pricing), CC BY 4.0`。公開は EffectStory の行に限り、Price of Compute、Highreso/GPUSOROBAN、研究データは public D1 に渡さない。

## Shared budget

既存の [共有枠レビュー](price-of-compute-integration.md#shared-budget-20261006) は Models に保守的な 54 枠、非公開 PoC に 6 枠を見込む。EffectStory は最大 50 行・1 ページとして、追加で最大 2 continuation 枠を見込み、合計 62 枠は 18:17 UTC 後の 68 枠に収まる。これらは通常運転・失敗なしの保守的な枠見積もりであり、再試行や保持処理の滞留時に完了を保証しない。不完全な取得を完全と表示しない。

## 人による配備と確認

Claude Code の相互レビュー承認とテスト・CI 成功後に、人が配備する。既存 private R2 の `evidence/effectstory/` と `archive/effectstory/` に 7 日の lifecycle を設定・確認する。既存の Cron、フラグ、ドメイン、本番設定を維持して Collector と API の両方を dry build で確認してから配備する。API にはカタログ、OpenAPI、公開 source metadata が含まれる。migration は不要。

手動収集は行わず、最初の自然な日次枠の後に coverage が complete であること、価格が十進文字列であること、各行の `checked_date`・出典・CC BY 4.0 URL が正しいことを確認する。公開 API に Price of Compute、Highreso/GPUSOROBAN、研究データが出ないことも確認する。未完了や取得失敗を空の完全 snapshot と見なさず、必要なら直前版へ戻す。
