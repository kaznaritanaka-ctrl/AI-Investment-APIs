# Highreso／Rebro 非公開研究のデプロイ前チェックリスト

**2026-10-22の現状更新（Kaz提示）**: 2026-10-22 07:53 JSTに、Kaz承認のもと、本番Collectorをmain `58f007f` + `PRIVATE_GPU_RESEARCH_ENABLED=true`でデプロイ済み。PR #27でmainの`wrangler.collector.jsonc`もtrueに一致した。Highresoのみenabled=true、Rebroはdeferredでenabled=false。2026-10-21 22:45 JSTのKaz承認、Highresoの保存済み実応答によるwire・指紋確認と365日保持の設定も引き続き有効。以下は配備前に用意した手順の記録として、コマンド・チェック項目をそのまま残す。個別の実施結果は別途確認する。運用方針はAGENTS.mdに従う。

## e-Stat追加時の適用順序（未実施・2026-10-22）

- [ ] [e-Stat設計・有効化境界](supply-chain-stats.md#9-実装と有効化の境界)と相互レビュー・CI・ローカル検証を確認する。適用順序は **public `0004_supply_chain_stats.sql` → private `0017_supply_chain_stats.sql`**。公開側の適用結果・台帳・追加テーブルを確認してから非公開側を適用する。0017を先行させず、既存migrationや設定を上書きしない。
- [ ] 片側未適用でもe-Stat再開が `work:false` となり、既存GPUの再開・保守が続くことを確認する。public不足時は固定 `estat_schema_unavailable` を記録する。これはe-Stat有効化の許可ではなく、`ESTAT_ENABLED="false"`・両sourceの `enabled=false` を維持する。今回の作業ではmigration・deploy・Secret作成・実HTTPは行わない。

<a id="dc-0016"></a>
## DC事業者8社の配備手順（未実施・2026-10-22）

承認ref: **Kaz owner approval 2026-10-22T09:43Z dc-sources**。これは8社の取得・非公開保存・内部分析のgrant承認であり、本作業でdeploy・remote migration・実HTTPを行ったという意味ではない。DC_TRACKER_ENABLEDは`"false"`。相互レビュー・CI・全必須テストと既存データ相当の0016ローカル検証が揃ってから担当AIが実施する。Kazにコマンド操作は依頼しない。既存GPUのschema gateへ0016を追加しない。以下の後ろにある0015手順は過去の配備記録であり、「未適用は0015のみ」という条件を今回のDC配備へ流用しない。

### DC-1: 現行状態と保持環境を固定

- [ ] [対象案件・週次制限](dc-project-tracker.md#dc-sources-20261022)、[提供された規約評価](dc-source-terms-20261022.md)、8 JSONを照合する。指示の案件番号は11件（13という件数とは不一致）。19はTKY12へ置換、TKY11は含めない。外部AIへの本文・引用送信と公開5権限はdenied。
- [ ] 現行Collector version IDを控え、main/PoC/Models/Highreso設定と今回差分を照合する。PRIVATE_GPU_RESEARCH_ENABLED=`"true"`、AGENT_ENABLED=`"false"`、既存COLLECTION_ENABLED・3 Cron・binding・Secret・domain/Accessを維持する。古いmain構成を上書きしない。DC追加だけならAPIを再配備しない。
- [ ] `pnpm check`、`pnpm test`、`pnpm test:runtime`、`pnpm build`、offline preflight、生成schema一致、0016のmigration/FK/不変trigger/purge試験、Claudeとの相互レビューとCI完了を確認する。SQLite補助試験をD1/workerd合格に読み替えない。
- [ ] 下記コマンドで実際のmigration台帳と通常設定の未適用を確認する。0007/0008/0009/0014/0015および既存基盤が適用済み、**未適用が0016の1件のみ**であること。違う場合は停止して差分・releaseを再レビューする。0016が既適用の場合も再適用せず、適用SQLと配備対象の同一性を照合する。既適用SQLを書き換えて差分を吸収しない。
- [ ] 初回登録前にdc_8社のresearch_sourcesが未登録であること。登録済みの場合はhash・現行権利・停止/取消しマーカーを照合し、承認更新は新policy版とadoptReviewedResearchConfigで明示する。Cronは自動昇格しない。
- [ ] D1の365日履歴と7日R2最小投影、30日Time Travel/backupを区別する。`research/dc_softbank/`等8社のprefixに期限を超える保管・本文archiveがないこと、保守Cronと削除backlogを確認する。R2 lifecycleは7日以下の補助削除を確認し、実設定結果を非公開記録へ残す。この文書の参照は実設定済みの証明ではない。`research-control/`は削除ルール・復元の対象から除外する。

```bash
pnpm exec wrangler deployments list -c wrangler.collector.jsonc
pnpm exec wrangler d1 time-travel info ai-investment-private -c wrangler.collector.jsonc --json
pnpm exec wrangler d1 migrations list ai-investment-private --remote -c wrangler.collector.jsonc
pnpm exec wrangler d1 execute ai-investment-private --remote -c wrangler.collector.jsonc --command "SELECT name FROM d1_migrations ORDER BY id"
pnpm exec wrangler d1 execute ai-investment-private --remote -c wrangler.collector.jsonc --command "SELECT source_id,policy_version,config_hash,suspended FROM research_sources WHERE source_id GLOB 'dc_*'"
```

version ID・bookmark・日時・対象DB・確認結果は非公開作業記録に残す。bookmarkは復元や消去ではない。月額3リポジトリ合計20ドル超の見込みならKazへ相談する。

### DC-2: 0016だけを一時migrationディレクトリで適用

0015と同じ単一ファイル・既存台帳の方式。0016はまだremote未適用として準備した追加migrationであり、公開DBには一切適用しない。一時設定はprivate DBだけをbindし、Worker deployには使わない。

```bash
set -euo pipefail
dc_migration_dir=$(mktemp -d /tmp/private-dc-0016.XXXXXX)
mkdir "$dc_migration_dir/migrations"
cp migrations/private/0016_dc_tracker.sql "$dc_migration_dir/migrations/0016_dc_tracker.sql"
cmp migrations/private/0016_dc_tracker.sql "$dc_migration_dir/migrations/0016_dc_tracker.sql"
cat > "$dc_migration_dir/wrangler.json" <<'JSON'
{
  "name": "private-dc-0016-migration",
  "account_id": "0f9bb71bb987011462a91596f7cc9e6f",
  "d1_databases": [
    {
      "binding": "PRIVATE_DB",
      "database_name": "ai-investment-private",
      "database_id": "f9239883-9929-4137-8079-5a03d9a8beb2",
      "migrations_dir": "./migrations",
      "migrations_table": "d1_migrations"
    }
  ]
}
JSON
ls -1 "$dc_migration_dir/migrations"
pnpm exec wrangler d1 migrations list ai-investment-private --remote --config "$dc_migration_dir/wrangler.json"
```

- [ ] 一時dirの内容・専用設定の未適用一覧がともに0016の1件だけで、account/DB ID/台帳が現行対象と一致すること。専用設定だけで通常設定の全体照合を代替しない。失敗・不一致ならapplyしない。

直前bookmarkを再取得・保存してから、専用設定でのみapplyする。通常設定による一括apply、台帳を迂回する`execute --file`は使わない。

```bash
pnpm exec wrangler d1 time-travel info ai-investment-private -c wrangler.collector.jsonc --json
pnpm exec wrangler d1 migrations apply ai-investment-private --remote --config "$dc_migration_dir/wrangler.json"
pnpm exec wrangler d1 time-travel info ai-investment-private -c wrangler.collector.jsonc --json
pnpm exec wrangler d1 migrations list ai-investment-private --remote -c wrangler.collector.jsonc
pnpm exec wrangler d1 execute ai-investment-private --remote -c wrangler.collector.jsonc --command "SELECT name FROM d1_migrations WHERE name IN ('0007_private_research.sql','0008_research_retention.sql','0009_research_retention_states.sql','0014_research_assessments_append_only.sql','0015_private_gpu_daily.sql','0016_dc_tracker.sql') ORDER BY name"
pnpm exec wrangler d1 execute ai-investment-private --remote -c wrangler.collector.jsonc --command "PRAGMA foreign_key_check"
```

- [ ] 直後bookmark・適用結果を保存。通常設定の未適用0件、上記6件の台帳、FK違反0を確認する。失敗なら配備を停止する。0016はadditiveで、down migrationや既存履歴の書換えをしない。

### DC-3: falseで配備してから週次取得を有効化

```bash
pnpm exec wrangler deploy -c wrangler.collector.jsonc
```

- [ ] 最初はDC_TRACKER_ENABLED=`"false"`で配備し、version IDと実効変数を確認。既存GPUフラグはtrueのまま。通常の収集・公開・healthを確認し、DCのHTTP/新規runが0であることをprivate台帳で確認する。
- [ ] 配備条件が全て揃ったらDC_TRACKER_ENABLEDだけを`"true"`へ変更し、check・相互レビュー後に上記deployを再実行する。新Cron、手動live smoke、追加Secretは使わない。既存`17 18 * * *`の**月曜18:17 UTC（火曜03:17 JST）**を待つ。他曜日・watchdog・continuationでは取得しない。
- [ ] DC用schema gateは0007/0008/0009/0014/0016を照合し、足りなければdc_schema_unavailableでskipする。既存GPU用gateは従来の5件のまま。robotsは毎run再確認し、禁止/確認失敗ではページを取らない。3要求にはrobotsを含み、同じrunの失敗後も予算をリセットしない。

### DC-4: 初回・次週・PUBLIC_DBの確認

```bash
pnpm exec wrangler d1 execute ai-investment-private --remote -c wrangler.collector.jsonc --command "SELECT source_id,scheduled_for,synthetic,state,http_page_attempts,observation_count,last_error FROM research_runs WHERE source_id GLOB 'dc_*' ORDER BY scheduled_for DESC,source_id LIMIT 16"
pnpm exec wrangler d1 execute ai-investment-private --remote -c wrangler.collector.jsonc --command "SELECT source_id,status,COUNT(*) n FROM dc_observations GROUP BY source_id,status"
pnpm exec wrangler d1 execute ai-investment-private --remote -c wrangler.collector.jsonc --command "SELECT COUNT(*) n FROM dc_observation_reviews"
pnpm exec wrangler d1 execute ai-investment-private --remote -c wrangler.collector.jsonc --command "SELECT source_id,scheduled_for,retention_snapshot_json,evidence_expires_at,normalized_expires_at FROM research_runs WHERE source_id GLOB 'dc_*' ORDER BY scheduled_for DESC LIMIT 8"
pnpm exec wrangler d1 execute ai-investment-public --remote -c wrangler.collector.jsonc --command "SELECT COUNT(*) AS research_dc_tables FROM sqlite_master WHERE type='table' AND (name GLOB 'research_*' OR name GLOB 'dc_*')"
pnpm exec wrangler d1 execute ai-investment-public --remote -c wrangler.collector.jsonc --command "SELECT COUNT(*) AS research_dc_rows FROM published_observations WHERE source_id GLOB 'dc_*' OR source_id IN ('highreso_public','rebro_public','highreso','rebro','meti_dc_tracker')"
pnpm exec wrangler d1 execute ai-investment-public --remote -c wrangler.collector.jsonc --command "SELECT COUNT(*) AS research_dc_policies FROM source_publications WHERE source_id GLOB 'dc_*' OR source_id IN ('highreso_public','rebro_public','highreso','rebro','meti_dc_tracker')"
```

- [ ] 最終3件の**PUBLIC_DB結果は全て0**。APIはPUBLIC_DBだけをbindし、DC経路を追加していないことも照合する。0でなければ有効化を止め、原因を調べて切戻す。
- [ ] 完了時の8社runはsynthetic=0、月曜slot、1 source/UTC週1run、http_page_attemptsは2〜3。ページが現行構造に適合すれば合計11件のdisclosure draft、Kaz未回答ならreview行0。robots拒否/redirect/サイズ超過等のpartialを完了として報告しない。実ページの適合は今回未確認であり、固定件数に合わせて取得上限・パーサを緩めない。
- [ ] PDFはhashのみ、日付・容量・理由は補完されない。AI候補はURL・タイトル・日付の3キーだけ。元観測のstatusはdraftのまま、承認はKaz回答のレビュー追記による。次週に別runと新robots確認、同slotの再配送でHTTP追加0を確認する。
- [ ] snapshotはfixed_days/365日、証拠7日、backup/Time Travel30日。idle枠で8社の期限保守が進むこととR2削除backlogを確認する。Collector全体のhealthだけでDC成功としない。DCエラーは本文を含まない固定コードとprivateのlast_errorを照合する。

### DC-5: 切戻し・保持継続

通常の取得停止は各configのmaintenance.collection_stopped=true（DCフラグtrueを維持）。緊急時はDC_TRACKER_ENABLED=`"false"`へ戻して再配備、またはDC-1で控えた**直前Collector version ID**へ切戻す。GPU有効化前の古いversionを流用しない。

```bash
pnpm exec wrangler d1 time-travel info ai-investment-private -c wrangler.collector.jsonc --json
pnpm exec wrangler rollback <DC配備直前のCollector-version-id> -c wrangler.collector.jsonc --message "DC tracker rollback"
```

- [ ] 実際の切戻しversion/実効DCフラグと既存Highreso/Models/PoC・公開応答を確認し、失敗原因と結果をKazへ報告する。ローカルfalseだけでremote停止としない。今回APIは変更しないのでAPI切戻しも不要。
- [ ] 0016とデータは残し、DROP・down migration・D1全体復元を自動実行しない。Worker切戻しはD1/R2を戻さない。DCフラグfalse/旧版はDC期限保守も停止するので、保存済みデータがあれば元の7日/365日期限内に担当AIが代替保守・保守版復旧を確保する。元期限を延長しない。
- [ ] 復元は別途影響を確認し、research-control/を戻さず全run再評価・再削除、元deleted_at/backup期限を維持する。dc_review_batchesのhash/created_at/item_countと固定pending/nullはsource contentを含まないためpurge後も残る。manifest/本文/レビュー判断は消え、不完全batchで「全部OK」は拒否する。D1 DELETEをTime Travelコピーの消去と報告しない。

## 配備・有効化前

- [ ] 現行本番のCollector/PoC/Modelsのコード・設定・migration状態を固定する。古いmain版を新しい本番構成へ上書きしない。既存Cron、公開範囲、Admin、Secrets、binding、NASを維持する。
- [ ] Claude Codeとの相互レビューとcheck/test/test:runtime/build、オフラインpreflight、生成schemaの検査を完了する。不一致はOpusの判断をPRに記録する。制約環境のSQLite代替試験をD1/workerd本体の通過と読み替えない。
- [ ] privateの0007_private_research.sql、0008_research_retention.sql、0009_research_retention_states.sql、0014_research_assessments_append_only.sql、0015_private_gpu_daily.sqlの適用を確認する（0010〜0013はこのrepoにない）。既存0001〜0003等も維持する。研究Cronは全5ファイルの台帳確認に失敗したらresearch_schema_unavailableでskipし、自動適用はしない。remote migrationはmigration自体の相互レビューと既存データ相当のローカル検証後だけ。破壊的migrationはOpus判断が必要。
- [ ] 対象sourceの取得形式と最小投影を実応答で確認しwire_contract_review_refを記録する。Highresoは呼び出し側が取得済みのwork/live/をオフライン解析して確認済み（下記wire記録）。Rebroは見送り。本文・実fixtureをGit/CIへ保存しない。
- [ ] [規約確認記録](license-review-20261021.md)のRebro別サイト利用規約の未公開・第10条の適用リスクを確認する。公開範囲や既存grantを広げず、禁止と判明した場合は収集を止める。
- [ ] robotsFingerprint（CRLF→LF、前後trim、UTF-8のSHA-256）を実応答と照合する。規約はtermsFingerprintによるHTML解析・可視本文正規化で照合する。抽出テキストだけから規約hashを推測しない。
- [ ] Highresoは11/1 00:00 JSTより前にterms_sha256、以降は確認済み新版のnext_terms_sha256を使用する。URLは/termsが第一。新版が/5401872にしかない場合はレビューしたhighreso_terms_fallback=trueと新policy版で切替を記録する。redirectや同一runの4要求目は認めず、再取得には明示登録・日次予算を確認する。
- [ ] 保存モード・期間・根拠、実際のTime Travel日数（7/30）、backup上限、R2 lifecycleを確認しretentionのreview refを埋める。target_daysは許諾ではない。research-control/を短期lifecycleから除外し、取消し・削除マーカーを復元でも巻き戻さない。
- [ ] 各runのimmutable config_versionsと保持snapshotが保存されることを確認する。設定変更後の保守は保存版で行い、期限は延長しない。旧履歴への読取許可は現行権利・history_accessで独立に審査する。新config取得には新policy版とadoptReviewedResearchConfigの明示更新が必要。Cronはこの権限更新を自動化しない。
- [ ] 最終設定でassertResearchAllowedが通ることを確認する。source.enabled、所有者承認、wire、独立した各権利、規約指紋、保存環境の全検査が必要。新grant、Secrets/権限拡大、ドメイン/Access、公開範囲拡大、費用増は個別にKazの承認を得る。
- [ ] フラグfalseの版で既存処理の回帰を確認してから、許可済み設定と厳密な文字列trueへ切り替える。既存継続枠で2sourceの保守を交互に実行し、取得はHighresoのみ、1 source/UTC日1 run・最大3要求、private履歴の出典情報、PUBLIC_DBへの研究行ゼロを確認する。
- [ ] 取得停止、取消し、特定run削除、期限到来、R2削除失敗、復元後の再削除を確認する。固定コードのログとprivate保持台帳で判断し、Collector全体の健康情報を研究成功の証明にしない。1runの例外後も巡回が進み、失敗runを再試行できることを確認する。
- [ ] 保持評価台帳の増加（参考: 24行/日なら約9千行/年）、HTTP最大約45秒の健康更新遅れ、1MB HTMLの実クラウドCPUを確認する。ローカルCPUを5000ms適合の証明にしない。18:05台の前日slot空振りを欠測成功に数えない。月額アカウント合計20ドル超の見込みはKazに相談する。

## 取得停止・取消し・削除と復旧

Kazはブラウザ／スマホのチャットで停止方針・対象をAIへ伝える。AIが対象JSONを編集し、相互レビュー・CI後に反映する。日次の手入力やKazのコマンド操作を要求しない。

1. 取得だけ止めるならmaintenance.collection_stopped=true、またはsource.enabled=false。PRIVATE_GPU_RESEARCH_ENABLED=trueを維持する。config hashが変わっても、保存済み版の期限削除・証拠削除は継続する。
2. 取消しはmaintenance.revoke_atに発効日時を設定する。取得は直ちに止まり、発効後CronがR2の取消し記録を先に保存し、D1をsuspendして対象を削除する。R2失敗は成功扱いせず、次の巡回でも再試行する。
3. 特定runの削除はmaintenance.delete_requestsへrun_id、requested_at、basis_ref、all_copies_delete_byを記録する（最大5件）。実際の削除義務と全コピー期限をKazへ報告・確認した上で反映する。Cronがsourceを照合して削除マーカーを保存し、1回20観測ずつ処理する。全コピー期限を満たせない場合はbackup_deadline_missedを確認し、消去完了と報告しない。
4. 設定から停止・削除要求を消してもR2の取消し・削除記録は解除しない。未知の権利、内部レビュー期限だけを削除義務や無期限保持の根拠にしない。
5. フラグfalseは保守も止める。緊急の全停止時だけ使い、元の削除期限を守る代替保守と復旧を確保する。取得停止のためにフラグfalseや旧版を通常運用しない。
6. DB復元ではR2 research-control/を巻き戻さず、保存済みconfig版・snapshot・現行権利と外部マーカーを照合して全runを再評価する。本文だけ復元されたR2も再削除し、元のdeleted_at・削除期限・backup情報を維持する。D1行DELETEをTime Travelコピーの消去と説明しない。
7. 再開は新policy版、登録更新、必要な旧hash利用承認と全取得ゲートを確認してから行う。自動でgrantを更新しない。デプロイ後の動作確認に失敗したら直前の動作版へ戻してKazへ報告する。その版が研究保守を持たない場合も期限内の代替保守を確保する。新しい本番構成を古いmainで上書きしない。


<a id="approval-20261021"></a>
## 10/21 22:45 JSTの承認と保持の意味

承認ref: **Kaz owner approval 2026-10-21T13:45Z**（この作業へのオーナー指示）。Highresoのみ自動取得・非公開保存・内部分析を承認する。公開、raw/normalized/derived/commercial再配布、外部LLM処理、AI学習は引き続きdenied。Rebroは「**/rules/ 第10条（査定・買取目的外の行為/当社が不適当とする行為）と未公開のサイト利用規約のリスクにより見送り（deferred）**」。以前の準備承認を本番収集承認とせず、enabled=false、取得・保存・内部分析はreview_required、owner_approval_ref=nullとした。今後の再開は改めてソース別承認が必要。

Highresoの新policyは`highreso_public-20261021-private-v4`。`normalized_mode=fixed_days / normalized_days=365`により各runのrecorded_atから365日で読取を停止し、既存Cronの保持処理が20観測ずつ自動削除する（48観測は複数巡回）。厳密な時刻に全行が一括消去される仕組みではないので削除待ちを監視する。R2の最小投影は従来どおりevidence_days=7、archive_days=0、source.policy.retention_days=7（証拠保持の意味）で、正規化履歴365日とは別。`target_days=1095`はスキーマで定めた研究目標にすぎず、保存を1095日へ延長する権利でも削除期限でもない。ongoing_storage / storage_review_holdはnullのまま。

内部再確認日は`terms.review_after=2027-01-15T00:00:00Z`に残す。旧設定のpolicy.valid_untilはこの再確認日を重ねていたためnullへ変更し、365日の保存承認を一律1/15で打ち切らない。再確認日に取得・読取は止まるが、承認された履歴をレビュー期限だけで削除しない。明示的な取消し・削除義務・短縮条件は独立に優先する。`retention_limit_days`は全コピーを含む契約上限であり、通常履歴365日と取り違えて365を入れない（365+backup30ではゲートを通らない）。今回はnull、backup_days=30、time_travel_days=30とする。全コピーを365日以内に消す約束ではなく、削除後の復元用コピーは最大30日残る。旧runの期限は変更しない。

D1 Time TravelはWorkers Paidの無料既定30日・常時有効・追加費用なしとの**Kaz提示の2026-10-21確認結果**を採用する。根拠: [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)。本作業はネットワーク禁止のため再照会していない。Cloudflare側のTime Travel設定は変更しない。既存config/deployment.jsonのd1_time_travel_days=30とも一致する。

<a id="wire-20261021"></a>
## 10/21のオフラインwire確認（Highresoのみ）

呼び出し側が2026-10-21 22:46 JST（13:46Z）にPUBLIC_GPU_UAで固定URLを各1回取得した応答を使用した。`work/live/robots.txt.raw`、`terms.raw`、`5401872.raw`、`compute_instances.raw`と各.hdrで、全てHTTP 200。今回のネットワーク要求は0回。新版確認を含むこの4件は事前wireレビューであり、本番の1 run最大3要求とは別。本番はrobots→選択された規約→価格の3要求を維持する。

既存robotsFingerprint（CRLF→LF、trim、UTF-8 SHA-256）とtermsFingerprint（HTML解析、script/style等を除いた可視本文のNFKC・空白正規化、SHA-256）を直接実行した。ファイル全体のSHA-256や抽出テキストのhashではない。

| 設定 | 既存関数で計算した指紋 |
|---|---|
| robots_sha256 | `afe52e7c75ac2596bae07625f23c224be2ddaea397da7a3434c4a91107a0f446` |
| terms_sha256（/terms、現行） | `4ce6d0b8842660a4844dee2ce13ab7072e8f06957e433dc18566ddb45f3bcb3e` |
| next_terms_sha256（/5401872、11/1適用新版） | `dedccccce1277fd21a361d066bf81655314bc639cfc8c0a3e222c8c650baef49` |

価格ページは445,723 bytesでmax_bytes=1,000,000以内。parsePublicGpuに実HTMLを渡し、入力28行、対象24インスタンス、モデル除外4行、GPU枚数除外0行、時間/月額各2枠で**48観測**、coverage=complete、reasons=[]を確認した。対象はA100 40GBが12インスタンス、A100 80GBが12インスタンス、全てGPU1枚。この応答でH100は0件。未掲載のH100価格を補完しない。scopeは従来のA100/H100・GPU1枚を維持し、除外行は他モデルである。page_size/source.max_records=48ちょうど、max_input_rows=100以内で切捨てなし。次に対象が増えて48を超えたら停止する。

実ページ由来の価格数値は記載せず、確認結果は上記の件数・構造だけを残す。金額はdecimal文字列、時間/月額とinstance単位（JPY/instance hour、JPY/instance month）を維持する構造で、instance ID、GPU型番/VRAM、枚数、原金額/単位、ストレージ、出典/hashを含む既存の許可投影だけを抽出する。地域・専有/共有・最低期間等は補完せずnull/unknownとし、ソフト一覧・広告・本文全体を保存しない。D1の本番観測を作った検証ではない。

構造差異と最小修正: 実ページと規約両版はscript内の裸の`&`（クエリ文字列）を含み、XMLValidatorが`public_gpu_table_schema_changed`で拒否した。XMLValidatorは既存stopNodesを解釈しないため、もともと投影/指紋から除外されるscript/styleの本文だけを検証前に除く4行を追加した。外側のタグを残し、未閉鎖script/style・表、入れ子、colspan/rowspan等の拒否は維持する。見出しの階層、8/12列の表、GPU仕様と料金表の対応は既存パーサのまま適合し、価格抽出・モデル選択・48件上限・指紋の可視本文正規化は変えていない。裸の`&`/`<`と壊れた構造を人工値だけで再現する回帰テストを追加した。生HTML・ヘッダ・実fixtureはwork内のみでGit/CIへ含めない。

11/1 00:00 JST（10/31 15:00Z）以降は既存切替ロジックがnext_terms_sha256を使う。/termsが第一でfallbackは未設定。**/5401872と/termsはページ見出し・共通ナビゲーションもhash対象なので、将来/termsに載る新版がこのhashと一致する保証はない。** 不一致時は価格取得前に停止し、保存応答をレビューして新policyで明示更新する。自動的に4要求目を増やしたり指紋を緩めたりしない。

## 10/22朝の実施手順（AI担当、配備前に用意した手順の記録）

以下は10/21時点で翌朝の担当AI向けに用意したremote手順の記録。現在の配備状態は冒頭の現状更新を参照する。Kazへコマンド操作を依頼しない。既存の認証とNode **24**（node --versionでv24確認）、lockfileどおりの依存を使う。`wrangler`の表記はこのrepoの`pnpm exec wrangler`。構文はインストール済みWranglerコードでも確認した。相互レビューとCIが全て通ってから実施し、上限で片方のレビューができなければ翌日に回す。Cloudflareの現行版が進んでいたら以下の指定版を盲目的に上書きせず差分を再照合する。

### (a) 07:00 JSTごろの健全性と配備前の固定

- [ ] Morning Briefを確認し、03:17 JST（10/21 18:17Z）枠のECB/Models/PoCの収集・公開状態、source別最新観測、欠測/partial、保持backlog、バックアップ結果を既存の読み取り画面・台帳で照合する。03:47 JSTのwatchdog結果も見る。idle continuationのlast_collector_completed_atだけで成功としない。NASの設定・スクリプト・認証情報には触れない。
- [ ] 必要なら既存の`node scripts/operations-check.mjs --remote --allow-network`と公開`https://api.ai-investment-research.net/health`、既存公開サンプルを確認する。既存権限で読めない項目は未確認と記録し、新Secretや権限拡大で代用しない。PoCは専用台帳も確認する。
- [ ] `pnpm exec wrangler deployments list -c wrangler.collector.jsonc`、`pnpm exec wrangler deployments list -c wrangler.api.jsonc`、`pnpm exec wrangler versions view <現行version-id> -c <対象config>`で実version/設定とmain=50f14a3（PR #25マージ済み）からの今回差分を照合する。Cron3本・既存source/PoC設定・bindings・公開範囲を維持する。
- [ ] privateのresearch_sources / research_runsをSELECTし、初回登録前にHighresoの旧configがないことを確認する。既存登録があればhash/停止/外部マーカーを確認し、新policyのadoptReviewedResearchConfigを既存手順で明示レビューする。SQLでhashを書き換えたりINSERT OR IGNOREの成功だけで承認更新済みとしない。
- [ ] check/test/test:runtime/build、offline preflight、生成schema差分なし、Claude Codeの相互レビューとCI完了を確認する。R2は(g)もtrue切替前に実施する。

### (b) private D1の0015適用

**既適用の事実注記（Kaz提示、今回remote再照会なし）:** 本番private D1 `ai-investment-private`（`f9239883-9929-4137-8079-5a03d9a8beb2`）には、2026-10-21 17:4x JSTに0007/0008/0009/0014を適用済みで、`d1_migrations`で確認済み。確認時のTime Travel bookmarkは `0000079c-00000000-0000510b-53013b84a03b58e14f2ecfddb3271f6f`。AGENTS.mdの「0007/0008 are additive and local-only」はこの適用より前の記述であり、ここでは適用事実だけを補足する。AGENTS.md自体の方針は変更せず、取得・保存・有効化等の各ゲートも維持する。現在の未適用は0015のみの想定だが、以下の直前確認で確定する。このbookmarkを0015適用直前の記録として流用しない。

最初にTime Travel bookmarkを取得し、日時・対象DB・配備前versionとともに非公開作業記録へ保存する。Time Travel設定変更・exportはしない。

```bash
pnpm exec wrangler d1 time-travel info ai-investment-private -c wrangler.collector.jsonc --json
pnpm exec wrangler d1 migrations list ai-investment-private --remote -c wrangler.collector.jsonc
pnpm exec wrangler d1 execute ai-investment-private --remote -c wrangler.collector.jsonc --command "SELECT name FROM d1_migrations ORDER BY id"
pnpm exec wrangler d1 execute ai-investment-private --remote -c wrangler.collector.jsonc --command "SELECT source_id,policy_version,config_hash,suspended FROM research_sources WHERE source_id IN ('highreso_public','rebro_public')"
```

- [ ] 通常のCollector設定による上記`migrations list`で、未適用が**0015_private_gpu_daily.sqlの1件だけ**であること、および台帳上0007/0008/0009/0014が既適用であることを確認する。0010〜0013はこのrepoにない。他の未適用が1件でもあれば**停止してClaude Opusの判断を受け、理由をPRに記録する**。0015が既適用、確認失敗、その他の想定との不一致でも停止して再照合し、推測でapplyしない。
- [ ] 0015自体の相互レビューと、既存データ相当のローカルmigration/FK/immutable trigger試験を確認する。0015は追加テーブル/索引/triggerで、既存テーブルを破壊しない。

[operations-acceptance.mdの単一ファイル適用方針](operations-acceptance.md#0006とcollectorだけを通知無効で反映する手順未実施)に従い、repoルートから同じBashセッションで次を実行する。新しい一時ディレクトリに0015だけを同名で複写し、専用設定はprivate DBの1 bindingと既存の`d1_migrations`台帳だけを参照する。public binding・R2・Cron・Worker配備設定は含めない。この一時設定はmigration専用で、deployに使わない。

```bash
set -euo pipefail
gpu_migration_dir=$(mktemp -d /tmp/private-gpu-0015.XXXXXX)
mkdir "$gpu_migration_dir/migrations"
cp migrations/private/0015_private_gpu_daily.sql "$gpu_migration_dir/migrations/0015_private_gpu_daily.sql"
cmp migrations/private/0015_private_gpu_daily.sql "$gpu_migration_dir/migrations/0015_private_gpu_daily.sql"
cat > "$gpu_migration_dir/wrangler.json" <<'JSON'
{
  "name": "private-gpu-0015-migration",
  "account_id": "0f9bb71bb987011462a91596f7cc9e6f",
  "d1_databases": [
    {
      "binding": "PRIVATE_DB",
      "database_name": "ai-investment-private",
      "database_id": "f9239883-9929-4137-8079-5a03d9a8beb2",
      "migrations_dir": "./migrations",
      "migrations_table": "d1_migrations"
    }
  ]
}
JSON
ls -1 "$gpu_migration_dir/migrations"
pnpm exec wrangler d1 migrations list ai-investment-private --remote --config "$gpu_migration_dir/wrangler.json"
```

- [ ] 一時migrations_dirの内容と専用設定の未適用一覧がともに`0015_private_gpu_daily.sql`の1件だけであり、account/DB ID/台帳が上記と一致することを確認する。不一致・コマンド失敗なら停止する。専用設定の一覧だけでは通常設定の未適用確認を代替しない。

適用直前にbookmarkを再取得して非公開作業記録へ保存し、その後に専用設定の絶対パスを指定して1ファイルだけ適用する。通常のCollector設定での一括applyや、台帳を通さない`d1 execute --file`は使わない。

```bash
pnpm exec wrangler d1 time-travel info ai-investment-private -c wrangler.collector.jsonc --json
pnpm exec wrangler d1 migrations apply ai-investment-private --remote --config "$gpu_migration_dir/wrangler.json"
pnpm exec wrangler d1 time-travel info ai-investment-private -c wrangler.collector.jsonc --json
pnpm exec wrangler d1 migrations list ai-investment-private --remote -c wrangler.collector.jsonc
pnpm exec wrangler d1 execute ai-investment-private --remote -c wrangler.collector.jsonc --command "SELECT name FROM d1_migrations WHERE name IN ('0007_private_research.sql','0008_research_retention.sql','0009_research_retention_states.sql','0014_research_assessments_append_only.sql','0015_private_gpu_daily.sql') ORDER BY name"
```

適用直後のbookmarkも日時・対象DB・適用結果とともに非公開作業記録へ保存し、通常設定の未適用が0件、台帳上5件すべて適用済みを確認する。適用失敗・確認不一致なら後続の配備を停止し、失敗時点のbookmarkと結果を記録して再レビューする。PUBLIC_DBには研究migrationを適用しない。

### (c) falseのままCollector/APIを配備・検証

```bash
pnpm exec wrangler deploy -c wrangler.collector.jsonc
pnpm exec wrangler deploy -c wrangler.api.jsonc
```

- [ ] 配備前後でPRIVATE_GPU_RESEARCH_ENABLEDが文字列falseであること、AGENT_ENABLED=falseと既存COLLECTION_ENABLED/Cron/bindingsが維持されることを確認する。両version IDを非公開作業記録へ残す。APIはPUBLIC_DBだけ。
- [ ] healthと既存公開応答、ECB/Models/PoCの継続処理を確認する。次のidle継続枠でも研究HTTP/新規runが増えないことをprivate台帳で確認する。falseは研究の保守も止めるので、既存研究runがあれば元の期限内の代替保守を先に確保する。

### (d) Highresoの取得を開始

- [ ] (a)〜(c)と(g)、相互レビュー/CIが完了していることを確認する。Highreso enabled=true、Rebro enabled=falseの差分を再確認する。
- [ ] AIがwrangler.collector.jsoncのPRIVATE_GPU_RESEARCH_ENABLEDだけを文字列`"true"`へ変更し、checkと差分の相互確認後にCollectorを再配備する。新CronやSecretは作らない。

```bash
pnpm exec wrangler deploy -c wrangler.collector.jsonc
```

既存継続CronはJST03:00〜08:55の5分間隔。研究はidle枠で交互に回り、Highresoの予定候補は07:05/07:35/08:05/08:35 JST（それぞれ前日UTC22:05/22:35/23:05/23:35）。既存処理が優先されるのでこの時刻での実取得を保証しない。03:17論理slotの6時間窓は09:17 JSTまでだが、Cronの最終枠は08:55。朝の切替が間に合わなければ無理な手動取得やCron追加をせず、10/23の03:17以降のidle枠を待つ。1 source/UTC日1 run、最大3要求を守り、事前wireの取得を本番runとして手入力しない。

### (e) 初回runの確認

```bash
pnpm exec wrangler tail -c wrangler.collector.jsonc --format json
pnpm exec wrangler d1 execute ai-investment-private --remote -c wrangler.collector.jsonc --command "SELECT run_id,source_id,policy_version,scheduled_for,recorded_at,synthetic,state,observation_count,http_page_attempts,last_error,next_page,evidence_expires_at,normalized_expires_at,all_copies_expires_at FROM research_runs WHERE source_id IN ('highreso_public','rebro_public') ORDER BY recorded_at DESC LIMIT 5"
pnpm exec wrangler d1 execute ai-investment-private --remote -c wrangler.collector.jsonc --command "SELECT r.run_id,r.source_id,r.state,COUNT(o.observation_id) AS observation_rows,MIN(o.observed_at) AS first_observed_at,MAX(o.observed_at) AS last_observed_at FROM research_runs r LEFT JOIN research_gpu_observations o ON o.run_id=r.run_id WHERE r.source_id IN ('highreso_public','rebro_public') GROUP BY r.run_id ORDER BY r.recorded_at DESC LIMIT 5"
pnpm exec wrangler d1 execute ai-investment-private --remote -c wrangler.collector.jsonc --command "SELECT run_id,retention_snapshot_json FROM research_runs WHERE source_id='highreso_public' ORDER BY recorded_at DESC LIMIT 1"
pnpm exec wrangler d1 execute ai-investment-public --remote -c wrangler.collector.jsonc --command "SELECT COUNT(*) AS research_public_rows FROM published_observations WHERE source_id IN ('highreso_public','rebro_public','highreso','rebro')"
pnpm exec wrangler d1 execute ai-investment-public --remote -c wrangler.collector.jsonc --command "SELECT COUNT(*) AS research_tables FROM sqlite_master WHERE type='table' AND name LIKE 'research\_%' ESCAPE '\'"
```

- [ ] Highresoはsynthetic=0、state=complete、next_page=null。ページ不変ならobservation_count=48かつ観測行48、http_page_attempts=3、last_error=null。件数変化はscopeとcomplete最小投影で判断し、上限超過/欠測を成功にしない。Rebroの新規runは0。
- [ ] snapshotのnormalized_mode=fixed_days、normalized_days=365、time_travel_days/backup_days=30、evidence_days=7を確認し、期限がrecorded_atから計算されていることを照合する。初回/最新observed_atを非公開作業記録へ残す。PUBLIC_DBの上記2件はともに0であること。
- [ ] 固定ログのsource_id=highreso_public/rebro_public、phase=research_acquisition等、error_codeを確認する。research_schema_unavailableなら台帳不足、research_policy_changedなら旧登録hash、public_gpu_terms_review_required / public_gpu_robots_review_required / public_access_review_requiredなら承認指紋、retention_review_required / terms_review_requiredなら保持/再確認ゲート。Rebroのresearch_collection_stoppedは見送りによる予定どおりの停止。
- [ ] **研究成功専用ログはない。** safeLogCodeに未登録のパーサエラー等はoperation_failedへ丸められるので、private research_runs.last_errorも照合する（本文・任意例外はログに出さない）。ログ無エラー・Collector全体の成功だけで研究成功としない。失敗時は次の(f)へ進み、同日再試行で要求予算をリセットしない。

### (f) ロールバックと復元の備え

```bash
pnpm exec wrangler d1 time-travel info ai-investment-private -c wrangler.collector.jsonc --json
pnpm exec wrangler rollback 5e2864aa-0080-453d-b4dd-03e3778a1500 -c wrangler.collector.jsonc --message "Private GPU enablement rollback"
pnpm exec wrangler rollback 8c4dd812-6372-4bb5-ab28-5dcd8608f954 -c wrangler.api.jsonc --message "Private GPU enablement rollback"
```

- [ ] 切戻し前後のbookmarkとversion ID/日時を非公開記録へ保存する。指定versionはKaz提示のCollector/APIの復帰先。翌朝の事前確認で適切な復帰先か照合する。ローカル設定のPRIVATE_GPU_RESEARCH_ENABLEDを`"false"`へ戻し、remoteの実効値もfalse（または研究非対応版で研究経路なし）であることを確認する。ローカル編集だけでremoteが戻ったと判断しない。必要ならCloudflare Dashboardの対象Workerの非secret変数だけfalseへ戻し、反映版を確認する。Secrets、binding、Cron、ドメインは変えない。
- [ ] health・既存取得/公開を再確認してKazへ結果と原因を平易に報告する。0015は残し、down migrationやDROPをしない。Worker切戻しはD1/R2を巻き戻さない。通常の取得停止はenabled=falseまたはcollection_stopped=trueでフラグtrueを維持し、false/旧版は緊急時だけにする。
- [ ] 初回で研究データが既に保存された場合は、falseや旧版では365日/7日期限の保守も止まり得る。元の期限内に承認済み保守版へ復旧する担当・時刻を記録し、既存bounded削除とR2 control照合で期限を守る。期限を延ばして待たない。
- [ ] bookmark取得は復元ではない。D1全体の復元は既存処理も戻すので障害分析後の別判断とする。復元時はresearch-control/を巻き戻さず、全runを再評価・再削除し、元のdeleted_at/期限を維持する。D1のDELETEやbookmarkだけでTime Travelコピーの消去を報告しない。

<a id="lifecycle-20261022"></a>
### (g) R2 lifecycle: 翌朝の確認/設定項目（無料）

ここはlifecycle_review_refの設計レビュー記録であり、**実bucketのルールを確認/設定済みという意味ではない**。本作業ではCloudflare変更0。(d)の前に担当AIがCloudflare DashboardのR2 → ai-investment-evidence-private → Settings → Object lifecycle rulesを確認し、結果/時刻を非公開作業記録へ追記する。

- [ ] 研究の通常履歴365日はD1であり、R2は最小投影7日の別期限。既存evidence/ecb/、Models、PoC、archive/のルールを変えない。研究用prefixに365日を超える保管や無期限の本文backupがないか確認する。
- [ ] 必要なら`research/highreso_public/`だけに365日以内の削除ルールを確認/設定する（無料、設定は翌朝のみ）。既存の7日ルールなら短いままでよい。証拠保持設定が7日なので、365日lifecycleだけに期限保証を任せず、Cronの7日証拠削除とbacklogを確認する。lifecycleは補助であり期限ちょうどの削除を保証しない。
- [ ] `research-control/`（revocations/deletions/maintenance）は別prefix。取消し/削除マーカーを短期lifecycle・包括bucketルール・復元で消さない。包括ルールがcontrolを消すならtrueへ切り替えず、既存データを保護するprefix分離をレビューしてから直す。
- [ ] 対象prefix、日数、control除外、変更の有無を記録する。R2の有料機能/プラン変更、新サービス、新しいbackup exportは追加しない。Cloudflare全3repo合算の月額20ドル超の見込みなら作業を止めてKazへ相談する。
