# 供給網統計（公開商品・e-Stat経由）— 2026-10-22

状態: 初版はmain（PR #31, fdea983）にマージ・本番デプロイ済み。public 0004 / private 0017 適用済み（2026-10-22 21:0x JST）。Worker Secret `ESTAT_APP_ID` 登録済み。以下は `codex/estat-real-layout` の実表対応。収集は両source `enabled=false`、`ESTAT_ENABLED="false"`、`reviewed_schema_signatures=[]` を維持し、有効化は保留。

## 実表の確認結果とローカル修正（2026-10-22）

確認結果は所有者提供のマスク済み証跡 `/workspace/estat-probe/probe4-result.json`〜`probe7-result.json` に基づく。今回の作業では再取得せず、実レスポンスをGitやCIのfixtureへコピーしない。

- 鉱工業指数00550300: 在庫 `0004052195`・在庫率 `0004052196` は、`cdCat01` で指定6品目に絞ると各105値・データ1ページ。`cat01` は「品目別_2020」の6分類（`@level` あり、`@unit` なし）、`time` は「統計項目A_2020_Match」の100分類。先頭 `0100300` は「在庫ウエイト」で、以降の名称は `201801` 等。VALUEも `@cat01`・`@time`・`$` だけで単位を持たない。旧パーサーは単位必須のため `estat_schema_invalid` で停止していた。
- IIPの単位はVALUE、指標分類、品目分類の `@unit` を優先し、すべて省略された場合だけ表題「（2020＝100.0）」または統計名等の「2020年基準」から `unit_raw="2020=100"` を補う。`base_year=2020` も保存し、基準年が不明・矛盾する表は隔離する。今回の6品目では **`0145000` 標準変圧器だけに99か月の観測値があり、他5品目はウエイト0のみ**。欠けた観測値を0として補わず、正常として扱う。ウエイト6値は観測・正規化証拠から除外する。
- 生産動態00550200: 年報の表題例は「2025年 時系列表(2290_機械器具月報（その２９）静止電気機械器具（航空機用のものを除く))」。年報の判定には「経済産業省生産動態統計 年報 年報(2021年以降) 2025年 年報」という `STATISTICS_NAME` も使う。`cat01` は「2021_2290_表側」で81分類、`time` は「2025_実数表_時間軸_表頭」で12分類、名称 `202501`・コード `2025000101` 等。指標軸も `@unit` もなく、全972値は設定上データ1ページに収まる（probe7はlimit=3の調査なのでNEXT_KEY=4）。
- 年報の品目名は `製品_<4桁品目番号>_<品目名>_<英大文字1字>_<指標名>_<単位>`。末尾から3要素を切り分け、品目名内のアンダースコアを保持する。取り込む指標の許可リストは **生産数量→production_qty、生産金額→production_value、販売数量→sales_qty、販売金額→sales_value、月末在庫数量→inventory** の5件。生産容量・販売容量・受入数量等の許可リスト外の指標は、名称形式を検証した上で明示的に除外する。形式不正は隔離し、指標enumは増やさない。`unit_raw` は名称末尾の台・百万円等を保持する。
- 年報の `item_code` は **表側の4桁表コード＋`_`＋4桁品目番号**（例 `2290_0101`）。表側の年・年次のstatsDataId・指標別の分類コードを含めないため、年が替わっても同じ品目を追跡できる。異なる表の同一番号を混同しない。品目名は指標・単位を除いた名称を保存する。
- 一覧はグループ別に短い `searchWord`（静止電気機械器具 / 半導体製造装置 / 産業用ロボット / 開閉制御装置）で検索する。半導体グループとselectionは実表題どおり「半導体製造装置及びフラットパネル・ディスプレイ製造装置」に一致させる。旧FPD略称は表題に一致せず、長い検索語は提供されたprobeでAPIエラーになった。
- 両sourceのpolicy版を `20261022-v3` に更新した。権利・承認・保持条件は変更せず、検索語・選択範囲・policyを含む `estatConfigurationHash` は変更される。旧設定の途中runは再開しない。実表の署名審査・収集の有効化は後続PRで行う。

