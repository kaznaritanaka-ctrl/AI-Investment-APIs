# 供給網統計（公開商品・e-Stat経由）— 2026-10-22

状態: `codex/estat` のローカル実装。所有者承認 `Kaz owner approval 2026-10-22T09:43Z estat`（2026-10-22 18:43 JST）を反映。e-Stat 2統計を公開用sourceとして登録し、収集は両方 `enabled=false`、Workerの `ESTAT_ENABLED="false"`。今回の実HTTP・Secret作成・commit・push・deploy・remote migrationは0件。

元の `codex-task-supply-chain-stats.md` と `supply-chain-stats-design.md` をこの文書へ統合した。旧指示の別branch、config/proposalsへの配置、全権利review_required、未承認扱いのURL例外は、今回の所有者指示に置き換えた。

<a id="rights"></a>

## 1. 利用条件（確認日 2026-10-22 JST、robots.txt はAPIパスを禁止していない）
| 文書 | URL | 要点 |
|---|---|---|
| e-Stat利用規約 | https://www.e-stat.go.jp/terms-of-use | 政府標準利用規約2.0準拠・CC BY 4.0互換。複製・公衆送信・翻案・**商用利用可**。数値データ・簡単な表は著作権対象外。出典記載必須、加工時は加工の明示、国が作成したように見せない。**外部DB等とのAPI連携で取得したコンテンツは提供元条件に従う**（2-ウ）。第三者権利のある部分は除外 |
| API機能利用規約 | https://www.e-stat.go.jp/api/terms-of-use | **利用登録とappId必須**（第2・3条、第三者へ譲渡・貸与禁止）。コンテンツ条件はe-Stat規約に準じる（第6条）。**公開サービスはクレジット表示義務**（第7条）。短時間大量アクセス禁止・負荷に応じアクセス制限あり（第5・8条） |
| クレジット表示 | https://www.e-stat.go.jp/api/api-info/credit | 「このサービスは、政府統計総合窓口(e-Stat)のAPI機能を使用していますが、サービスの内容は国によって保証されたものではありません。」 |
| FAQ | https://www.e-stat.go.jp/api/api-dev/faq | API取得データは商用利用可。回数制限は「現在のところなし」。appIdは1アカウント3つまで |
- 結論: **対象の正規化値・派生値の公開・商用配信を承認済み**（取得・非公開保存・内部分析・公開表示・正規化再配布・派生再配布・商用再配布はallowed、raw再配布と外部LLM処理はdenied）。条件は出典＋加工明示＋APIクレジット。対象系列はいずれも作成機関＝経済産業省（METI自身の基幹統計）で、外部DB由来ではない。
- 注意: METIのウェブサイト（meti.go.jp）は本日、自動アクセスが403。**取得はe-Stat API（api.e-stat.go.jp）だけ**とし、METIサイトのExcelは取りに行かない。

## 2. 選定系列（6件）
| # | 系列 | 統計 | e-Stat ID（統計表ID＝statsDataId） | 頻度・API可否 | 作成機関 |
|---|---|---|---|---|---|
| 1 | 静止電気機械器具（変圧器・電力変換装置等, 月報その29, 品目コード2290） | 生産動態統計 年報 時系列表 | 2023年版 **0004019778**（確認済）。年ごとに新ID | 年報(月次値含む)・DB/API可 | METI |
| 2 | 半導体製造装置及びFPD製造装置（その57, 2570） | 同上 | 2024年版 0004032959（検索要約のみ・要再確認）、旧H26版 0003128145（確認済） | 同上 | METI |
| 3 | 運搬機械及び産業用ロボット（その8, 2080） | 同上 | 2021年版 **0004000993**（確認済）、旧H26版 0003128142 | 同上 | METI |
| 4 | 開閉制御装置（その30） | 同上 | 未特定 | 同上 | METI |
| 5 | 鉱工業指数 品目別季節調整済【月次】在庫 | 鉱工業指数（00550300, 2020年基準） | **0004052195**（確認済） | 月次・DB/API可 | METI |
| 6 | 同 在庫率 | 同上 | **0004052196**（確認済）。生産・出荷は連番近傍と推定、未確認 | 月次・DB/API可 | METI |
- 年報の時系列表は **年ごとに別ID**（2025年版は2026-06-30公開、IDは未取得）。appId取得後、getStatsList（statsCode=00550200, 表題「時系列表(2290_…)」）で毎年の新IDを機械的に発見する。IDは推測・ハードコードしない。
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
- 既存の private→publication、rights-policy の公開ゲート（policy失効・hash不一致で0件、保持期限切れはwithdraw）に乗せる。

