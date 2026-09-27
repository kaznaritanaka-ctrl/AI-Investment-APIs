# GPUソース調査（2026-09-27）

確認したのは公式ドキュメント・利用条件です。GPUデータAPIへの実リクエスト、契約、許諾問い合わせ、実価格の保存は行っていません。新規ソースの権利9区分はすべてreview_required、enabled=falseです。APIが存在することと、継続保存・分析・商用再配布の許可は別です。

| source | 技術確認・実装 | 認証 | 取得/保存/内部分析 | 表示/正規化/派生/商用再配布 | 現在 |
|---|---|---|---|---|---|
| Lambda | 公式instance-typesのbounded adapter、synthetic検証 | Bearer key未設定 | 未承認 | 未承認 | 停止 |
| さくら高火力DOK | 公式unit_prices、日付/page指定、日本is1a、synthetic検証 | Access token/secret未設定 | 未承認 | 未承認 | 停止 |
| Runpod | GraphQL仕様・Bearer・価格field確認、地域と条件を揃えるadapterは未実装 | key未設定 | 未承認 | 未承認 | candidate |
| Highreso/GPUそろばん | 公式利用条件確認、正規価格feed/API未確認 | 未確認 | 未承認 | 未承認 | candidate |
| Price of Compute | SKU latestのprovider投影adapter、synthetic検証 | 公開API資料では不要 | 未承認 | 未承認 | 停止、二次ソース |
| eBay Browse | search/pagination/OAuthのadapter、synthetic検証 | client ID/secret未設定、production用途審査も別 | 未承認 | 未承認 | 停止 |
| CCIR | posted ask/第三者実売記録/モデル値を調査、API未確認 | 未確認 | 未承認 | 未承認 | candidate |
| 日本中古市場 | 許諾feed未確認 | 未確認 | 未承認 | 未承認 | 未接続 |

全候補でraw再配布・外部LLM処理も未承認です。evidence/archive/normalized/backupの保持日数はGPU設定ではnullで、独立したretention reviewとowner_approval_refが揃うまでHTTP前に停止します。内部用だから取得可能とは扱いません。

## Lambda

[公式API](https://docs-api.lambda.ai/api/cloud)はGET cloud.lambda.ai/api/v1/instance-types、Authorization Bearerを定義します。price_cents_per_hourはnodeの提示額として保持し、specs.gpusを別に保存します。memory_gibはhost RAMでありGPU VRAMに使いません。GPU descriptionに明示されたmodel/VRAM/formだけを識別します。

regions_with_capacity_availableに列挙されたtype-regionを提供状況の根拠とします。空配列は任意regionの在庫0ではありません。region countryは公式に確認したus-west-1のみ設定済みで、その他の国はnullです。専有、税、最低契約等が確認できない価格はそのままunknownです。[利用条件](https://lambda.ai/legal/terms-of-service)から本用途の履歴再配布許諾は確定していません。launch等のmutationは実装しません。

## さくら高火力DOK

[公式API仕様](https://manual.sakura.ad.jp/koukaryoku-dok-api/spec.html)のis1aは石狩です。Basic認証、GET /unit_prices/、year/month/day/page/page_size、meta/count/total_pages/resultsを使います。JPY/secondの原額を保持し、begin_at/end_atは日付のまま保存します。is_overridden=trueはアカウント固有価格でpublicへ出しません。plan IDのH100/VRAMだけからSXM仕様を推測しません。

日本の提供地域が確認できる接続コードは用意しましたが、認証と権利が未確認なので実接続は0件です。仕様書のCCライセンスは価格データの再配布許可ではありません。規約同意APIへのPOSTやGPU実利用は行いません。

## Runpod / Highreso

[Runpod公式GraphQL](https://graphql-spec.runpod.io/)はapi.runpod.io/graphqlとBearer認証、gpuTypesのsecurePrice/communityPrice/spot等を記載します。[公式サンプル](https://github.com/runpod/docs/blob/main/sdks/graphql/manage-pods.mdx)もあります。global type価格を根拠なく日本regionのofferへ帰属させません。region/構成/interruptibilityを再現できる読取queryの選定とadapter実装が残ります。[利用条件](https://www.runpod.io/legal/terms-of-service)の確認だけで再配布可とはしていません。

[Highreso公式利用条件](https://soroban.highreso.jp/terms)を確認しました。機械取得可能な正規価格feedと履歴保存・再配布許諾が未確認です。任意ページのscrapingで補完していません。

## eBay

[Browse API概要](https://developer.ebay.com/api-docs/buy/api-browse.html)、[在庫検索ガイド](https://developer.ebay.com/develop/guides/buy/inventory-discovery-and-refresh-guide)、[OAuth公式ガイド](https://developer.ebay.com/develop/guides/sell/authorization)を参照。searchはGET api.ebay.com/buy/browse/v1/item_summary/search。OAuthはPOST api.ebay.com/identity/v1/oauth2/token、client_credentials、application scopeです。

[production要件](https://developer.ebay.com/api-docs/buy/buy-requirements.html)と[API License Agreement](https://developer.ebay.com/join/api-license-agreement)は別確認事項です。本プロジェクトの履歴分析・再配布用途の承認を得たことにはしていません。現在のqueryはA100/H100、EBAY_US、USED、FIXED_PRICE、newlyListed。offset上限は保守的に10,000、さらにsource別page上限で停止します。上限到達時はpartialです。次URLを再構成した許可URLと照合し、任意リンクを追いません。

出品IDを使った履歴保存自体も利用条件の確認対象です。価格はask、消失はnot_seen。一般公開の実売APIがあるとは仮定しません。日本の中古市場をeBay USや未許諾scrapingで代用しません。

## 補助ソース

[Price of Compute公式API](https://www.priceofcompute.com/api)には日次1,000 request、帰属、1時間以上のcache推奨、listed priceであってavailability保証ではないことが記載されています。今回はlatestだけ準備し、historyの新規backfillは実装していません。provider quoteを二次観測として保存し、origin offerの同一性が証明できないため独立サンプル数へ足しません。商用API再配布の許諾は未確定です。

[CCIR Hardware](https://ccir.io/hardware)は推計・posted ask・第三者によるexecuted記録を区別しています。本プロジェクトでは後者を一次検証済み成約に読み替えません。確認できないAPI/CSVを作っていません。

## 許諾確認の文案（未送信）

「GPU市場研究のため、貴社の指定読取APIから日次で公開提示価格と提供regionを取得し、最小投影と証拠hashを保持することを検討しています。取得、原資料/投影/正規化履歴の保持期間、内部分析、公開表示、正規化API再配布、派生統計再配布、商用利用、バックアップ保持について、それぞれ許可範囲をご確認ください。アカウント固有価格・個人情報・商品説明全文は公開しません。用途承認、帰属、削除対応、rate limitの条件もお知らせください。」

外部への送信は別承認です。承認待ちでも他ソースの定型処理は進みます。