元の `codex-task-supply-chain-stats.md` と `supply-chain-stats-design.md` をこの文書へ統合した。旧指示の別branch、config/proposalsへの配置、全権利review_required、未承認扱いのURL例外は、今回の所有者指示に置き換えた。

<a id="rights"></a>

## 1. 利用条件（確認日 2026-10-22 JST、robots.txt はAPIパスを禁止していない）

| 文書            | URL                                          | 要点                                                                                                                                                                                                                                                                              |
| --------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| e-Stat利用規約  | https://www.e-stat.go.jp/terms-of-use        | 政府標準利用規約2.0準拠・CC BY 4.0互換。複製・公衆送信・翻案・**商用利用可**。数値データ・簡単な表は著作権対象外。出典記載必須、加工時は加工の明示、国が作成したように見せない。**外部DB等とのAPI連携で取得したコンテンツは提供元条件に従う**（2-ウ）。第三者権利のある部分は除外 |
| API機能利用規約 | https://www.e-stat.go.jp/api/terms-of-use    | **利用登録とappId必須**（第2・3条、第三者へ譲渡・貸与禁止）。コンテンツ条件はe-Stat規約に準じる（第6条）。**公開サービスはクレジット表示義務**（第7条）。短時間大量アクセス禁止・負荷に応じアクセス制限あり（第5・8条）                                                           |
| クレジット表示  | https://www.e-stat.go.jp/api/api-info/credit | 「このサービスは、政府統計総合窓口(e-Stat)のAPI機能を使用していますが、サービスの内容は国によって保証されたものではありません。」                                                                                                                                                 |
| FAQ             | https://www.e-stat.go.jp/api/api-dev/faq     | API取得データは商用利用可。回数制限は「現在のところなし」。appIdは1アカウント3つまで                                                                                                                                                                                              |

- 結論: **対象の正規化値・派生値の公開・商用配信を承認済み**（取得・非公開保存・内部分析・公開表示・正規化再配布・派生再配布・商用再配布はallowed、raw再配布と外部LLM処理はdenied）。条件は出典＋加工明示＋APIクレジット。対象系列はいずれも作成機関＝経済産業省（METI自身の基幹統計）で、外部DB由来ではない。
- 注意: METIのウェブサイト（meti.go.jp）は本日、自動アクセスが403。**取得はe-Stat API（api.e-stat.go.jp）だけ**とし、METIサイトのExcelは取りに行かない。

## 2. 選定系列（6件）

| #   | 系列                                                                   | 統計                               | e-Stat ID（統計表ID＝statsDataId）                                          | 頻度・API可否              | 作成機関 |
| --- | ---------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------- | -------------------------- | -------- |
| 1   | 静止電気機械器具（変圧器・電力変換装置等, 月報その29, 品目コード2290） | 生産動態統計 年報 時系列表         | 2025年版 **0004061818**（提供probe7）。年ごとに新ID                         | 年報(月次値含む)・DB/API可 | METI     |
| 2   | 半導体製造装置及びフラットパネル・ディスプレイ製造装置（その57, 2570） | 同上                               | 2024年版 0004032959（検索要約のみ・要再確認）、旧H26版 0003128145（確認済） | 同上                       | METI     |
| 3   | 運搬機械及び産業用ロボット（その8, 2080）                              | 同上                               | 2021年版 **0004000993**（確認済）、旧H26版 0003128142                       | 同上                       | METI     |
| 4   | 開閉制御装置（その30）                                                 | 同上                               | 2025年版 **0004061819**（提供probe7）                                       | 同上                       | METI     |
| 5   | 鉱工業指数 品目別季節調整済【月次】在庫                                | 鉱工業指数（00550300, 2020年基準） | **0004052195**（確認済）                                                    | 月次・DB/API可             | METI     |
| 6   | 同 在庫率                                                              | 同上                               | **0004052196**（確認済）。生産・出荷は連番近傍と推定、未確認                | 月次・DB/API可             | METI     |

