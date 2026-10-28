# EffectStory GPU 価格表

## 範囲と権利

`effectstory` は [Cloud GPU Hourly Pricing](https://effectstory.com/en/data/cloud-gpu-pricing) の Full table を定期的に読む有効な公開ソース。所有者の 2026-10-29 承認、CC BY 4.0、表示条件、上流価格ページのライセンス未確認は [権利レビュー](license-review-effectstory-20261029.md) を参照。二次カタログの掲載価格であり、プロバイダーの実際の請求価格や在庫を保証しない。

<a id="retention"></a>

## 取得と保存

既存の continuation Cron `*/5 18-23 * * *` の 18:00 UTC（翌日 03:00 JST）枠で固定ページを直接取得する。EffectStory の論理日次枠も 18:00 UTC とし、Models/PoC の 18:17 UTC 枠と分ける。既存の正直な User-Agent を使い、最大 2,000,000 bytes、最大 50 行。上限は上流提供者の除外前に測り、51 行以上は切り詰めず全体を拒否する。HTTP の前に永続的な予約を記録し、失敗も含め 1 source・UTC 日あたり最大 1 HTTP に制限する。18:05 / 18:10 UTC 枠は保存済みの投影証拠からのみ再開し、新規 HTTP を行わない。18:15 UTC 枠は保持期限処理に使う。通常の Models/PoC continuation と watchdog は EffectStory を処理しない。バックフィルはしない。

`config/sources/effectstory.json` の `policy.excluded_upstream_providers`（理由・根拠参照付き）に従い、RunPod と OpenRouter の行は投影証拠を作る前に捨てる。提供者名の前後の空白と大文字小文字を無視し、名前または別名へ完全一致させる（`RunPod`、`Runpod`、`Runpod.io` を含む）。明示禁止の根拠は [RunPod](license-review-20261021.md#runpod) と [OpenRouter](license-review-20261021.md#openrouter)。非公開保存も行わず、R2 の evidence/archive、private/public D1、ログへ対象行の内容を残さない。除外件数だけを投影証拠の `effectstory.dropped_count` に記録し、coverage の件数は除外後の対象行数とする。全行が除外されれば対象行数は 0、除外件数だけが残る。設定の欠落・必要な別名や根拠の欠落は権利ゲートとオフライン配備前検査で停止し、保存済み投影の再開時にも対象提供者の混入を拒否する。policy はこの制限を含む v2 とする。

呼び出し側から提示された現行ページの内訳は全 22 行中 RunPod 4 行。ほかに除外対象がなければ保存対象は 18 行となる。本変更ではネットワークを使わず、この内訳を再取得・再確認していない。

HTML 表を決定的に解析し、未知の構造、必須ヘッダーの欠落、価格の解釈失敗は停止する。生 HTML は public D1 に置かず、R2 は既存の最小投影証拠と保持ルールを使う。今回はネットワーク禁止のため実ページの HTML 形状を再検証していない。対応していない実際のマークアップは停止するため、最初の自然な収集結果を確認する。

既存の GPU snapshot 規約に従い、変更がなくても取得日ごとに不変の snapshot を作る。取得日時は上流価格の更新日時や鮮度を保証しない。運用上の保持期間は証拠 7 日、archive 7 日、正規化履歴 180 日、backup 30 日。権利 policy の再確認期限は 2027-01-27 で、CC BY 4.0 自体の失効日を意味しない。

## 公開の内容と確認

既存の `gpu_rental` と public projection を使い、新しい migration は不要。`/v1/latest?dataset=gpu_rental&source=effectstory` と `/v1/observations?dataset=gpu_rental&source=effectstory` で価格を確認でき、`/v1/gpu/coverage?dataset=gpu_rental&source=effectstory` で完全取得の状態を確認できる。各行の `value.provider`、`value.accelerator_model`、`value.amount_decimal` はそれぞれ提供者、カタログによる識別モデル、十進文字列の USD/GPU-hour。`value.effectstory` に `gpu_label`、`basis`、`checked_date`、`source_url` を保持し、`source_date` は `checked_date`。モデルが不明なら null として掲載ラベルを保持する。basis から地域、契約、GPU 台数などを推測しない。不明な属性は null、二次ソースとして独立サンプルの統計から除外する。

各行に `reuse.license_url` と `attribution` を付ける。表示は `Data: EffectStory, Cloud GPU Hourly Pricing (https://effectstory.com/en/data/cloud-gpu-pricing), CC BY 4.0`。公開は EffectStory の行に限り、Price of Compute、Highreso/GPUSOROBAN、研究データは public D1 に渡さない。

## Shared budget

PR #43 の [PoC 3 SKU 拡張レビュー](price-of-compute-integration.md#private-sku-extension-20261029) に合わせ、18:17 UTC 後は Models 54 枠＋非公開 PoC の `h100-sxm`・`b200`・`b300` 各 4 枠（収集/確定 2＋保持期限処理 2）＋余裕 2 枠＝68 枠。既存 Cron の 18:20〜23:55 UTC にある 68 continuation 枠をすべて使う見積もりであり、EffectStory を足す余地はない。SKU 数も余裕 2 枠も維持する。

EffectStory は同じ既存 Cron の前半 4 枠を専用に使う。Cron の追加・変更はしない。

| UTC（翌日 JST） | 用途 | 最大枠数 |
| --- | --- | --- |
| 18:00（03:00） | 1 ページ・最大 50 行の取得と保存開始 | 1 |
| 18:05 / 18:10（03:05 / 03:10） | 保存済み証拠の処理・完全 snapshot 確定（50 行全置換を含む） | 2 |
| 18:15（03:15） | 180 日を超えた snapshot 1 件・最大 50 行の保持期限処理 | 1 |

保持期限処理は公開撤回を先に行い、50 行を削除した場合も membership が空になったことを確認して、その枠内で snapshot を purged にする。EffectStory は派生統計を作らないため、通常運転では 1 日 1 snapshot の削除をこの 1 枠で処理できる。各枠は既存 Paid の invocation ごとの SQL 上限内で処理し、収集と保持期限処理は同じ invocation に重ねない。

オフライン配備前検査は前半 4 枠を確保する正確な Cron 設定と既存の source 上限・権利レビューを確認する。後半は引き続き 54＋12＋2＝68 を検査する。再開対象の source を SQL の LIMIT より前に絞り、前半に残った EffectStory の未完了 run が Models/PoC の枠を消費したり、PoC の run が前半の再開を妨げたりしないようにする。

これらは通常運転・失敗なしの枠見積もりであり、遅延・再試行や保持処理の滞留時に完了を保証しない。前半で未完了でも後半へ枠を借りず、不完全な取得を完全と表示しない。失敗・欠落した 18:00 の HTTP を後続枠でやり直さず、保存済み証拠のみを処理する。保持期限超過のデータは既存の読取 gate で非表示となり、滞留は運用確認の対象とする。

## 人による配備と確認

Claude Code の相互レビュー承認とテスト・CI 成功後に、人が配備する。既存 private R2 の `evidence/effectstory/` と `archive/effectstory/` に 7 日の lifecycle を設定・確認する。既存の Cron、フラグ、ドメイン、本番設定を維持して Collector と API の両方を dry build で確認してから配備する。API にはカタログ、OpenAPI、公開 source metadata が含まれる。migration は不要。

手動収集は行わず、最初の自然な日次枠の後に coverage が complete であること、価格が十進文字列であること、各行の `checked_date`・出典・CC BY 4.0 URL が正しいことを確認する。公開 API に Price of Compute、Highreso/GPUSOROBAN、研究データが出ないことも確認する。未完了や取得失敗を空の完全 snapshot と見なさず、必要なら直前版へ戻す。
