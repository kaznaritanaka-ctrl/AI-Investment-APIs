# DC案件進捗トラッカー（非公開研究）— ローカル実装 2026-10-22

状態: **schema/code/tests/docsのみのローカル実装**。push/PR/deploy/remote D1変更/実データ取得なし。**Private D1 のみ、公開APIへは絶対に出さない**。
既存の土台: src/dc.ts と docs/dc-supply-chain-schema.md（project→site→phase、容量の定義別保持、推定割当禁止）。これを拡張し、新しい設計思想は持ち込まない。

## 1. 目的
- 国内（＋必要なら海外数件）のDC案件10〜20件について、計画・用地・許認可・系統接続・建設・稼働の各段階、容量、予定日、変更理由、資金調達の履歴を残す。
- 研究上の問い: 遅延・縮小は「需要が弱い」のか「電力・金融・許認可」で止まったのかを分解する。
- **理由が公表されていなければ `unknown` のまま。需要減などを自動推定しない。**

## 2. 状態モデル
- 状態は既存 `DCPhaseSchema.status` の12値＋`land` / `permit` / `grid_connection`。`plan`は`proposed`、`operation`は`it_operational`に対応。変更は`delay` / `downsize` / `cancel` / `upsize` / `acceleration`イベントで追記する。
- 各phaseに `planned_service_date`（予定）と `actual_service_date`（実績）を別列。予定変更は新しい観測行として追加（上書き禁止）。
- capacity: 既存どおり measure_kind（planned_mw / contracted_mw / energized_mw / it_operational_mw）を混ぜず、decimal文字列＋as_of＋出典。
- change_reason: `power`, `financing`, `permit`, `supply_chain`, `demand_stated_by_operator`, `other_stated`, `unknown`。**operatorが明言した場合だけunknown以外**。原文引用（短文）とURLを必須にする。
- financing: 借入・社債・増資・リース・補助金（行政イベント台帳のevent_idと紐付け可）。金額・満期・担保は開示値のみ。

## 3. データモデル（private D1 追加migration案 `migrations/private/0016_dc_tracker.sql`）
0016は未使用番号と確認済み。0004と0010〜0013の予約を維持し、既存migrationは変更しない。以下の概念モデルを§11のsourceごとの不変snapshotとして実装。
- `dc_projects`(project_id, name_ja, operator_entity_id, country, prefecture, tracked_since, tracking_status['active','paused'])
- `dc_sites`, `dc_phases`（既存dc.ts型に合わせる）
- `dc_observations`（不変）: obs_id, run_id, project_id, site_id, phase_id, field, scope, scope_id, value_text, value_decimal, unit, as_of_date, source_id, source_url, source_published_at, fetched_at, evidence_sha256, evidence_level['primary_disclosure','official_registry'], basis, source_quote, status['draft'], drafted_by['deterministic','ai_codex','ai_claude','kaz']。effective status / reviewed_at / review_batch_idは別の追記レビューから読取時に合成。
- `dc_change_events`: event_id, project_id, kind['delay','downsize','cancel','upsize','acceleration'], reason_code, reason_quote, source_url, obs_ids
- `dc_financing_events`: event_id, project_id or entity_id, instrument, amount_decimal, currency, maturity, collateral_text, source_url, disclosed_vs_inferred（inferredは保存拒否）
- `dc_review_batches`: batch_id, created_at, item_count, decided_at, decision_summary
- 不変trigger（observations/events）。承認は status を変える別テーブル `dc_observation_reviews`（追記のみ）で表し、元行は不変。

## 4. Kazの手間を最小にする運用
**将来の運用案（今回Cron・通知接続なし）**:

1. 毎週（日曜夜）AIが、登録済みsourceの新着だけを差分取得し、変更候補を `draft` として作る（Codexが決定的抽出→Claudeが照合。どちらも原文URLと引用を必須）。
2. 月曜 07:00 の Morning Brief に「DC案件の更新候補 N件」をまとめ、**1件1行・平易な日本語・承認/却下/保留の3択**で提示。iPhoneで返信だけで済む形（「全部OK」「3番だけ却下」）。
3. Kazの返答をAIが `dc_observation_reviews` に記録。未回答は `draft` のまま（自動承認しない）。
4. 案件の追加・削除（10〜20件の範囲）はKazの方針判断。AIは候補を提案するだけ。
- 目安負担: 週5分以内。毎日の人手入力は不要（AGENTS.md「No daily human data entry」）。

