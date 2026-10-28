# EffectStory 価格表のライセンスレビュー（2026-10-29）

対象は [EffectStory「Cloud GPU Hourly Pricing (updated monthly)」](https://effectstory.com/en/data/cloud-gpu-pricing) の Full table。Kaz は 2026-10-29 00:00 JST に「EffectStoryも追加して進めて」と、このデータの公開を承認した。権利確認日 `rights_checked_at` は 2026-10-29。

呼び出し側が正直な User-Agent で 2026-10-29 に確認した事実として、ページは「Licensed CC BY 4.0: reuse freely, credit EffectStory and link back to this page.」と記載し、JSON-LD の license は [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)、dateModified は 2026-10-26。robots.txt は `User-agent: *` に対して `/` を許可し、`/admin/`、`/studio/`、`/api/` を禁止している。robots の許可は再配布権の根拠ではない。本変更時の確認はこの提供済み記録に基づき、再取得していない。

判定は **明示禁止の上流提供者を除外したうえで出典付き公開可**。公開する各行にライセンスと以下の帰属表示を付ける。

> Data: EffectStory, Cloud GPU Hourly Pricing (https://effectstory.com/en/data/cloud-gpu-pricing), CC BY 4.0

価格は各プロバイダー自身の価格ページを元にしている（JSON-LD `isBasedOn` に例として CoreWeave）。それら上流ページのライセンスは未確認であり、この判断は上流から直接収集・再配布する許諾を意味しない。EffectStory の掲載値と条件をそのまま追跡可能にし、元価格の正確性・最新性や上流の権利確認を保証しない。公開範囲は EffectStory の承認済み価格表に限定し、Price of Compute、Highreso/GPUSOROBAN、研究データへは広げない。

ただし、明示禁止が確認済みの [RunPod](license-review-20261021.md#runpod)（体系的取得による collection / compilation / database の作成等を禁止）と [OpenRouter](license-review-20261021.md#openrouter)（自動手段での情報の scrape / copy を禁止）は、この二次ソース経由でも保存前に除外する。非公開保存も不可。理由と根拠は `config/sources/effectstory.json` の `policy.excluded_upstream_providers` に記録する。前後空白・大文字小文字を無視した提供者名／別名の完全一致で判定し、`RunPod`、`Runpod`、`Runpod.io` を含む。対象行は証拠・archive・正規化履歴・公開データへ残さず、件数のみを `effectstory.dropped_count` メタデータに残す。最大 50 行は除外前に適用する。実装と再開時の検査は [EffectStory の保存規則](effectstory.md#retention) を参照。

呼び出し側が提示した現行ページの内訳は全 22 行中 RunPod 4 行（他の除外対象がなければ残り 18 行）。本変更はネットワーク禁止のため、この内訳および規約を再取得していない。合成テストの行数や価格は実ページの保存ではない。
