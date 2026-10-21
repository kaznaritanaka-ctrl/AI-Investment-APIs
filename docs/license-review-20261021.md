# データソース ライセンス／再配布可否レビュー（確認日 2026-10-21 JST）

判定ルール（Kaz 指示）: 再配布を明示的に許可（CC-BY/CC0/MIT/明示許諾 等）→ 公開（出典表示付き）。自動取得・再配布禁止 → 収集しない。再配布の記載なし → 研究用・非公開（ソース別grantと保存ゲートが必要）。曖昧 → 非公開＋要確認フラグ。
本レビュー単独では取得を許可しない。最新のKaz決定（2026-10-21T13:45Z）ではHighresoのみ承認し、Rebroはdeferred。Highresoの取得・非公開保存・内部分析をallowed、正規化履歴365日、公開・再配布・外部LLM・AI学習はdeniedとする。保存済み実HTMLの指紋・wire確認と翌朝の残件は[デプロイ前チェックリスト](private-gpu-deploy-checklist.md#approval-20261021)を参照。Highreso enabled=trueだがWranglerフラグはfalse。Rebroはenabled=false、取得・保存・分析はreview_required。下の21:06 JSTの記録は変更前の根拠履歴として残す。

| source_id | 提供元 | ライセンス/規約 | 判定 | 出典表示 | 商用 | 主な理由 | URL |
|---|---|---|---|---|---|---|---|
| <a id="ecb"></a>ecb | European Central Bank | ESCB statistics reuse policy（無償再利用） | **公開**（現状維持） | 必須「Source: ECB statistics.」、改変は明示 | 商用可（"irrespective of any subsequent commercial or non-commercial use"） | 再利用を明示許可。条件: 出典表示・原系列/metadata非改変・第三者データ除外 | https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html |
| <a id="models_dev"></a>models_dev | Models.dev | MIT（repo root LICENSE） | **公開**（現状維持・選定field/正規化のみ、raw配信は不可のまま） | MIT著作権表示＋許諾文の同梱 | 可 | MITは publish/distribute/sublicense/sell を許可。ただしsoftware向けライセンスの適用はDB記載の数値に限定（既存policy） | https://github.com/anomalyco/models.dev/blob/dev/LICENSE |
| <a id="openrouter"></a>openrouter | OpenRouter | Terms of Service | **非公開**（明示禁止） | – | 不可 | 「scrape or copy any information on the Site or the Services」を自動手段で行うことを禁止 | https://openrouter.ai/terms |
| <a id="runpod"></a>runpod | Runpod | Terms of Service（2026-03-24版） | **非公開**（明示禁止） | – | 不可 | 「Systematically retrieve data … to create … a collection, compilation, database … without written permission」禁止、データマイニング/スクレイパー禁止 | https://www.runpod.io/legal/terms-of-service |
| <a id="lambda"></a>lambda | Lambda | Terms of Service | **非公開**（記載なし） | – | 不明 | 価格データの再配布許諾の記載なし（クロールは負荷制限下のみ言及） | https://lambda.ai/legal/terms-of-service |
| <a id="gpusoroban"></a>gpusoroban | ハイレゾ（GPUSOROBAN） | 現行（改定2025-09-30）＋新版（最終改定2026-08-27、適用2026-11-01、国外ユーザー2026-08-27） | **研究用・非公開**（再配布記載なし） | 原出典を保持 | 再配布不可 | 呼び出し側が2026-10-21 21:06 JST取得した保存本文を確認。両版第19条にscraping/自動収集/crawlの明示禁止なし。過度の負荷・知財侵害・リバースエンジニアリングは禁止、第13条等の知財は当社らに帰属。robotsはUser-agent:*で禁止なし。新版確認済みのため11/1はreview期限とせず、次回2027-01-15。ただし指紋の不一致は停止 | https://soroban.highreso.jp/terms 、https://soroban.highreso.jp/5401872 、https://soroban.highreso.jp/robots.txt |
| <a id="rebro"></a>rebro（研究候補） | GPU買取センター / Rebro | 通信買取規約 /rules/ 第10条・/reason/・robots.txt（別のサイト利用規約は公開未確認） | **見送り（deferred）・収集しない** | 原出典を保持 | 再配布不可 | Kaz 22:45 JST決定: /rules/ 第10条（査定・買取目的外の行為/当社が不適当とする行為）と未公開のサイト利用規約のリスクにより見送り。呼び出し側が2026-10-21 21:06 JST確認。/reason/保存本文も確認。/rules/は通信買取規約で、言及される別のサイト利用規約は2026-10-21の呼び出し側調査で公開先なし。第10条にscrapingの明示禁止はないが、査定・買取目的外、当社が不適当とする行為、運営妨害・迷惑行為の禁止は研究巡回への適用リスクが残る。robotsはUser-agent:* Allow:/、Content-Signal: search=yes,ai-train=no,use=reference。学習クローラは個別Disallow。再配布許諾なし、AI学習・外部LLM処理不可 | https://gpu-kaitori.com/reason/ 、https://gpu-kaitori.com/rules/ 、https://gpu-kaitori.com/robots.txt |
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

確認はネットワークを使わず保存済み本文で行った。`work/https___soroban.highreso.jp_terms.txt`、`work/hr_notice.txt`、`work/https___gpu-kaitori.com_rules_.txt` は抽出テキストであり、生HTMLではない。`termsFingerprint` はHTML構文検証後のテキストを正規化するため、この抽出テキストから実応答に一致するhashを保証できない。terms_sha256はnullを維持し、実応答との指紋一致確認はデプロイ前の残件とする。生本文をGitやCI artifactへ含めない。`work/https___gpu-kaitori.com_reason_.txt`も本修正で確認した。買取理由・選別された買取実績・ページ末尾のリンク一覧を含む抽出本文に、データ再利用や自動収集の許諾はない。生HTMLやリンク先全体の内容確認を意味しない。

Rebroの`/rules/`は「通信買取（宅配買取）」の利用を定める**通信買取規約**であり、一般のサイト利用規約そのものではない。冒頭に別の「サイト利用規約」への言及がある。2026-10-21の呼び出し側の確認結果では、そのサイト利用規約はサイト上に公開されていない（`/terms/`等の候補は404、sitemapにも掲載なし）。本修正はネットワーク禁止のため再取得せず、この確認結果を記録する。未公開文面を確認済み・許諾済みとは扱わない。

第10条の「査定・買取を目的としていない行為」「その他，当社が不適当とする行為」は、研究の自動巡回にも適用される可能性がある。通信買取契約への条項か、一般閲覧にも及ぶかが明確でなく、scrapingという語がないことだけで無条件に安全とは判断しない。既存の非公開研究準備grantの範囲を広げず、要確認リスクとして残す。明示的禁止が判明した場合は取得停止し、Kazに報告の上、保存権と削除義務を既存手順で再評価する。

robots本文は保存されたrobots.txtを既存の`robotsFingerprint`形式で計算し、本修正でも実装関数による再計算と設定値の一致を確認した。厳密な手順は、UTF-8文字列として読み、`body.replace(/\r\n/g, "\n").trim()`（JavaScriptのtrimで前後の空白・末尾改行を除去）を適用し、結果のUTF-8バイト列のSHA-256を小文字16進64桁にする。内部の空白や単独CRは置換しない。生ファイル全体のSHA-256とは区別する。

| source | 正規化後SHA-256（設定と一致） |
|---|---|
| Highreso | `afe52e7c75ac2596bae07625f23c224be2ddaea397da7a3434c4a91107a0f446` |
| Rebro | `a0da93ca346f42217e2b66cc3fde0790792c9dbd4bf506a3966426c9f76dc99f` |

Rebroの生ファイルの指紋が異なるのはこの正規化による。Content-Signalと個別crawler規則もhashに含む。robots許可は再配布許諾ではない。Highresoの新版確認は取得権限の無制限更新を意味せず、将来の未確認文面・指紋変更時は取得前に停止する。

Highresoは2026-10-31T15:00Z（11/1 00:00 JST）以降も`/terms`を第一候補とし、確認済み新版の`next_terms_sha256`を照合する。それより前は`terms_sha256`を使う。新版の掲載が`/5401872`にしかない場合は、レビューした非secret設定`public_access.highreso_terms_fallback=true`でこの固定URLへ切り替える。1 run最大3 HTTPを守るため、同じrunで404のあとに4要求目を追加する自動切替は行わない。404や未確認指紋は価格取得前に停止する。切替後の再取得には新policy版の明示登録と日次予算の確認が必要。両指紋は引き続きnullで、既存HTML指紋形式による実応答確認を推測で置き換えない。Rebroでは新版指紋とHighreso専用fallback設定を拒否する。

## 22:45 JST承認後の更新

13:45Zの最新承認を準備承認より優先する。Highresoの生HTML/robotsは呼び出し側が13:46ZにPUBLIC_GPU_UAで取得済みのwork/live内ファイルからオフライン検証した。現行/新版規約のtermsFingerprintと価格48観測のwire確認は完了し、設定へ指紋を記録した。[wire確認の詳細](private-gpu-deploy-checklist.md#wire-20261021)を現在の状態とする。以前の「terms_sha256=null」「両候補allowed」は21:06の準備時点の記録。Rebroは最新決定で見送り、再開承認はない。R2実ルールの確認は翌朝の未完了項目であり、今回Cloudflareへ接続・変更していない。