## 5. 情報源と4つの確認（取得／保存／AIへ送信／再配布）
公式発表のみ。各sourceを個別にsource configへ登録し、**全権限 review_required から開始**（AGENTS.md: 記載なし・判断不能は非公開研究、grant登録はKaz承認）。
| 情報源 | 取得 | 保存 | 外部AIへ送信 | 再配布 | 状態 |
|---|---|---|---|---|---|
| METI認定・リリース（PDL1.0） | 要wire check（本日403） | PDL上は可（ただし review_required で開始） | PDL上は可（同左） | 可（公開台帳側で） | 行政台帳と共有 |
| 事業者の公式プレスリリース・IR（例: さくらインターネット、KDDI、ソフトバンク、ハイレゾ、GMO） | 各社サイト規約を個別確認 | 未確認 | 未確認（本文の著作物性あり） | 不可扱い（研究のみ） | 要確認・社ごと |
| TDnet適時開示 | 利用規約の自動取得条項 未確認 | 未確認 | 未確認 | 不可扱い | 要確認 |
| EDINET（金融庁、有報・臨時報告） | API利用規約あり、未精読 | 未確認 | 未確認 | 未確認 | 要確認 |
| 自治体の公表（立地協定・環境アセス・開発許可） | 自治体ごと（PDL採用が多いが要確認） | 同左 | 同左 | 同左 | 要確認・自治体ごと |
| 電力広域的運営推進機関（OCCTO）系統接続情報 | 未確認 | 未確認 | 未確認 | 未確認 | 要確認 |
| 新聞・業界誌・調査会社 | **対象外** | — | — | — | 使わない |
- 「外部AIへ送信」はClaude/Codex/Grokに本文を渡すこと。既定は**URLとメタ情報だけ渡し、本文は許可確認後**。
- 契約データや非公開の提供情報は入れない（今回の範囲外）。

## 6. 収集方式
- 週1回、source当たり最大1〜3ページ、既存の bounded networking（3 attempts/page、1 run/source/UTC日）。
- 新着検知はRSS/一覧ページのハッシュ差分。本文抽出は決定的パーサが基本、AIはdraft作成のみで、AI出力はevidence（原文引用＋URL）が無ければ破棄。
- evidenceは R2 private。実装済み受入はテスト環境の合成JSON投影のみ。実ページのwire adapterは未実装で、live要求はHTTP前に拒否する。Public APIは PUBLIC_DB のみbindのまま（このテーブルはPrivateに作るので構造上も出ない）。

## 7. テスト
- 合成fixtureのみ。予定日変更の追記、理由unknown維持（理由文なし→unknown）、inferred資金調達の拒否、承認なしdraftがMorning Brief集計に「未承認」として出ること、公開APIから到達不能であること、不変trigger、0016をpopulated DBへ適用。

## 8. 費用
- 週数十リクエスト、D1数千行/年、R2数十MB/年。Workers Paid込み枠内で追加は小規模の想定。今回実行・設定・費用の追加なし。実運転前には3リポジトリ合算の月額20ドル上限を確認する。
- AIのdraft作成はサブスク内のCodex/Claude（週1回・数件）。APIキー課金は使わない。

## 9. Kazに決めてほしいこと
1. 追跡する案件10〜20件の選定方針（例: METI認定11件の事業者の主要DC＋国内大型案件数件）。AIが候補一覧を出すので選ぶだけ。
2. 週次レビューを月曜Morning Briefに載せる形でよいか。
3. 事業者IR・TDnet・EDINET・自治体・OCCTOの各sourceについて、AIが規約確認した結果をもとに research grant を登録してよいか（ソースごとに承認）。