- 年報の時系列表は **年ごとに別ID**（2025年版は2026-06-30公開、上記は提供済みIDの例）。有効化後、getStatsList（statsCode=00550200, 表題「時系列表(2290_…)」）で毎年の新IDを機械的に発見する。IDは推測・ハードコードしない。
- **月次の速報・確報はe-StatではExcelファイルのみ（DB/APIなし）**。品目別の月次をAPIで取るには年報待ち（最大約18か月遅れ）。早い月次は鉱工業指数（#5,6＋生産・出荷）で補う。

## 3. 2026年の公表様式変更（METI 2025-12-26告知・総務省答申）

- 2026年1月分から速報・確報・年報の様式を統一。調査対象年ごとの12か月固定表に毎月1列追記。
- 速報は機械判読可能に。IIP品目の生産・**販売**（「出荷」から名称変更）・在庫を品目別掲載。速報の前月比・前年同月比・確報の中間計は廃止。
- 品目・アイテム改正の新旧対応表を参考資料として掲載 → 本設計の「定義の版」テーブルに取り込む根拠。
- 影響: 2026年以降の年報の表題・分類コードが変わる可能性 → コード体系差分を検知したら隔離（自動接続しない）。

## 4. データモデル（public D1 `migrations/public/0004_supply_chain_stats.sql` 案）

- `sc_series`(series_id, source_id, stats_code, table_title, item_code, item_name_ja, measure['production_qty','production_value','sales_qty','inventory','index_sa',...], unit_raw, unit_norm, base_year, definition_version_id)
- `sc_definition_versions`(definition_version_id, series_id, valid_from_year, item_name_ja, unit_raw, source_table_id, mapping_note) — 新旧対応表・品目名変更を記録。名称・単位が変わったら新versionで、自動で連結しない
- `sc_observations`（不変）: obs_id, series_id, period('2025-07' / '2025' / '2025FY'), value_decimal（文字列）, value_flag（'X'秘匿・'-'・'…'等は値NULL＋flag）, release_kind['annual','iip_monthly'], stats_data_id, source_updated_at, fetched_at, response_sha256, supersedes_obs_id
- `sc_revisions`: 値が変わった場合に before/after・検知日を記録（上書きしない）
- `series_id` は `source_id + table.group + item_code + measure` の安定した識別情報から生成する。policy版・設定hash・審査済み署名リストの更新では変えない。前回値の検索もこのIDと期間を使う。名称・単位・基準年・実際のコード集合が変わった定義は別版とし、自動で値を接続しない。
- 同一定義・同一期間の数値と欠測flagが前回の完了runと同じなら追記しない（例: `1.2300` と `1.23000` は同値で、最初の十進文字列を保持）。新しい期間・変更値だけを追記し、変更値は元の行を参照するrevisionも追記する。定義変更では、値が同じでも新定義の観測を残す。未完了runを比較の基準にしない。
- 既存の private→publication、rights-policy の公開ゲート（現在の公開許可失効・各行の取得時hash不一致で0件、保持期限切れはwithdraw）に乗せる。

## 5. 収集