## 5. 収集
- 頻度: 鉱工業指数は月1回（公表は月末ごろ、確報で改定）、年報は7月に月1回×3か月だけ確認。既存Cron `17 18 * * *`内でUTC日判定、Cron追加なし。
- 既存日次Cronで対象日のrunを開始し、既存continuationで小分けに継続する（Cron追加なし）。1回の処理はHTTP 1ページ、または保存済みページの10行のみ。getStatsListは最大4ページ、getStatsDataは選定表ごと最大8ページ・1ページ最大100行。上限内で完了しなければ公開しない。各HTTPは最大3試行、1 source/UTC日につき1 run、完了・失敗・隔離runを再取得しない。HTTP直前に永続予約し、途中停止で結果不明になったページは再取得せず `estat_request_interrupted` で停止する。
- 月次の日付判定は既存のUTC logical slot（予定時刻）を使う。watchdogはe-Statの新規取得をせず、continuationだけが同じrunを継続する。既存Models処理を優先するため、完了が翌日以降になる場合がある。
- appIdは**URLのクエリに入れる仕様**（e-Statの仕様）。所有者がe-Statだけの例外を承認済み。`ESTAT_APP_ID` Worker Secret以外から読まず、リクエストURLにだけ実値を付ける。ログは固定コード、保存URLと証拠はマスク済み。応答JSONの全文字列を解析後にもマスクし、Unicodeエスケープされた反射値も除去する。生応答・ヘッダ・レスポンス由来URLを保存・追従しない。`ESTAT_ENABLED` は厳密な文字列 `"true"` のみ有効、Secret欠落時はthrowせず `policy_skipped / estat_app_id_missing`。EIA等への例外ではない。

## 6. 公開API
- `GET /v1/supply-chain/series`（一覧・定義・単位・版）
- `GET /v1/supply-chain/series/{id}/observations?from=&to=`
- `GET /v1/supply-chain/series/{id}/revisions`
- 全レスポンスに source: 出典「経済産業省生産動態統計／鉱工業指数（経済産業省）、政府統計の総合窓口(e-Stat)（URL）を加工して作成」、license「e-Stat利用規約（CC BY 4.0互換）」、APIクレジット文、fetched_at、「AI向け専用統計ではない」注記。

## 7. テスト
合成JSON fixtureのみ: 秘匿X・ハイフン、単位混在（台/t/百万円/式/基）、品目名変更で新definition version、値改定でrevision、年報IDの年替わり発見、2026様式のコード差分で隔離、appIdがログ・evidence・例外メッセージに出ないこと、公開ゲート失効で0件、Cron不変preflight。

## 8. 費用と保持
既存Worker・D1・非公開R2だけを利用し、有料サービスは追加しない。通常は月に数件の表と一覧ページを取得する想定だが、実際の件数と容量は今回未測定。ページ上限が費用と処理量の上限にもなる。アカウント全体が月20ドルを超える見込みになれば運用方針に従う。