## 10. Claudeレビュー反映（2026-10-22）
- **既存のresearchゲートを使う**: 独自の draft/approved だけにせず、0007〜0009 の research grant・保存ゲート・保持モード（unapproved/fixed_days/until_revoked を明示）・review_due で取得停止・1 run/source/UTC日・3試行/ページの上限に乗せる。grantが無いsourceは取得も保存もしない。
- **語彙を src/dc.ts に合わせる**: 状態は dc.ts の status（12値）と planned_service_date/actual_service_date、根拠は basis（announced/contracted/official_operational_report/third_party_report/estimate）を使う。land/permit/grid_connection は dc.ts に無いので **dc.ts を拡張**（status追加）する案とし、third_party_report と estimate は本トラッカーでは保存拒否（公式発表のみのため）。disclosed_vs_inferred は dc.ts の値を使い inferred は拒否。operator は private 側の entity テーブルを新設（公開台帳とはDBが違うためFKなし、法人番号で突合）。
- **書き込み経路**: Collector は agent無効・決定的のみ。AI draft は box 上のバッチ（Codex優先、両方上限なら翌週）で作り、private D1 への書き込みは専用の内部エンドポイントではなく **レビュー済みSQLバッチを migration と同じ相互レビュー手順で適用** する案（Admin/AdminRead は SELECT専用のまま拡張しない）。要設計確定。
- **AIへの本文送信**: external_llm_processing が allowed のsourceだけ本文を渡す。それ以外はURL・タイトル・日付のみで、AIは「確認候補」の提示に留める。
- **Kazの返信の展開**: 「全部OK」は提示した batch_id の全item を1件ずつ review 行に展開。削除・取消し系の項目は一括承認の対象外（個別回答必須）。
- **削除**: 不変triggerと別に、権利停止・保持期限の purge 経路（既存方式）を持つ。
- **番号**: private 0016（0004予約、0010〜0013はPR #18用に予約済み）。追加すると docs/private-gpu-deploy-checklist.md の「未適用は0015のみ」条件も更新が必要。
- **R2**: 将来の実取得は一覧hash差分があったページだけ保存し、R2 lifecycleで保持を強制する案。現在は合成投影をrunごとの固定キーへ保存する検証のみ。lifecycleの実環境変更は今回行わない。

## 11. 実装と今回の境界（作業指示との統合）

- Node 24を使用。対象branchは`codex/dc-tracker-draft`。private追加migrationは`0016_dc_tracker.sql`だけ。Public API、PUBLIC_DB、Admin/AdminRead、config/sources、既存grant、Cron、Secrets、NASは変更しない。push、PR、deploy、remote migration、実HTTP取得、live smokeは行わない。
- `src/dc.ts`のproject/site/phaseとevidenceを再利用する。`dc-tracker-schema.ts`が原単位・decimal文字列・scope対応・公式basis・原文URLと短い引用を検査する。理由は事業者の明言と引用が両方ある場合だけunknown以外を認める。資金調達は`disclosed`だけ。企業単独の資金調達はentity_idのみを記録し、projectへの推定割当をしない。
- `ResearchConfigSchema`へprivate専用`dc_tracker` / `dc-tracker-v1`を追加。既存9権限、source別owner/wire/terms/retention review、明示保持mode、保存snapshot、current権利、history_access、外部取消し/削除markerを再利用する。sourceの自動登録・grant昇格はしない。proposalは`config/proposals/research/meti_dc_tracker.json`だけ。enabled=false、9権限は全てreview_required、保持modeはunapproved、案件IDは所有者選定前のplaceholder。
- `collectResearchPage`のテスト専用JSON受入で、1 run/source/UTC日、page上限3、page当たり20項目（最大60）、3 HTTP試行/pageの既存上限を維持。実HTTP経路はDCだけ未接続として拒否する。CollectorへAIを接続しない。AI草稿はexternal_llm_processing=allowedに加えてURLと引用を必須とし、その他のsourceはAI向け出力をURL・案件タイトル・公表日に限定する。実運転用の原文照合と引用からの事実確認はwireレビューと相互レビューで確定するまで未承認。
- 安定record_keyはsource_id・disclosure_id・scope・scope_id・fieldのSHA-256。値・配列順・取得時刻に依存しない。予定変更は新runの別observationとなり、旧行を上書きしない。証拠には原文に関するevidence_sha256と引用、受入投影には別のpayload_hashを保持する。合成以外の原文hash照合は将来のwire adapterの責任で、今回実施済みとは扱わない。
- page番号・総数・実件数・next_page・coverage・重複IDを検査する。空一覧・途中・ページ上限到達はpartialのまま隠す。全pageの総数一致と全件の保存を確認してcompleteにする。未掲載から中止・需要減・容量ゼロを推定しない。
- `research_observations`のINSERT triggerでDC各テーブルへ同じtransaction内で投影する。project/site/phase/entityは`obs_id`ごとの不変snapshotなので、同一business IDに複数の当時版を保持できる。更新禁止、通常DELETE禁止。全payload、entity名・案件名・変更理由・金融条件・レビュー項目は元研究観測の外部キーcascadeで、既存`purgeResearchRun`の最大20観測ずつの削除へ接続する。metadataのみのbatch_id・件数・pending識別子は監査用に残す。research-control markerと元の削除日・バックアップ期限は保持し、Time Travel内の消去は主張しない。
- `dc-tracker.ts`はprivateなローカルlibrary。現在の権利と保持期限を毎回確認したread、未承認件数のMorning Brief用整形、提示batchの固定manifest（`dc_review_batch_items`）、レビュー追記を提供する。1提示20項目までで残件数を返し、保留・中止項目が先頭にある場合も`observation_ids`で次の提示範囲を選べる。Worker HTTP/Admin RPC/通知処理には接続しない。将来の本番SQL batch適用はmigrationと同じ相互レビュー手順を通す。現在のAPIはそのローカル合成検証であり、本番書込口ではない。
- Kazの「全部OK」はそのbatchの各項目のapproved行に展開。cancel/downsize/phase cancelledは個別回答必須。明示回答のapproved/rejected/holdに対応し、無回答・holdはdraft。一度のbatchの決定は不変、再判断は新batch。purgeでmanifestが欠けたbatchは一括処理を拒否する。`decided_at`/決定内容はreview行に記録し、batch元行は変更しない。
- 週次判定は月曜00:00 UTCを境界とする純粋関数。日曜夜の準備・月曜07:00 JSTの配信は運用案で、今回Cronや通知は追加しない。
- 行政イベント台帳の公開API/openapi実装は別作業。このtrackerは`admin_event_id`文字列の参照だけを持ち、公開DBとのFK・参照取得・公開投影を追加しない。

