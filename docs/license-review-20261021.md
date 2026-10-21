# データソース ライセンス／再配布可否レビュー（確認日 2026-10-21 JST）

判定ルール（Kaz 指示）: 再配布を明示的に許可（CC-BY/CC0/MIT/明示許諾 等）→ 公開（出典表示付き）。明示禁止 or 記載なし → 研究用・非公開。曖昧 → 非公開＋要確認フラグ。
本レビューは「収集の許可」を新たに与えるものではない（disabled のソースは disabled のまま）。

| source_id | 提供元 | ライセンス/規約 | 判定 | 出典表示 | 商用 | 主な理由 | URL |
|---|---|---|---|---|---|---|---|
| <a id="ecb"></a>ecb | European Central Bank | ESCB statistics reuse policy（無償再利用） | **公開**（現状維持） | 必須「Source: ECB statistics.」、改変は明示 | 商用可（"irrespective of any subsequent commercial or non-commercial use"） | 再利用を明示許可。条件: 出典表示・原系列/metadata非改変・第三者データ除外 | https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html |
| <a id="models_dev"></a>models_dev | Models.dev | MIT（repo root LICENSE） | **公開**（現状維持・選定field/正規化のみ、raw配信は不可のまま） | MIT著作権表示＋許諾文の同梱 | 可 | MITは publish/distribute/sublicense/sell を許可。ただしsoftware向けライセンスの適用はDB記載の数値に限定（既存policy） | https://github.com/anomalyco/models.dev/blob/dev/LICENSE |
| <a id="openrouter"></a>openrouter | OpenRouter | Terms of Service | **非公開**（明示禁止） | – | 不可 | 「scrape or copy any information on the Site or the Services」を自動手段で行うことを禁止 | https://openrouter.ai/terms |
| <a id="runpod"></a>runpod | Runpod | Terms of Service（2026-03-24版） | **非公開**（明示禁止） | – | 不可 | 「Systematically retrieve data … to create … a collection, compilation, database … without written permission」禁止、データマイニング/スクレイパー禁止 | https://www.runpod.io/legal/terms-of-service |
| <a id="lambda"></a>lambda | Lambda | Terms of Service | **非公開**（記載なし） | – | 不明 | 価格データの再配布許諾の記載なし（クロールは負荷制限下のみ言及） | https://lambda.ai/legal/terms-of-service |
| <a id="gpusoroban"></a>gpusoroban | ハイレゾ（GPUSOROBAN） | 利用規約 | **非公開**（記載なし） | – | 不明 | 第13条: サイト・サービスの知的財産権は当社らに帰属。データ再配布の許諾記載なし | https://soroban.highreso.jp/terms |
| <a id="rebro"></a>rebro（未設定・候補G3） | GPU買取センター / Rebro | 記載なし | **非公開**（記載なし） | – | 不明 | Q&A/事例ページにデータ利用・二次利用条件の記載なし | https://gpu-kaitori.com/q-a/ |
| <a id="sakura_dok"></a>sakura_dok | さくらインターネット | 約款一覧 | **非公開**（記載なし） | – | 不明 | 価格APIデータの再配布許諾の記載を確認できず | https://www.sakura.ad.jp/corporate/agreement/ |
| <a id="ccir"></a>ccir | CCIR | Data Terms | **非公開**（明示制限・書面許諾必要） | 引用時は「CCIR (ccir.io)」＋系列ID・日付 | 書面許諾が必要 | 「Systematic or bulk retrieval …, redistribution of series or series history … require written permission」 | https://ccir.io/documents/data-terms |
| <a id="price_of_compute"></a>price_of_compute | Price of Compute | API ページ記載 | **非公開**（曖昧・要確認⚠） | 「Data: Price of Compute」リンク必須 | 記載なし | 「Free use requires a visible link」と無償利用は認めるが、再配布・商用の範囲は明記なし。上流（Runpod等）の規約とも衝突しうる | https://www.priceofcompute.com/api |
| <a id="ebay_browse"></a>ebay_browse | eBay | API License Agreement | **非公開**（要確認⚠） | – | 不明 | 規約ページがJS描画で本文を取得できず条項未確認。再配布許可の確認なし→非公開 | https://developer.ebay.com/join/api-license-agreement |
| <a id="capex_utilization"></a><a id="electricity"></a><a id="gpu_index"></a><a id="memory"></a><a id="rates_credit"></a>capex_utilization / electricity / gpu_index / memory / rates_credit | 未選定 | 提供元未定 | **非公開**（記載なし） | – | – | 提供元未選定のためライセンス評価不能 | – |
| <a id="eia"></a>eia（研究案） | U.S. EIA | Public domain | 公開可能な条件（ただし収集はブロック中のまま） | EIA を出典として表示（推奨） | 可 | 「U.S. government publications are in the public domain … You may use and/or distribute any of our data」 | https://www.eia.gov/about/copyrights_reuse.php |
| <a id="jepx"></a>jepx（研究案） | JEPX | 免責事項・著作権 | **非公開**（曖昧・要確認⚠） | 出所明示 | 記載なし | 「著作権は本所にあります。利用する場合は、出所を明示した上で」— 利用は可とも読めるが再配布の明示許諾ではない | https://www.jepx.jp/disclaimer/ |

## 注意
- 公開APIやドキュメントのライセンスを、レスポンスデータの再配布権と読み替えていない（repo の rights-policy に従う）。
- EIA/JEPX は研究提案（config/proposals/research）で、収集はブロックされたまま。判断は記録のみ。
- 法的助言ではない。⚠ の3件（price_of_compute, ebay_browse, jepx）は提供元への書面確認で公開可否が変わりうる。