R2には生JSONではなく、マスク済み・正規化済みのページ投影と応答SHA-256を90日保存する。`raw_artifacts` の既存削除経路を使う。正規化履歴は1095日という運用上限で、ライセンス上の削除期限を主張しない。公開readは期限切れを即非表示にし、既存continuationで公開行から先に小分け削除する。sourceやflagを無効化しても期限処理を続ける。D1 Time Travelのコピー消去を行DELETEで保証しない。復元後も現行policy/hash/期限を適用し、NASは変更しない。

## 9. 実装と有効化の境界
- `config/sources/estat_meti_seidou.json`: 統計00550200、年報4グループ。`estat_meti_iip.json`: 統計00550300、品目別季節調整済の在庫・在庫率。推測の生産・出荷系列は追加しない。
- `src/estat.ts`: 固定e-Stat API endpoint、getStatsListによる年ごとのID発見、有限ページング、単位と十進文字列・欠測記号保持。表IDをコードに固定しない。設計書の過去IDは調査時点の参考だけ。
- `src/estat-pipeline.ts` / `src/estat-store.ts`: 永続checkpoint・lease、マスク済み証拠、追記履歴、値変更時だけbefore/after改定。名称・単位・基準年の変更は同じ系列の別定義で自動連結しない。未知の軸・既存と異なるコード集合、および未審査の2026年以降の年報は隔離。承認済みschema署名だけを明示設定し、設定変更時はpolicy版も更新する。
- public `0004_supply_chain_stats.sql` / private `0017_supply_chain_stats.sql`: 追加のみ。実装前にローカルの全44 refsを `git ls-tree` で調べ、公開0004・非公開0017の未使用を確認。リモートfetchはしていないので、マージ前にも競合確認する。既存0001等は不変。
- 公開は既存 `source_publications` と `publication_batches` を使う。全ページ処理完了だけを公開し、読取時にもbundled sourceの許可、policy版、設定hash、取消し、期限、公開完了時刻を検査する。改定は両入力と派生権利も確認する。
- source設定は追加したが、フラグとsourceは無効のまま。有効化・実HTTP・Secret作成・本番操作は今回の対象外。生成スキーマ・OpenAPIも同期する。
- public migration未適用の場合、新3 endpointだけ固定JSON `public_store_unavailable` / 503を返す。既存health/sources/datasets/FX/Models/GPU等のSQLは新テーブルを参照せず、APIのbindingもPUBLIC_DBだけのまま。

## 10. 検証とレビュー
合成の一覧・表・値だけを使用し、外向きHTTPなし。実payloadの構造や本番性能・容量・認証成功を実証するものではない。未知の実構造は公開を止め、別途レビューする。Node 24.22.0で以下を検証した。

- `pnpm check` 相当（`node scripts/run.mjs check`）: 整形・型・境界チェック成功。
- 通信待受/子プロセス制限のない21ファイル208件の合成単体テスト、およびresilienceテスト1件成功。うちe-Stat/API/権利登録22件は実際の追加migration/query SQLをsocket不要のSQLiteで実行。fixtureは合成のみ。
- 両Workerのbuild（Wrangler `--dry-run`）成功。offline preflightはstatic_valid/ready=true、network_performed=false。生成source/researchスキーマとOpenAPIを同期し、再生成一致を確認。
- 全件 `pnpm test` 相当はMiniflareを含む経路で完了できず中断。`pnpm test:runtime` 相当は `listen EPERM 127.0.0.1` で失敗。preflight-planの12件もsandboxの子Node起動が `spawnSync ... EPERM` となる。これらを成功とは扱わず、通常の実行環境/CIで再実行が必要。

定義の適用開始年はソース版の年から推測せず、`valid_from_year=null` として表の年（source_table_year）を別記する。

相互レビューはAGENTS.mdに従いClaude Code（claude-sonnet-5-5）が担当し、意見が割れたらclaude-opus-5-5が判断する。今回はネットワーク禁止のためClaudeレビューは実施しておらず、承認済みとは扱わない。commit不可のsandboxのため変更は作業ツリーに残す。merge/deployは行わない。