- 頻度: 鉱工業指数は月1回（公表は月末ごろ、確報で改定）、年報は7月に月1回×3か月だけ確認。既存Cron `17 18 * * *`内でUTC日判定、Cron追加なし。
- 既存日次Cronで対象日のrunを開始し、既存continuationで小分けに継続する（Cron追加なし）。1回の処理はHTTP 1ページ、または保存済みページの10行のみ。getStatsListは**グループごと**最大4ページ・1ページ最大100表（年報4グループなら最大16一覧ページ）、getStatsDataは選定表ごと最大5ページ・1ページ最大10,000行（最大50,000行/表）。getStatsDataのAPI仕様上限100,000行より小さい値を採る。HTTP本文はe-Stat sourceだけ最大16,000,000 bytes、既存FX/Models/GPUの上限は変更しない。共通の `max_records=100` は従来adapter用で、e-Statの行数上限は `estat.page_size` を使う。上限内で完了しなければ公開しない。各HTTPは最大3試行、1 source/UTC日につき1 run、完了・失敗・隔離runを再取得しない。HTTP直前に永続予約し、途中停止で結果不明になったページは再取得せず `estat_request_interrupted` で停止する。
- `estat.search_words` は `table_groups` と同じ順序・同じ件数の検索語配列、または各グループ名をキーとする完全な対応表。未設定なら各グループ名を使う。生産動態の設定値は上記4つの短い検索語。各グループの一覧を1回ずつ走査し、ページ予算を毎回リセットする。検索結果が在庫/在庫率のように重なっても、その走査対象のグループだけを残し、全走査後に各グループの最新版を選ぶ。list段階の `table_index` を走査位置に使い、data段階に入ると0に戻す。DB変更は不要。
- 品目軸名は `^(品目|品目別|品目分類)(_\d{4})?$`、年報では追加で `^\d{4}_\d{4}_表側$` に限定する。表側形式は指標・単位を品目名から抽出し、明示指標軸との併存は曖昧として拒否する。それ以外で表章項目/データ項目の軸がない場合だけ `estat.implied_measures[table.group]` を使う。値は既存の指標一覧で検証し、未設定・未知グループは推測しない。明示的な指標軸がある表は従来の検証を通す。
- `time` の分類名を前後空白除去後に調べ、末尾が `ウエイト`（表記揺れ `ウェイト` も含む）の行を決定的に除外する。コードから期間を推測しない。それ以外の不明な期間は引き続き隔離する。schema署名は従来どおり**time軸全体を入力から外し**、残る軸ID・分類コードをソートして算出するため、ウエイトの追加・変更や年月の追加・並び替えで署名は変わらない。品目等のコード変更は検知する。ページ位置・上限は除外前のAPI行数で計算し、ウエイトや対象外指標だけのページでも次ページへ進む。
- `estat.item_codes` は省略可能な1〜50件の文字列配列、各コードは `^\d{1,12}$`。getStatsDataの**全ページ**にカンマ結合して `cdCat01` を送る。getStatsListには送らない。IIPの選択は `0076000,0083000,0140000,0145000,0146000,0147000`。先頭ゼロを保持し、名称中の10桁番号を分類コードと取り違えない。送信パラメータの許可リストに `cdCat01` を加えても、appIdを含むURLのマスク処理は共通のまま。
- **月初の取得失敗に同月の別日再試行はない**（N4）。開始日はUTC 1日だけ。failed/quarantinedになったrunをその日に再実行せず、翌日以降も新runを作らないため、IIPは翌月1日まで、年報は次の対象月（7〜9月）まで新規取得を待つ。9月に失敗すると次は翌年7月。pendingの継続は別日にも行うが、新しい取得runの再試行とは区別する。
- 月次の日付判定は既存のUTC logical slot（予定時刻）を使う。watchdogはe-Statの新規取得をせず、continuationだけが同じrunを継続する。既存Models処理を優先するため、完了が翌日以降になる場合がある。
- appIdは**URLのクエリに入れる仕様**（e-Statの仕様）。所有者がe-Statだけの例外を承認済み。`ESTAT_APP_ID` Worker Secret以外から読まず、リクエストURLにだけ実値を付ける。ログは固定コード、保存URLと証拠はマスク済み。応答JSONの全文字列を解析後にもマスクし、Unicodeエスケープされた反射値も除去する。生値・encodeURIComponent・encodeURIに加え、URLSearchParams形式（空白の `+` と `!'()*~` のパーセント表記）も鍵・値の両方で除去する。非200応答の本文は保存せず、例外・試行記録・ログには固定コードだけを渡す。生応答・ヘッダ・レスポンス由来URLを保存・追従しない。`ESTAT_ENABLED` は厳密な文字列 `"true"` のみ有効、Secret欠落時はthrowせず `policy_skipped / estat_app_id_missing`。EIA等への例外ではない。

