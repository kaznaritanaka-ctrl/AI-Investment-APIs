# AI経済データのPrivate研究用拡張 — 2026-10-15

[Issue #15](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/issues/15) の調査・ローカル実装。新規の実データ取得、権利grant、本番migration/deploy、Cron、Admin、Public API、NASの変更を含まない。価格・会社実績をfixtureへ転記していない。

10/17指示を10/18反映: [review_dueと削除義務の分離、明示的until_revoked、次の2候補](research-long-retention-20261016.md)を優先する。下記の10/16容量/費用評価は参考値で、ソース獲得・安全な実装の停止条件にしない。新archive/DB分割/新DBや費用追加調査は行わない。Highreso/GPUSOROBANとRebroはownerによる公式feed/権利確認待ち、新source実観測0。EIA/JEPXはcritical path外のまま。

## 作業開始時点と本番との差

- main: `1d42d981cb93c5185ecba8cf53b108c496d91cf7`。独立checkoutの `codex/source-expansion-private-research-20261015` を使用。他のNAS作業の未コミット変更には触れない。
- 参照した作業: `codex/gpu-sources-readiness-20261009`、`codex/operations-followup-20261008`、`codex/nas-production-readiness-20261011`。既存GPU辞書・DOK接続仕様・DC scope・9権限gate・bounded HTTPを再利用。
- Cloudflare MCPでWorker metadata/settings/deployments/schedulesをread-only確認。Secretはbinding名だけで値を取得していない。DB本文・R2本文は調べていない。

| 対象 | 2026-10-15のread-only確認 | mainとの関係 |
|---|---|---|
| Collector | version `cbf5a90d-9ab9-40b0-8847-eb0149f20e58`、100%、10/9配信。annotationにcommit `0abf2b647f1e1da23e91473f8c4f26d83e739802` | mainとは別commit。このbranchをそのままdeployしない |
| API | version `83c3fe32-a524-4eae-9333-bc4818d7bb39`、100%、10/7配信。annotationに `8c58c9201bb501424d15e635ed1be83316b4ef7e` | 本タスクは変更しない |
| Collector設定 | COLLECTION_ENABLED=true、AGENT_ENABLED=false、workers.dev/preview=false、既存2 D1 + private R2 | 新規bindingなし。CPU設定5000msは観測CPU実績ではない |
| Cron | `17 18 * * *` / `47 18 * * *` / `*/5 18-23 * * *` | そのまま維持 |
| PoC | ownerのIssueにPrivate本番収集中と記載。配信annotationのcommitではenabled、H100-SXM、private 3権限allowed | mainのdisabledと差異あり。本調査では実観測行の最新鮮度は未検証 |
| ECB / Models.dev | 既存のenabled設定、Models 5 provider / 17 fieldを維持 | 本PRでprovider/field/rightsを変更しない |

新規0007は既存private D1内の追加テーブル案。10/16に0008で長期保持契約を追加。0004は別GPU/energy作業用に予約済み、0001〜0006を変更しない。今回Cloudflareのschema適用状況そのものを再監査したわけではない。

## 優先判断

1. **国内中古の成立事例・許諾された取引系列**: 希少性が高い。最初は単一業者の観測範囲を明記し、取得・保存条件を確定する。
2. **国内GPUの条件付きレンタル履歴**: 変化して消える見積・掲載・地域条件を残す価値。Highresoの正規feedとDOKのアカウント固有性を確認する。
3. **DC案件・系統制約の発表/取消/訂正履歴**: METIの採択とOCCTOの供給計画を別系列として調査。現在の最新版だけでは失われる版に価値がある。
4. **メモリ供給・水・装置の一次開示改定**: MicronのHBM供給/設備/水の計画と実績を別scopeで記録する設計。価格以外の履歴も優先する。
5. **後から原系列を取得できる電力・有料市況**: EIA/JEPXは実装済み合成経路を維持するが、認証/wire待ちを全体のcritical pathにしない。DRAMeXchange等も許諾・費用を先に判断する。
6. **海外GPU・AI料金の重複収集**: 既存PoC/Modelsを維持。GetDeployingは外部参照を優先。CCIR/OpenRouterは未解決のまま。

以下の台帳A/Bは同じIDで対応する。初回確認2026-10-15 JST、10/16にDOK/Highreso/Rebro/OCCTO/Micron/安川の公式資料を再確認して優先順位と保持案を更新した。nullはURL不明、unknownは適用条件・数値の未確認であり、許可でも拒否でもない。取得周期/保持期間は**設計案**で、現在の実行予定ではない。

## 台帳A — 取得方法と利用根拠

| ID / 候補 / 一次・二次 | 公式URL・API/ファイル | 自動アクセス・保存の根拠と未解決事項 | terms URL / license URL | public / 商用再配布、コスト・API上限 |
|---|---|---|---|---|
| G1 Highreso / GPUSOROBAN・一次 | [instances](https://soroban.highreso.jp/compute/instances)、[shared cluster](https://soroban.highreso.jp/multinode-cluster)、[利用説明](https://soroban.highreso.jp/article/c177)。公開ページ。価格履歴API/CSVはunknown | [terms](https://soroban.highreso.jp/terms)はサービス契約。公開価格の自動時系列DB化への適用は未確定。ownerが別途問い合わせ予定、送信済みとはしない | terms: 前掲 / license: null | 両方unknown。公開閲覧無料、feed・契約費・rateはunknown |
| G2 さくら高火力DOK・一次 | [API仕様](https://manual.sakura.ad.jp/koukaryoku-dok-api/spec.html)。GET /is1a/unit_prices/、year/month/day/page/page_size、Basic AccessToken:Secret | 正規APIの入手経路は確認。アカウント固有unit priceの保存・派生・再配布は要審査。仕様書のCC BY-NDをレスポンスデータの許諾に転用しない | [約款入口](https://www.sakura.ad.jp/corporate/agreement/) / license: null（データ） | public/商用unknown。認証必要、キーの存在と許諾は別。API利用費/rate unknown |
| G3 GPU買取センター / Rebro・一次 | [公開買取事例](https://gpu-kaitori.com/reason/)、[Q&A](https://gpu-kaitori.com/q-a/)。A100/H100等の選別された報告事例。非公開feed/API unknown | 公開された買取報告と、全成立取引系列は異なる。自動収集・蓄積・匿名化・二次利用の許可は未確認。非公開データへアクセスしない | terms: null（データ利用） / license: null | 両方unknown。公開閲覧無料、データ提供費/rate unknown |
| E1 EIA retail electricity・一次 | [API文書](https://www.eia.gov/opendata/documentation.php)、[入口](https://www.eia.gov/opendata/)。/v2/electricity/retail-sales/data/、monthly、CO/IND、priceに限定 | [API利用規約](https://www.eia.gov/opendata/terms-of-service.php)に検索・取得・分析等、[再利用方針](https://www.eia.gov/about/copyrights_reuse.php)にデータ再利用・出典表示。ロゴ/第三者資料を除外。自動取得用途への根拠を確認しowner review待ち | terms: 前掲 / license: null（命名されたライセンスではなく公有・公式利用条件） | 方針上の利用根拠あり、プロジェクトのpublic/商用grantは未承認。無料キー必要。JSON最大5,000行、[FAQ](https://www.eia.gov/opendata/faqs.php)の目安より十分低く制限 |
| E2 JEPX spot・一次 | [公式spot](https://www.jepx.jp/en/electricpower/market-data/spot/)、[公式JS](https://www.jepx.jp/js/spot_summary.js)。年度CSVを読むGET /js/csv_read.php?dir=spot_summary&file=spot_summary_YYYY.csv。ダウンロードformは/_download.php | [免責・著作権](https://www.jepx.jp/disclaimer/)に出典表示での利用条件。機械取得・履歴DB・商用派生への具体的適用はowner review待ち。禁止回避は行わない | terms: 前掲 / license: null | 表示利用条件は確認、public/商用grantは未承認。公開閲覧無料、rate/SLA unknown。1日1要求案 |
| E3 OCCTO・一次 | [供給計画等](https://www.occto.or.jp/various/kyoukei/)、[需給確認](https://www.occto.or.jp/institution/shiji/250613_jukyukakunin.html)。公表資料/添付ファイル | [利用条件](https://www.occto.or.jp/chosakuken.html)は出典明記・加工表示・第三者権利への注意。別host web-kohyo.occto.or.jpに自動適用しない。機械可読seriesの固定契約は未選定 | terms: 前掲 / license: null | 自社コンテンツの利用根拠はあるが対象ファイル確定/権利承認待ち。閲覧無料、rate unknown |
| M1 DRAM/NAND・二次調査 | [DRAMeXchange FAQ](https://dramexchange.com/Service/faqs)、[APIサービス規約](https://api.dramexchange.com/service/terms_of_use.aspx)。spot/contractの提供は実在 | 契約サービス・データ権利を個別審査。公開画面から有料情報の取得制限を回避しない | terms: 前掲 / license: null | 再配布/商用unknown、契約/追加許諾が必要な候補。費用・API quota未確認 |
| M2 HBM・二次調査 | [TrendForce発表](https://www.trendforce.com/presscenter/news/20260602-13074.html)。契約交渉/見通しの調査情報 | HBMの年契約・見通しをspot実売に変換しない。継続した公開spot/APIは確認できず | terms: M1の別サービス適用を断定しないためnull / license: null | unknown。記事閲覧とレポート契約を区別、費用/rate unknown |
| M3 半導体供給/水・一次 | [Micron IR](https://investors.micron.com/overview/default.aspx)、[環境報告](https://www.micron.com/about/sustainability)、[資料一覧](https://www.micron.com/about/sustainability/sustainability-resources) | 会社の設備/供給見通しと実績、会計期と暦年を分ける。報告書にはwithdrawal/consumption/dischargeがあり、会社合計を特定DCへ配賦しない。時系列DB化の許諾unknown | terms: null（データ用途未確認） / license: null | 両方unknown、閲覧無料、feed/rate unknown |
| M4 ドスパラ等メモリ小売・一次 | [公式パーツ販売](https://www.dospara.co.jp/parts)。DDR5のSKU/容量/kit付き小売掲載を確認。正規価格feed/APIはunknown | [サイト利用条件](https://www.dospara.co.jp/5info/cts_immunity.html)の個人/非商業利用とダウンロード・改変制限を個別確認する必要がある。小売SKUをDRAM spot/HBM指数にしない | terms: 前掲 / license: null | 商用の継続DB化・再配布は未承認。閲覧無料、feed費/rate unknown。collectorなし |
| D1 METI DC地方拠点整備採択・一次 | [2023採択ページ](https://www.meti.go.jp/information/publicoffer/saitaku/2023/s231107001.html)、[公式採択PDF](https://www.meti.go.jp/information/publicoffer/saitaku/2023/downloadfiles/s231107001_1.pdf) | 公式検索結果で系列/公表日確認、ページ直接取得は403。回避せず、本文の機械抽出/利用条件は未確認。採択≠交付≠建設完了≠IT稼働 | terms: null（今回確認未完了） / license: null | unknown。今回は履歴契約・合成例・テストまで。閲覧価格なし、API/rate unknown |
| D2 国内DC企業発表・一次 | [さくらDC](https://www.sakura.ad.jp/corporate/work/datacenter/)、[石狩施設](https://datacenter.sakura.ad.jp/location/ishikari/)、[DCC参画発表](https://www.sakura.ad.jp/corporate/information/newsreleases/2026/07/28/1968225444/) | 提携参加と個別施設納入を分離。施設単位電力/水量が非開示ならnull。自動履歴保存条件unknown | terms: null（当該データ） / license: null | 両方unknown、閲覧無料、feed/rate unknown |
| L1 Tecanラボ自動化・一次 | [公式news archive](https://www.tecan.com/news-archive)。装置発売、協業、サービス拠点の一次開示 | [利用条件](https://www.tecan.com/terms-of-use-privacy-and-cookies-policy)は個人用抜粋とcommercial/public利用を分離し、検索システムへの格納等に事前書面許可を要求。協業≠納入、発売≠稼働件数 | terms: 前掲 / license: null | 書面承認なしのpublic/商用利用・継続DB格納を進めない。発表閲覧無料、価格見積り/rate unknown |
| L2 安川電機Physical AI・一次 | [公式news](https://www.yaskawa.co.jp/category/newsrelease)。MOTOMAN等の製品/技術発表 | 発売/受注/納入/設置/運用を別イベント化。デモの公開を稼働台数に読み替えない。[サイト利用規定](https://www.yaskawa.co.jp/term)の著作権/無断複製等の制限を確認。履歴DB用途の許諾は未確認 | terms: 前掲 / license: null | 両方unknown。公開閲覧無料、価格/数量/機械feed/rate unknown |
| L3 Unitree・一次 | [開発者資料](https://support.unitree.com/home/en/developer/)、[store terms](https://shop.unitree.com/policies/terms-of-service) | 店舗規約にscrape/crawl制限。購入価格の表示やデモは商用稼働数ではない。別許可なしにcollectorを作らない | terms: 前掲 / license: null | 自動取得候補は停止。public/商用unknown、製品購入不要、rate unknown |
| A1 Models.dev・二次集約 | [公式](https://models.dev/)、[公開API](https://models.dev/api.json?type=all) | 既存のMIT根拠・scope・owner承認を維持。新providerやfieldへ拡大しない | [既存台帳](source-register.md)の固定根拠 / MIT | 既存grantのみ。既存費用/容量設計、今回追加0 |
| A2 OpenRouter・二次集約 | [モデルAPI仕様](https://openrouter.ai/docs/guides/overview/models) | API実在は再配布許可ではない。既存review_required維持 | 既存台帳の条件。今回新しい許諾は未確認 / null | public/商用未解決。追加収集なし |
| O1 Price of Compute・二次集約 | [API](https://www.priceofcompute.com/api) | 本番の承認済みPrivate profileだけ維持。出典・cache間隔・scopeは承認版を参照 | [既存PoC設計](price-of-compute-integration.md) / 当該承認版 | 公開権限に昇格しない。API案内は日次1,000要求上限/cache最低1h。本タスク追加0 |
| O2 GetDeploying・二次集約 | [公開dataset](https://getdeploying.com/dataset/gpu-prices)。weekly CSV/JSON、GPU別file | CC BY 4.0は当該公開ファイル。サイト全体/APIへ広げない。外部参照で十分なので新collectorなし | dataset条件 / [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 条件付き商用再利用の根拠あり、プロジェクトgrantは追加しない。公開ファイル無料、個別API課金/quotaは別 |
| O3 CCIR・二次調査/推計 | [Data Terms](https://ccir.io/documents/data-terms)、[methodology](https://ccir.io/documents/methodology) | 10/13付termsで引用とsystematic/bulk/historical/commercial derivativeを分け、後者は書面許諾対象。海外先行事例として参照 | terms: 前掲 / license: null | 継続蓄積/再配布は別許諾待ち。公開current/30日窓、契約料金unknown。collectorなし |

## 台帳B — 比較条件・履歴価値・運用案

保持欄の「target」は研究上の目標で許諾ではない。短期evidence 7日、別archiveなし、backup上限30日を共通の交渉案とし、normalized期間はsource別に確定する。EIA/JEPX proposalの承認期間はnull。機械的な自動削除と復元時の現行権利再適用が必要。[長期保持設計](research-long-retention-20261016.md)を参照。

| ID | 周期 / 想定保持 | 過去再取得・時刻 | 比較可能性 / 欠測 | 独自性と意思決定 / 優先度 / 実装状態 |
|---|---|---|---|---|
| G1 | 正規feed許可後1日1回、件数上限合意後。target1095日 | 過去price unknown。observedと価格適用開始は別 | A100/B200等、hour/month/minute/points、専有/共有、割込み、minimum term、tax、per-offer地域。会社所在地から補完しない | 国内の消える条件履歴は高価値。優先高。受入契約・合成テスト、feed待ち |
| G2 | 既存page50・1page/invocation案維持、保持は既存policy候補と別審査 | 日付指定price APIあり、保存期間/遡及限界unknown。begin/endと観測日を分離 | is1a=石狩という公式zone根拠。秒単価とhour換算を分離、overridden/account priceを公共相場扱いしない | 国内の実契約条件の把握。優先高。既存adapter再利用、許諾待ち |
| G3 | 許諾された自動feedの日次差分案、上限50事例/日から相談。target1825日 | 選別公開事例は全期間を復元できる保証なし。年月だけならmonth精度、取引日時null | 買取提示/買取成立報告/販売提示/販売成立報告、状態・lot・数量・税別。not_seen≠sold | 最優先。成立系列の取得合意が価値。受入契約のみ、非公開feed/許諾待ち |
| E1 | 日次に直近3か月の改定を確認する案、最大12か月・2page×6件、target1095日 | 過去系列はAPIで取得可能、当時公表版を復元できる保証なし。period=YYYY-MM、publication timestampはunknown | CO/IND平均小売、原単位cents/kWh。DC料金・卸spotとの比率を生成しない。nullと0を保持 | 基準系列と改定時点に価値。ただし後回し。parser/private保存合成済み、認証方針不一致で通信停止 |
| E2 | 1日1年度file/1地域/1delivery日、48枠、target1095日 | 年度CSVから過去値、改定前版は保証なし。observed≠受渡日≠公表日時 | Tokyo 30分/JST/JPY-kWh。48枠の取得completeと価格欠測は別。失敗を在庫0/価格0にしない | 国内電力の改定/取得時点。ただし後回し。parser/固定request/private保存合成済み、wire/権利確認待ち |
| E3 | 月次公表確認、対象資料1件/回案。保持未決定 | 供給計画/需給予測の過去資料、差替前版unknown | 需要予測/実績、予備率/供給力、kW/kWhの別。卸価格ではない | 系統制約の補助。優先中。候補調査のみ |
| M1 | 契約許可後spot日次、contract月次等。保持unknown | ベンダーhistory契約による | mainstream spotは取引を基礎、非mainstreamはbid/askの場合。DRAM/NANDの規格/容量/grade別 | 希少性高だが許諾・費用優先審査。collectorなし |
| M2 | 発表時、保持unknown | 既存記事/レポート、訂正前unknown | 年契約、将来見通し、実績を分ける。HBM spot/GPU先物は未確認 | 供給逼迫の仮説検証に限定。調査のみ |
| M3 | 四半期/年次、保持unknown | IR/環境報告archiveは存在、訂正前unknown | 会社単位・暦年/会計期・取水/消費/排水/再利用、千m3等の原単位。water restorationをwithdrawalから勝手に引かない | 設備・水制約の補助。中。調査のみ |
| M4 | 正規feed未確認、周期/保持unknown | 現行小売掲載は確認、改定前版unknown | SKU/容量/kit/税/送料/保証/地域/在庫 | ユーザー調達費の参考、HBM指標にはしない。低、許諾/feed待ち |
| D1 | 発表時・週1差分確認案。target1825日 | 公式archiveあり、取消/修正前版保証なし。公表日と事業対象年度を別にする | project/site/phase。採択はplannedの根拠にも範囲照合が必要、contracted/energized/IT operationalへの転記禁止 | 発表変更の独自履歴。優先高。DC+水schema/合成revisionテストのみ、403/権利確認待ち |
| D2 | 発表時、保持unknown | news archiveあり、過去設備ページunknown | 会社提携とDC納入、施設受電容量とIT稼働容量を分離 | 国内scope対応に価値。中。候補調査のみ |
| L1/L2 | 発表時・週1候補、保持unknown | news archiveあり、訂正前/全SKU履歴unknown | launch/order/delivery/install/operation各時点、装置SKU/能力/単位/価格条件 | 将来消える導入事例。中。契約候補、crawlerなし |
| L3 | 収集停止、周期/保持未設定 | 製品ページ差替履歴unknown | デモ≠受注≠商用稼働。動画再配布は別権利 | 取得規約の制限が優先、参照のみ |
| A1/A2 | A1既存日次/既存保持、A2停止 | catalogの当時版は既存自前履歴 | 原token単位、provider/model/region/price条件、掲載消失と終了を分離 | 既存維持、重複投資しない |
| O1 | 承認済み本番設定のまま、今回追加0 | 本番履歴/観測鮮度は本タスクで独立再検証せず | aggregate quoteで成約価格ではない | 既存Private基準。設定不変 |
| O2 | 外部参照、新規取得/保持0 | 53週窓の週次file、最新週はpartialで変わり得る | offered GPU/課金/週、min/max/median/provider median/count。waitlist/unknown含み、確実な空きGPUではない。USD正規化は原価格と別 | 重複度高。新collector不要 |
| O3 | 外部参照、新規取得/保持0 | current/30日窓、体系的historyは許諾必要 | reported transaction/ask/model estimateのbasisを分離 | 海外先行事例の参考、collector不要 |

## 10/16再評価 — 当時版の希少性と費用対効果

「現在しか取れない」は断定せず、**過去の当時版を取り直せる保証の有無**を区別する。優先順位・価値・許諾見込みは台帳Aの公式資料に基づく設計判断であり、提供者の同意や実取引の存在を確認した意味ではない。新規候補のgrantはすべてreview_requiredのまま。

年間保存費は比較用の保管料係数。50行/日+1run/日、2KiB/行・runなら年間38.12MB増、1年末在庫をさらに1年保存するD1係数は$0.34/年。12行なら9.72MB/$0.09、48行なら36.63MB/$0.33、1開示/日なら1.50MB/$0.014。無料枠、証拠、SQL/CPU、feed料金を含めず、実請求額/実件数とはしない。3年/5年の累計とR2代替は[別計算](research-long-retention-20261016.md)を参照。本文・indexが大きければ比例して増える。

| source | 現在・過去の入手可能性 | 許諾の見込み / 実装可能性 | 年間保存費の仮定 / 提供費 | 今すぐの判断価値 | 3〜5年後の希少性 / 順位 |
|---|---|---|---|---|---|
| Rebro (G3) | 選別公開事例あり。全成立系列/当時版の遡及はunknown | 書面提供の可否から確認。正規feed unknown、受入型のみ | 50行:38.12MB/$0.34、feed費unknown | 国内中古の提示と成立を分ける基礎 | **1位**。成約系列が許諾されれば高い。公開例だけで市場代表性を主張しない |
| Highreso (G1) | 現在の条件ページあり。旧価格/旧契約条件feed unknown | サービス規約だけでは不足。正規feed/用途合意待ち | 50行:38.12MB/$0.34、feed費unknown | 日本の提供地域・契約条件付き供給価格 | **2位**。更新で消えるoffer条件に高い価値 |
| METI DC採択 (D1) | 公表archiveは検索で存在確認。当時版/取消前の保証なし、本文403 | 公式利用条件/本文確認待ち、回避不可。revision型は実装 | 最大1開示/日:1.50MB/$0.014、取得費unknown | 案件/phaseの発表と進捗の突合 | **3位**。計画変更の追跡は後から復元しにくい |
| OCCTO (E3) | 年度供給計画archiveあり。差替前の版はunknown | 自社資料に出典・加工表示等の再利用根拠。固定ファイル/第三者権利のreview待ち | 最大1開示/日:1.50MB/$0.014、公式閲覧無料・feed費unknown | 需給見通しと系統制約の補助 | **4位**。当時の予測・改定履歴に価値。別hostは別審査 |
| Micron HBM/設備/水 (M3) | IR/環境archiveあり。訂正前版unknown | 履歴DB用途の許諾unknown。scopeモデルを利用できるが抽出未実装 | 最大1開示/日:1.50MB/$0.014、feed費unknown | 供給計画・実績と水の制約を別scopeで比較 | **5位**。当時の見通しと後年実績の差を残す |
| さくらDOK (G2) | 日付指定unit_prices APIあり、遡及範囲/旧account価格unknown | 公式wire既知・既存adapterあり。データ保存許諾は別で未確認 | 50行:38.12MB/$0.34、API費unknown | 国内の契約別価格条件を確認できる候補 | 次点。再取得可能性がG1より高く、追加実装を急がない |
| EIA (E1) | 過去月系列をAPIで取得可能、当初発表版は保証なし | 公式利用根拠あり、URLキー禁止と競合。transportはblocked | 最大12行:9.72MB/$0.09、公式API無料 | 米国電力の基準系列 | 後回し。原系列を後から取得しやすい。live smokeなし |
| JEPX (E2) | 年度CSVあり、訂正前版は保証なし | 利用条件の適用とwire/encoding未確認。blocked | 48行:36.63MB/$0.33、閲覧無料・SLA unknown | 国内卸spotの参照 | 後回し。年度値は後から取得しやすい。live smokeなし |
| DRAMeXchange (M1) | 有料historyの契約条件次第 | 契約型。取得/保存/派生/再配布の見積り前に実装しない | scope未定、例50行なら38.12MB/$0.34、提供費unknown | 規格別spot/contractを正しく得られれば高い | 高いが買い直せる可能性あり、費用対効果待ち |
| TrendForce HBM (M2) | 過去発表/レポートあり、当時版unknown | 自動時系列DB化・レポート権利未確認、crawlerなし | 最大1開示/日:1.50MB/$0.014、提供費unknown | 契約見通しの補助、HBM spotにはしない | 中。一次供給者の開示を先に確認 |
| 国内DC企業発表 (D2) | news archiveあり、施設ページ当時版unknown | 会社/資料ごとに用途審査。大量crawlerなし | 最大1開示/日:1.50MB/$0.014、feed費unknown | site/phaseの計画訂正 | 高いがscope広い。METI型の受入を先に絞る |
| ドスパラ小売メモリ (M4) | 現行掲載あり、価格履歴feed unknown | 個人/非商業条件等を確認。正規feed/許諾待ち | 例50行:38.12MB/$0.34、feed費unknown | 調達費には有用、HBM価格の代用不可 | 中。SKU入替・条件差が多く今回は低優先 |
| Tecan (L1) | news archiveあり、訂正前版unknown | 格納/商用利用の書面許可が必要な条件。未実装 | 最大1開示/日:1.50MB/$0.014、提供費unknown | 装置発売と導入の分離 | 中〜高。権利交渉/納入根拠待ち |
| 安川 (L2) | news archiveあり、旧仕様ページunknown | サイト規定の権利制限あり、データ用途review_required | 最大1開示/日:1.50MB/$0.014、提供費unknown | Physical AI導入・能力の一次根拠 | 中〜高。製品発表を稼働台数にしない |
| Unitree (L3) | 現行製品/資料あり、履歴unknown | storeのscrape/crawl制限で停止、別許可なしに実装不可 | 収集0、将来scope/料金unknown | 技術/製品の参照 | 検討保留。希少性を理由に規約を回避しない |
| Models.dev (A1) | 既存catalog当時版を保存 | 既存承認scopeのみ維持 | 今回の増分0、既存費用は別 | 既存の料金/掲載変更 | 既存維持。重複収集しない |
| OpenRouter (A2) | 現行APIあり、過去price保証未確認 | 未解決の権利、既存disabled維持 | 今回0、将来費用unknown | Modelsと重複、追加条件は要比較 | 低。権利待ちで他作業を止めない |
| PoC (O1) | 既存Private履歴、鮮度は今回未監査 | 既存の承認profileのみ維持 | 今回の増分0 | 既存海外GPU比較基準 | 既存維持、同内容のcollector不要 |
| GetDeploying (O2) | 53週窓の週次file、長期窓外unknown | 当該fileのCC BY 4.0根拠、project grant未追加 | 外部参照、追加収集0 | 海外GPUの比較参考 | 低。既存集約と重複、独自収集は後回し |
| CCIR (O3) | current/短期窓、長期historyは許諾依存 | data terms要審査、参考資料のみ | 今回0、提供費unknown | 成立/提示/推計の方法比較 | 低。国内一次履歴を先にする |

次の本番有効化候補は**G3 RebroとG1 Highresoの2件のみ**。上位5件を同時に有効化する提案ではない。ownerが交渉に使う[2件のチェックリスト・KPI・統合計画](research-long-retention-20261016.md)を別紙にした。どちらも正規feedを入手できなければ接続不可のまま、実装済みの受入型を維持する。

## EIA/JEPXは合成実装を維持し、後回しにする

EIAとJEPXはいずれも一次提供者の公式機械取得経路と利用条件の所在を確認した候補であり、実運転許可済みの2ソースではない。10/16追加指示で両者をcritical pathから外し、live smokeせずblockedを維持する。JEPXに禁止が確認された場合は自動取得を進めず、OCCTO自社コンテンツの固定機械可読系列を別審査する。現時点で未知のOCCTO endpointを作って置換したことにはしない。

**EIAの必須判断**: 公式API文書はキーをURLで渡す必要がありheaderでは認識しないと説明する。IssueはURLへのキーを禁止しているため、`researchRequest` は `credential_url_disallowed` を返し、Secret引数も受け取らない。envキーをURLへ連結する実装や架空のX-API-Key方式はない。公式keyless小規模fileの確認、または所有者による制約の別途見直しが必要。今回bulk fileを代替取得しない。応答のrequest/paramsがキーをechoし得るため、将来接続してもtyped data以外を保存しない。

**JEPXの必須判断**: 公式HTML/JSの取得方法・Tokyo列位置・4月開始年度は確認。市場CSV自体は取得していない。UTF-8 CSV readerと見出しはsynthetic契約で、実ファイルのencoding/header/content-typeをowner許可の小規模smokeで検証する必要がある。`wire_contract_review_ref=null` のままでは取得不可。旧 `/market/excel/spot_YYYY.csv` を未確認で使わない。

利用条件の文面変更を自動許可に読み替えない。`terms.version` は本プロジェクト内のレビュー識別子であり、提供者の公式版番号ではない。新文面・適用範囲が判明したらcurrent termsと不一致にして停止、owner review後に新policy版で再登録する。

## 実装範囲

- `src/research/schema.ts`: 既存SourceSchema/9権限gateを利用した候補設定、scope上限、owner/wire/retention/terms review、license nullの独立判定。
- `electricity.ts`: EIA月次値/JEPX Tokyo 30分値の決定的projection。decimal文字列、月精度、原単位、負値/0/null、48枠coverage。EIA metadata envelopeや他地域を保持しない。
- `pipeline.ts`: 同じprivate D1/R2のローカル経路。1page/呼出し、5分lease、6時間取得窓、固定run ID、R2条件付きcapture、20 SQL文以下のbatch、checkpoint/replay、complete読取、再観測/訂正系譜、有限retention。
- `domestic-gpu.ts`: Highreso/DOK/Rebroの受入契約、既存GPUIdentity再利用。pointsとJPY、minuteとhour、B300単体とGB300ラックを分離。非公開feedや実価格は含めない。
- `disclosures.ts`: 既存DCPortfolioSchemaを再利用したDC採択系列のhash付きrevision、scope別水指標。自動PDF/企業crawler・実データ保存は未実装。
- private `0007_private_research.sql`: research_sources/runs/pages/observationsだけ。既存observations CHECKやpublic datasetは拡張しない。新しいPrivate研究データを誤って公開経路へ渡さない。
- private `0008_research_retention.sql` / `retention.ts`: source別3〜5年を扱う承認済み保持snapshot、版をまたぐ現行権利検査、旧期限の不変性、外部取消し/削除記録によるD1復元後の再削除。1095/1825日の合成境界試験。R2長期archiveは比較設計のみ。

詳細な保存/復元/費用/有効化のownerチェックリストは [private research運用案](private-research-runbook.md)。検証結果は [validation](source-expansion-validation-20261015.md)。
