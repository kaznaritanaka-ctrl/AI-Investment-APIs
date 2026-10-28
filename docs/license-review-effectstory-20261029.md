# EffectStory 価格表のライセンスレビュー（2026-10-29）

対象は [EffectStory「Cloud GPU Hourly Pricing (updated monthly)」](https://effectstory.com/en/data/cloud-gpu-pricing) の Full table。Kaz は 2026-10-29 00:00 JST に「EffectStoryも追加して進めて」と、このデータの公開を承認した。権利確認日 `rights_checked_at` は 2026-10-29。

呼び出し側が正直な User-Agent で 2026-10-29 に確認した事実として、ページは「Licensed CC BY 4.0: reuse freely, credit EffectStory and link back to this page.」と記載し、JSON-LD の license は [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)、dateModified は 2026-10-26。robots.txt は `User-agent: *` に対して `/` を許可し、`/admin/`、`/studio/`、`/api/` を禁止している。robots の許可は再配布権の根拠ではない。本変更時の確認はこの提供済み記録に基づき、再取得していない。

判定は **出典付き公開可**。公開する各行にライセンスと以下の帰属表示を付ける。

> Data: EffectStory, Cloud GPU Hourly Pricing (https://effectstory.com/en/data/cloud-gpu-pricing), CC BY 4.0

価格は各プロバイダー自身の価格ページを元にしている（JSON-LD `isBasedOn` に例として CoreWeave）。それら上流ページのライセンスは未確認であり、この判断は上流から直接収集・再配布する許諾を意味しない。EffectStory の掲載値と条件をそのまま追跡可能にし、元価格の正確性・最新性や上流の権利確認を保証しない。公開範囲は EffectStory の承認済み価格表に限定し、Price of Compute、Highreso/GPUSOROBAN、研究データへは広げない。