## 6. 公開API

- `GET /v1/supply-chain/series`（一覧・定義・単位・版）
- `GET /v1/supply-chain/series/{id}/observations?from=&to=`
- `GET /v1/supply-chain/series/{id}/revisions`
- 成功した各レコードに source: 出典「経済産業省生産動態統計／鉱工業指数（経済産業省）、政府統計の総合窓口(e-Stat)（URL）を加工して作成」、license「e-Stat利用規約（CC BY 4.0互換）」、APIクレジット文、fetched_at、「AI向け専用統計ではない」注記。
- 全JSON応答の最上位に `api_credit` と `attribution` を付ける。空の `data: []`、404・クエリ不正・DB未適用の503だけでなく、共通入口の405・URL過長・429にも同じ文言を付ける。HEADはHTTP仕様どおり本文を持たない。

## 7. テスト

今回追加した合成テストは `tests/estat-shape.test.ts` と `tests/estat.test.ts` にある。年付き品目軸、表ごとの暗黙指標と明示指標の優先、YYYYMMと不正月、ウエイト除外と署名不変性、ウエイトだけのページ、品目コードの形式・件数、検索語の対応、グループ別のページ上限・重複検索結果、全データページのcdCat01と保存URLのappIdマスクを検証する。単位省略IIP（6分類・105値）、表側形式の年報（81分類・972値）、右からの分割、5指標の許可リスト、対象外指標の除外、不正名称の拒否、安定した品目ID、埋め込み単位を含む保存・公開までを検証する。

合成JSON fixtureのみ: 秘匿X・ハイフン、単位混在（台/t/百万円/式/基）、品目名変更で新definition version、値改定でrevision、年報IDの年替わり発見、2026様式のコード差分で隔離、appIdがログ・evidence・例外メッセージに出ないこと、公開ゲート失効で0件、policy更新後の履歴・revision継続、未変更値の重複防止、新旧hashの独立ゲート。クレジットは手動seedだけでなく実collectorがprivate/publicの系列・定義・観測・revisionに書いた原文を検証する。Cron比較は既存の汎用 `scripts/preflight-core.ts` / `tests/preflight-schedule.test.ts` によるもので、e-Stat専用のCron検査を追加したという意味ではない。

## 8. 費用と保持

既存Worker・D1・非公開R2だけを利用し、有料サービスは追加しない。提供probeの取得量ではIIP約105値/表、生産動態約972値/表で、各表1回のデータページ取得を見込む。一覧は別途必要で、各HTTPは最大3試行まで。本番Cloudflareの課金額・CPUは今回未測定。ページ上限が費用と処理量の上限にもなる。1万行の合成ページ（100品目×100か月）は、生JSON 836,315 bytes、正規化投影 1,848,271 bytes、Node 24.22.0のローカル解析92ms、同計測のheap増分約32.5MB。`tests/estat-capacity.test.ts` は1万行の正常処理と10,001行の拒否を検証する。分類コードを毎行走査せず、最初に索引Mapを作る。10行すべてがrevisionになる継続処理も、SQL文の準備数が200未満であることを合成SQLiteで確認する。これらは実payloadやCloudflare CPU・最大メモリの測定ではなく、本番安全性の保証には使わない。