## 12. 検証と引継ぎ

実行対象は`pnpm install --frozen-lockfile`（ローカルキャッシュ・offline）、`pnpm check`、`pnpm test`、`pnpm test:runtime`、`pnpm build`、オフライン`pnpm preflight`、生成schemaの一致確認。検証結果と相互レビューの状態は下記の実行記録に追記する。実環境D1/workerdで通っていない結果を代替SQLiteの成功で置き換えない。

相互レビューはClaude Code `claude-sonnet-5-5` / highで行う。利用不可なら承認済み・本番準備完了とはせず、未完了として引き継ぐ。所有者判断が必要な事項は§9の案件選定・配信方針・sourceごとのgrantであり、今回はどれも承認を求めず有効化しない。コミットは`kaznaritanaka-ctrl <kaznaritanaka@gmail.com>`、ローカルのみ。

### 2026-10-22 ローカル検証記録

- Node v24.22.0 / pnpm 11.19.0。`pnpm install --frozen-lockfile --offline --trust-lockfile --store-dir=/tmp/aiapi-prod-drift-pnpm-store`は成功。既存キャッシュと、lockfileのSHA-512に一致するローカルnpmキャッシュのundici 7.29.1を使用し、lockfileは不変。trust-lockfileは既存lockfileの再メタデータ取得を止めるためのoffline指定で、新依存や版変更はない。
- `pnpm check`、`pnpm build`（既存deploy --dry-runのみ）、`pnpm preflight`（network_performed=false）、生成schemaの再生成一致は成功。
- D1を起動しない関連7ファイルの67テストとresilience 1件は成功。新規DC contractは7件。
- 新規DC統合8件は、temporaryなnode:sqlite D1代替とmemory R2による**補助検証**で成功。populated DBへの0016追加、旧観測・不変trigger、予定変更の追記、未承認/保留/却下、分割提示、権利/期限gate、空/部分一覧、日次上限、20件単位のpurge、R2 DELETE失敗後の再試行、marker保持と復元証拠の再削除を検証した。通常のMiniflare/workerdの成功ではない。
- **必須チェックは未完了**。通常の`pnpm test`はローカルbind拒否で完走できず停止し、`pnpm test --bail 1`で既存price-of-compute統合の起動失敗（listen EPERM 127.0.0.1）を確認。新規DC統合も通常実行では同じbeforeAll起動失敗。`pnpm test:runtime`も同じlisten EPERMで失敗。実行可能な環境で全件とruntimeを再実行するまで、全合格・本番準備完了とはしない。
- Claude Code `claude-sonnet-5-5 --effort high`のread-only reviewを試行したが`Not logged in`で終了。相互レビュー未完了であり、承認済みとはしない。
- ローカルcommitを指定authorで試行したが、worktreeのGit保存先`/workspace/aiapi/.git/worktrees/aiapi-dc/index.lock`がread-onlyのためstage時点で拒否された。コミット未作成。作業ツリーに変更を保持し、push/PR/deploy/remote migrationは実行していない。

実行ログはローカル`work/dc-*.log`（Git対象外）。完了条件の未達は環境制約として引き継ぎ、テストや相互レビューの条件は緩めていない。
