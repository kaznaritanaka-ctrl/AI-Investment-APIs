# データソース ライセンス／再配布可否レビュー（確認日 2026-10-21 JST）

判定ルール（Kaz 指示）: 再配布を明示的に許可（CC-BY/CC0/MIT/明示許諾 等）→ 公開（出典表示付き）。自動取得・再配布禁止 → 収集しない。再配布の記載なし → 研究用・非公開（ソース別grantと保存ゲートが必要）。曖昧 → 非公開＋要確認フラグ。
本レビュー単独では取得を許可しない。Highreso/Rebroの非公開研究準備はKazの2026-10-21T12:05Z承認に基づく。両候補の取得・保存・内部分析のみallowedとし、未確認の取得形式・保持・保存環境・規約指紋ゲートは維持する。disabledのソースはdisabledのまま。

| source_id | 提供元 | ライセンス/規約 | 判定 | 出典表示 | 商用 | 主な理由 | URL |
|---|---|---|---|---|---|---|---|
| <a id="ecb"></a>ecb | European Central Bank | ESCB statistics reuse policy（無償再利用） | **公開**（現状維持） | 必須「Source: ECB statistics.」、改変は明示 | 商用可（"irrespective of any subsequent commercial or non-commercial use"） | 再利用を明示許可。条件: 出典表示・原系列/metadata非改変・第三者データ除外 | https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html |
| <a id="models_dev"></a>models_dev | Models.dev | MIT（repo root LICENSE） | **公開**（現状維持・選定field/正規化のみ、raw配信は不可のまま） | MIT著作権表示＋許諾文の同梱 | 可 | MITは publish/distribute/sublicense/sell を許可。ただしsoftware向けライセンスの適用はDB記載の数値に限定（既存policy） | https://github.com/anomalyco/models.dev/blob/dev/LICENSE |
| <a id="openrouter"></a>openrouter | OpenRouter | Terms of Service | **非公開**（明示禁止） | – | 不可 | 「scrape or copy any information on the Site or the Services」を自動手段で行うことを禁止 | https://openrouter.ai/terms |
| <a id="runpod"></a>runpod | Runpod | Terms of Service（2026-03-24版） | **非公開**（明示禁止） | – | 不可 | 「Systematically retrieve data … to create … a collection, compilation, database … without written permission」禁止、データマイニング/スクレイパー禁止 | https://www.runpod.io/legal/terms-of-service |
| <a id="lambda"></a>lambda | Lambda | Terms of Service | **非公開**（記載なし） | – | 不明 | 価格データの再配布許諾の記載なし（クロールは負荷制限下のみ言及） | https://lambda.ai/legal/terms-of-service |
| <a id="gpusoroban"></a>gpusoroban | ハイレゾ（GPUSOROBAN） | 現行（改定2025-09-30）＋新版（最終改定2026-08-27、適用2026-11-01、国外ユーザー2026-08-27） | **研究用・非公開**（再配布記載なし） | 原出典を保持 | 再配布不可 | 呼び出し側が2026-10-21 21:06 JST取得した保存本文を確認。両版第19条にscraping/自動収集/crawlの明示禁止なし。過度の負荷・知財侵害・リバースエンジニアリングは禁止、第13条等の知財は当社らに帰属。robotsはUser-agent:*で禁止なし。新版確認済みのため11/1はreview期限とせず、次回2027-01-15。ただし指紋の不一致は停止 | https://soroban.highreso.jp/terms 、https://soroban.highreso.jp/5401872 、https://soroban.highreso.jp/robots.txt |
| <a id="rebro"></a>rebro（研究候補） | GPU買取センター / Rebro | /rules/ 第10条・/reason/・robots.txt | **研究用・非公開**（再配布記載なし） | 原出典を保持 | 再配布不可 | 呼び出し側が2026-10-21 21:06 JST確認。/reason/は買取理由ページで利用条件記載なし。/rules/第10条にscraping禁止なし、運営妨害・迷惑行為は禁止。robotsはUser-agent:* Allow:/、Content-Signal: search=yes,ai-train=no,use=reference。学習クローラは個別Disallow。再配布許諾なし、AI学習・外部LLM処理不可 | https://gpu-kaitori.com/reason/ 、https://gpu-kaitori.com/rules/ 、https://gpu-kaitori.com/robots.txt |
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

## Issue #17 非公開研究準備の根拠（2026-10-21 21:06 JST）

オーナー承認記録ref: **Kaz owner approval 2026-10-21T12:05Z**（Highreso/Rebroの非公開研究用本番収集の準備、呼び出し側から提示）。本確認文書refは本書のgpusoroban／rebro節。自動取得・非公開保存・決定的な内部分析のみallowed。raw／normalized／derived／commercial再配布、public display、external LLM処理、AI学習はdenied。AI学習は既存9権限の追加項目を作らず、conditionsとknown_limitationsにも明記する。公開/API/LLM向けの経路は追加しない。

確認はネットワークを使わず保存済み本文で行った。`work/https___soroban.highreso.jp_terms.txt`、`work/hr_notice.txt`、`work/https___gpu-kaitori.com_rules_.txt` は抽出テキストであり、生HTMLではない。`termsFingerprint` はHTML構文検証後のテキストを正規化するため、この抽出テキストから実応答に一致するhashを保証できない。terms_sha256はnullを維持し、実応答との指紋一致確認はデプロイ前の残件とする。生本文をGitやCI artifactへ含めない。/reason/の本文はworkにないため、そのページに利用条件記載なしという点は呼び出し側の確認結果に基づく。

robots本文は保存されたrobots.txtを既存の`robotsFingerprint`形式（CRLF→LF、前後trim、SHA-256）で計算した。Content-Signalと個別crawler規則もhashに含む。robots許可は再配布許諾ではない。Highresoの新版確認は取得権限の無制限更新を意味せず、将来の未確認文面・指紋変更時は取得前に停止する。

Highresoの切替処理は2026-10-31T15:00Z（11/1 00:00 JST）から固定URL`/5401872`と専用`next_terms_sha256`を使用する。現行の`terms_sha256`と新版の`next_terms_sha256`はいずれも未設定であり、各時点で必要な指紋が未確認ならHTTP前に拒否する。Rebroでは新版指紋項目の非null設定を拒否する。