データ取得は各表1ページなので、各表のHTTP取得は1収集日内に終わる想定。保存は引き続き10行/回で、IIPはウエイト除外後99観測/表、10 ticks（継続処理10回）で保存できる。生産動態は対象外指標を除いて保存するため、81分類・972値の合成例では612観測・62 ticksで保存し、単独の表なら一覧・データ取得を加えて最大72 ticks/日の枠内に収まる。ただし実表ごとの許可指標数は未計測で、972値をすべて保存する場合は98 ticksを要する。**1データページであることだけでは、全表の保存・公開が同じ日までに終わる保証にはならない**。72 ticksはModels・他source・期限処理との共有枠で、全4年報＋IIP2表が同日に重なる場合も含め、有効化後に完了時刻を確認する。取得ページ数に基づく小規模なD1/R2利用増を見込み、新プラン・新サービスは追加しない。アカウント全体が月20ドルを超える見込みになれば運用方針に従う。

R2には生JSONではなく、マスク済み・正規化済みのページ投影と応答SHA-256を90日保存する。`raw_artifacts` の既存削除経路を使う。正規化履歴は1095日という運用上限で、ライセンス上の削除期限を主張しない。公開readは期限切れを即非表示にし、既存continuationで公開行から先に小分け削除する。sourceやflagを無効化しても期限処理を続ける。D1 Time Travelのコピー消去を行DELETEで保証しない。未変更値の再取得では元の保持期限を延長しない。復元後も現在の公開許可・行ごとのpolicy/hash・保持期限を適用し、NASは変更しない。

## 9. 実装と有効化の境界

- `config/sources/estat_meti_seidou.json`: 統計00550200、年報4グループ。`estat_meti_iip.json`: 統計00550300、品目別季節調整済の在庫・在庫率。推測の生産・出荷系列は追加しない。
- `src/estat.ts`: 固定e-Stat API endpoint、getStatsListによる年ごとのID発見、有限ページング、単位と十進文字列・欠測記号保持。表IDをコードに固定しない。設計書の過去IDは調査時点の参考だけ。
- `src/estat-pipeline.ts` / `src/estat-store.ts`: 永続checkpoint・lease、マスク済み証拠、追記履歴、値変更時だけbefore/after改定。名称・単位・基準年の変更は同じ系列の別定義で自動連結しない。未知の軸・既存と異なるコード集合、および未審査の2026年以降の年報は隔離。承認済みschema署名だけを明示設定し、設定変更時はpolicy版も更新する。
- public `0004_supply_chain_stats.sql` / private `0017_supply_chain_stats.sql`: 追加のみ。実装前にローカルの全44 refsを `git ls-tree` で調べ、公開0004・非公開0017の未使用を確認。リモートfetchはしていないので、マージ前にも競合確認する。既存0001等は不変。
- 適用順序は **public `0004_supply_chain_stats.sql` → private `0017_supply_chain_stats.sql`**。公開側の適用・確認を終えてから非公開側を適用する。相互レビュー・CI・ローカル検証後の手順であり、今回は適用しない。どちらかが未適用ならe-Stat再開は `work:false` でGPU再開・保守へ進み、public不足時は固定 `estat_schema_unavailable` をログへ出す。
- 公開は既存 `source_publications` と `publication_batches` を使う。全ページ処理完了だけを公開し、読取時にもbundled sourceの現在の許可・版・設定hashと、現在の `source_publications` のactive/取消し/有効期限を検査する。publicの不変 `sc_policy_versions` に各版の設定hashを保存し、各観測は自分の版・hash・取得時刻がその版の有効期間内だったこと・取消しなし・完了batch・保持期限を個別に満たす必要がある。更新前の版の `active=0` や現在時刻での期限切れだけでは過去の有効な取得を消さない。旧版が `revoked=1` ならその版の履歴は遮断し、現在の許可がなくなれば全履歴を遮断する。改定は両入力のゲートと旧/現版両方の派生権利も確認する。設定hashの計算は同期・collector・APIとも `estatConfigurationHash` に一本化する。
- 未適用0017/0004に `expires_at,obs_id`、観測→定義、定義→系列、batchおよびrevision両入力の索引を追加し、期限走査・孤立行検査・削除参照を支える。SQLiteのEXPLAINで期限・孤立行の内側の検索が索引を使うことを検証する。private intakeのbatch検索にも索引を付ける。
- 継続処理はpublic migrationも確認し、その他の再開失敗は `estat_resume_failed`、失敗状態記録やlease解放の失敗は `estat_cleanup_failed` をログへ出す。例外本文は出さない。policy失効・拒否、appId不足、予定日対象外、source無効によって再開できないpending runは、固定コード `estat_resume_skipped` で `failed` にし、checkpointを残して `work:false` で同じ回のGPU再開・保守へ進む。次回は後続のe-Stat runを選べる。有効なleaseがあるrunは選ばない。期限削除や失敗した保守がtickを使った場合は `estat_work=true` とし、同じtickでGPU収集・期限処理・研究収集を始めない。
- **e-Statは既存watchdogのstaleness（予定からの遅れ）判定の対象外**（N3）。日次watchdogをそのまま適用すると、月次/年報を毎日missing扱いするため除外している。自動の遅延警報・復旧は今回追加しない。継続runのpending/failed/quarantined、`sc_intakes` のphase/row_index、collection_runsのエラー、継続処理ログで確認する。pendingが動かないことへの自動警報は未対応であり、collector全体の完了時刻だけでe-Statが新鮮とは判定しない。
- source設定は追加したが、フラグとsourceは無効のまま。有効化・実HTTP・Secret作成・本番操作は今回の対象外。生成スキーマ・OpenAPIも同期する。
- public migration未適用の場合、新3 endpointだけ固定JSON `public_store_unavailable` / 503を返す。既存health/sources/datasets/FX/Models/GPU等のSQLは新テーブルを参照せず、APIのbindingもPUBLIC_DBだけのまま。

## 10. 検証とレビュー

今回の実表対応はNode 24.22.0と配置済み依存パッケージで検証した。check・対象テスト・buildは起動し、成功した。`npx` は `npm_config_offline=true` としてローカル依存だけを使い、パッケージ取得は行わない。データ取得テストは合成JSON・mock transportのみを使い、実APIへ接続しない。Wranglerは更新確認とメトリクス送信を無効にしてdry-runする。

検証結果（2026-10-22）:

- `npx tsc --noEmit`、`node scripts/run.mjs check`（package.jsonのcheck相当のPrettier・型・境界チェック）成功。
- `tests/estat.test.ts`・`estat-shape.test.ts`・`estat-capacity.test.ts`・`supply-chain-api.test.ts` は4ファイル85件成功。Socket不要のSQLiteで既存データ相当のmigrationと実際のSQLも検証。`node --test scripts/resilience.test.mjs` も1件成功。
- `node scripts/run.mjs build`（両WorkerのWrangler dry-run）成功。`WRANGLER_HIDE_BANNER=true` と `WRANGLER_SEND_METRICS=false` を指定し、更新確認とメトリクスを止めた。ログ先は既存runスクリプトのwork配下。
- `node scripts/generate.mjs` と生成物3点の `git diff --exit-code` が成功。`config/source.schema.json` は現在のZod定義と一致し、スキーマ・OpenAPIに変更はない。
- offline preflightはstatic_valid/ready=true、network_performed=false。`git diff --check` 成功。両sourceのenabled=false・署名リスト空・CollectorのESTAT_ENABLED=falseを合成テストで確認。
- 全件Vitest（`npx vitest run`、Node 24.22.0、box上）は539件成功。CIでも検証する。

実表の署名承認・本番性能・認証成功を、ローカル合成テストの成功だけで実証したとは扱わない。

定義の適用開始年はソース版の年から推測せず、`valid_from_year=null` として表の年（source_table_year）を別記する。

相互レビューはAGENTS.mdに従いClaude Code（claude-sonnet-5-5）が担当し、意見が割れたらclaude-opus-5-5が判断する。結果はPRに記録する。
