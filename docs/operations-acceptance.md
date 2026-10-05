# 継続運用の受け入れ・本番保全（2026-10-04）

最新のGitHub反映・Netlify保留解除・残件は末尾の「2026-10-05 GitHubレビュー再開と残件」を参照。以下の10月4日の記録は当時の結果であり、push保留・CI未実行という記述を現在の状態と混同しない。

2026-10-04の最終確認です。ローカル検証は22:58–23:16 JST、本番の最小メタデータの再照合は22:59–23:10 JSTに実施しました。機能・コード・テストは変更せず、下記の固定状態で全検証を再実行しています。GitHub pushは所有者指定の保留を継続し、PR作成・main merge・本番deploy・remote migration・実通知・Secrets変更・監視schedule追加・保存期間変更は行っていません。

## 固定した検証対象

| repo / 作業ディレクトリ | 対象commit | tree | 検証開始・終了時の未コミット差分 |
|---|---|---|---|
| AI-Investment-APIs / `work/p0-main-integration` | `cf726bd52db57f90ffb6299402982e8b6bb77d03` | `4b8c9cc334135424f6bead470743f8919579433f` | なし → なし |
| AI-Investment-Admin / `work/admin-ecb-fix` | `ff46be8ecf20f9df8df52374e3991c5a217e21fe` | `7e696140f96e457e4d7e3e49430819014b639530` | なし → なし |

両repoの対象branchは `codex/operations-acceptance-20261004`。各検証コマンドの前後でHEADとworking treeを確認し、並行編集は行いませんでした。検証終了後の変更は本ファイルへの記録更新だけで、未コミットのまま保持しています。ソース・テスト・lockfile・migration・設定は上記commitから不変です。独立GPU作業 `work/gpu-energy-expansion`（`a0196dc24348cb7185a37e6762ecd9a7c136c288`、clean）も変更していません。

環境はWindows 10.0.26200 x64、Node 24.19.0、pnpm 11.19.0。APIはWrangler 4.140.0、Miniflare 4.20260730.0、Vitest 5.0.2、TypeScript 7.0.2。AdminはWrangler 4.143.0、Vite 8.3.1、Cloudflare Vite plugin 1.62.0、Vitest 5.0.2、TypeScript 7.0.2、Playwright 1.63.0、Edge 154.0.4258.37（`PLAYWRIGHT_CHANNEL=msedge`）です。lockfile SHA-256はAPI `f6a08aa31f8d4fc9ad7e33d56aa1125c2fecd326c96f061490f75151876be57e`、Admin `67fe32508e141e0bcd5b54708ac0ab98135c3638ec47bc8f2217dce505a5ca8e`。依存更新・再インストールはしていません。

workerd/Edgeを起動できるローカル環境で実行し、Git所有者例外は当該プロセスの対象repoだけ（`GIT_CONFIG_COUNT/KEY_0/VALUE_0`）、短い一時パスは `AI_APIS_TEMP_DIR` で指定しました。Gitのglobal設定は変更せず、Wrangler telemetryも無効です。API/Collector compatibilityは2026-09-01、Adminは2026-09-29のままです。

## 本番とソースの対応

| Worker | 稼働version（100%） | Git SHA | tree | 切替UTC |
|---|---|---|---|---|
| API | d51a23b0-afbb-4c49-b3ef-a220d1b5ff4f | 24768e9e19f26b70555a7d1f738be43cde758d01 | 9ea7f7f92debc1c5796501357d112b4a7ff4b049 | 2026-10-01 02:05:02 |
| Collector | 764bb171-582b-47a0-ad40-5d6aadc61ee6 | a534ff06c776987844dad68ad7112501b52fc82b | 0ac8dc59eba8d964e49bff29d232f0f496dc7ed1 | 2026-10-04 04:27:29 |
| Admin | 51e3f59d-1586-4507-8370-fdca8823e9f4 | 97277dee49f888c69e54cef72e8566d1d432ef73 | 892d6b742c536e35c9e7f4b48e9aae3e856b9bbd | 2026-10-04 04:44:39 |

private台帳5件と稼働versionを照合しました。[配信台帳の保全](admin-releases/)には3件の過去記録と今回のCollector/Admin記録があります。台帳の既存record/evidence digestは変更しません。record内の `evidence_ref` は配信時workspaceの参照で、同名のevidenceとAdmin manifestをこのディレクトリへ複写して追跡可能にしました。非公開のSQL応答やログはGitへ入れません。

配信時のfrozen Collector module SHA-256は `145c6db6f83d66b60c7ee38c4693759880fcfdf635045d837a8869cde805e8ed`、Admin server moduleは `16185dc38509ffafaee29892c20716f16828eec9a3be9d556728ddff93e4ae94`。Admin台帳のartifactはserver単体ではなくfrozen manifestで、SHA-256は `582bc8c781f1e152135e1ac7b8649ab25774716c8ec671c60b59ebd8c446eaec` です。配信時のreadback一致と、今回のソースtree照合を根拠に対応を確定しています。今回の修正版ビルドや別環境の再ビルドが本番バイナリと一致したという意味ではありません。今回の検証環境はNode 24.19.0・pnpm 11.19.0・API Wrangler 4.140.0・Admin Wrangler 4.143.0です。再ビルドではNode 24・pnpm 11.19.0、各commitのlockfile、API/Collector compatibility 2026-09-01・Admin 2026-09-29とWrangler/Vite設定を再ビルド条件として固定します。

API repoの元HEADはa534ff0、Admin repoは97277deで、両方cleanでした。両repoで `codex/preserve-production-20261004` が元commitを保持し、修正は `codex/operations-acceptance-20261004` です。保全時に取得したremote-tracking mainはAPIがdd43e54、Adminが5ed8eb6で、今回の最新GitHub head確認値ではありません。Adminの従来originはローカルrepoなので維持し、GitHubを `github` remoteに追加済みです。既存worktree、独立したoperations-phase1/GPU作業には変更していません。

開始時の未公開履歴はAPI 2 commit/26 blob、Admin 4 commit/66 blobを検査しました。credentialパターン候補は2件とも合成テストのredaction sentinel。変更ファイル一覧・fixtures・release証跡の点検で本番本文、実価格fixture、私的ログ、認証値の追加を認めませんでした。網羅的な秘密情報不存在証明ではありません。追加修正も検査してローカルcommitへまとめ、公開前には最終未公開履歴全体を再検査します。Cloudflare Workers Buildsは3 Workerともtriggerなし、Pagesなし、両repoのWebhookとGitHub deployment履歴は0、CIは検証だけ。Netlifyのrepo接続範囲は再認証が必要で未確認のため、公開条件は未達です。

## 現在の収集・公開

22:59 JSTのmigration台帳はprivateが0001/0002/0003/0005、publicが0001/0002/0003。今回の0006は未適用で、23:10 JSTのschema照会でもincident表・追加3列・indexが存在しないことを確認しました。0004は独立GPU/電力作業の未適用案で、今回の適用対象から除外します。適用済みmigrationの内容・番号は変更しません。Collector CPU 5000ms、COLLECTION_ENABLED=true、AGENT_ENABLED=false、private/public D1・private R2 bindingsを維持。Cronは毎日03:17 JST、watchdog03:47、continuation03:00–08:55の5分間隔。APIはPUBLIC_DBのみ、AdminはADMIN_READ→Collector#AdminReadと既存ASSETS/metadata用Secret。全Workerでworkers.dev/previewは無効です。Secret値は取得していません。

最新予定枠2026-10-03T18:17Z（10月4日03:17 JST）：ECBは2観測/2受入、原系列2＋派生1公開。観測03:18:01 JST、公表対象日は10月2日で前回と同じですが、今回も取得済みです。Models.devは155モデル、310観測/265受入、完全snapshot・公開batch完了、650 components。取得03:18:06、公開03:56:02 JSTで約38分です。価格隔離45は `price_component_missing` 16と `unretained_mode_conditions` 29、前回から件数・理由とも同じ。2日前は44件（不足15、条件29）でした。品質gateは緩和していません。

23:07 JSTに直近3拡張枠の収集完了・完全snapshotと、最新枠の公開完了を再照合し、前回MCP結果との一致を確認しました。いずれも現Collector版へ切替前です。旧秒付きrunと誤missingの同一予定枠照合は既存証跡を保持し、今回の合成テストでも再検証しました。healthの最終完了08:56 JSTはidle continuationであり、新観測時刻ではありません。公開 `/health` は23:07:54 JSTに通常GETでHTTP 200。過去403/1010はアクセス障害の記録として保持し、収集失敗へ読み替えません。今回のD1応答はすべて `rows_written=0` / `changed_db=false`、市場再取得0・実通知0です。

## 状態判定と通知候補

`operational-status.ts` は既存の予定枠resolverとAdmin `runDTO` /公開gateを再利用します。API到達性、処理記録、観測完了、完全snapshot/公開、外部監視receiptを分離します。日次起動の猶予10分、Models進捗停止20分（通常5分の4枠）、Models最終期限6時間です。6時間は既存capture windowで、03:47は期限ではありません。価格不変・changes=0は正常。ECB source_dateの据置を取得失敗にせず、カレンダー未評価を明記します。disabledは対象外、enabledのpolicy停止・設定driftは要確認。隔離は同scope/policyの前回完了snapshotと件数・理由を比較し、新理由・総数増加・同じ総数でも理由別件数の増加・確認不能を区別します。

`pnpm operations:check` はoffline、`pnpm operations:check --remote --allow-network` は固定先のCloudflare GET/単一SELECTと公開health GETだけを行い、通知しません。既存 `CLOUDFLARE_API_TOKEN` に対象accountのD1 ReadとWorkers Metadata Read-Only（API名 Workers Tail Read）が必要です。[D1 query](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)はD1 Read、[Worker `/settings` GET](https://developers.cloudflare.com/api/typescript/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/)はWorkers Tail Readを受理します。Workers Scripts Read/Writeの追加は不要です。

今回の通常・検証用実行環境のProcess/User/Machine環境変数に `CLOUDFLARE_API_TOKEN` はなく、対象repoの既知の `.env` / `.dev.vars` にも利用可能な設定はありませんでした。確認したのは存在有無だけです。利用可能な最小権限tokenがないため、**remote CLIは0回、未実行**です。別の保管先にtokenが存在しないと断定するものではありません。MCP認証はCLIと別経路で、MCP成功をCLI認証成功に読み替えません。既存Admin Secretの取り出し、広いWrangler OAuthへの代替、token新規作成・権限拡大はしていません。再確認に必要なのは、対象accountの上記read権限に限定した既存tokenをこのCLIで利用できることと、そのscopeの確認です。

| 判定対象 | 今回確認した根拠 | 新remote CLIとの対応・限界 |
|---|---|---|
| 認証 | 既存MCPは成功。CLI用tokenは利用不能 | CLIのCloudflare認証・実際のSELECT到達は未検証 |
| API到達性 | 通常GET `/health` HTTP 200 | 到達性のみ。収集・公開・監視の成功を含めない |
| 収集 | 最新予定枠のECB complete 2/2、Models complete 310/265、errorなし | checkerのrun/予定枠判定に対応するDB根拠。CLI出力そのものではない |
| 公開 | ECB原系列2＋派生1、Models catalog155＋価格110、batch complete。現policyはactive・期限内 | 完全snapshotと公開件数を別々に確認。650 componentsを650公開観測とは数えない |
| 品質 | 最新・前回とも隔離45（不足16、条件29） | 値不変や既知隔離を新規障害にしない。隔離解消とは扱わない |
| 監視・通知 | `monitor_connected=0`、既存18 pending/attempts=0。CollectorのWebhook Secret・activation設定なし | 外部receipt/実送達は未検証。monitor flagだけで稼働監視の有無を断定しない |

今回の固定対象へのMCP GET/SELECTと通常health GETは前回の結果と整合しましたが、新CLIのHTTPアダプター・認証・本番SQL経路とのend-to-end照合は未了です。未取得や例外を0件・Healthyへ変換しません。

ローカル候補のCollector module SHA-256は `c7c7ea5ef7cb574480fb32b87e07ed4499a22c7af6d8b49683c928c0bea2fc94`、0006 SQLは `7a289907203ad8663920072784828bc09e4e193f48ee208ad48c55ea9d25db8b` です。これはdry-run候補で、新しいCloudflare versionはまだありません。配信前にはその時点のversion/config差分を再照合します。`docs/admin-releases/*.json` はGitの改行変換を無効にし、既存証跡のbyte digestを保持します。

今回の0006はincident表1つ、outboxのnullable列3つ、index1つだけを追加します。既存18 pendingの本文・state・attemptsは変更しません。新codeはsummaryを保存しつつ、成功/idle/通常進行だけではoutboxを作りません。`NOTIFICATIONS_ACTIVE_FROM` が未設定なら送信を拒否します。承認した有効化日時ごとのincidentを記録し、そのepoch・最新event・直近の再判定・24時間以内だけを送信候補にします。旧通知はepochがnullなので対象外です。初回異常、24時間ごとの継続通知、復旧を区別。15分間隔・最大3試行、同時実行claim、receiverのidempotency-keyを使用します。HTTP成功時だけsentにし、送達不明時の重複は受信側の冪等性が必要です。dry-runはDB更新もHTTP送信もしません。

既存18件のmetadata分類：過去の完了報告6件（隔離件数付き3件を含む）、idle5件、既に完了したrunの途中経過6件、秒付きrunに由来する旧false missing1件。最新runへ継続する収集/公開障害はこのキューから確認されません。旧報告を通知有効化時に再送する必要はなく、保存のまま除外します。品質隔離そのものの解消や権利承認を意味する分類ではありません。

外部監視は、Cloudflare endpoint/zone healthcheckが0、通知policyは既存予算警告のみ。ローカルの旧自然Cron点検は期限切れ・PAUSEDで、現版の継続監視ではありません。他サービスを網羅した不存在証明ではなく、確認範囲内では稼働中の独立監視を見つけていません。`monitor_connected=0` は補助記録です。

最小の接続案は、Cloudflare外の既存GitHub runner等で毎日09:25 JSTに本CLIを実行し、収集窓終了後の結果を評価するものです。低遅延が必要なら03:30–09:30の15分間隔を別途予算確認します。runner開始/完了receiptを別の監視先で見守り、定期receipt欠落も通知する必要があります。同じ停止したrunnerが自己停止を検知できるとは扱いません。通知先・永続的な重複/復旧状態・dead-man受信先・credential配布を確定し、実配送と復旧を1回検証するまでは自動監視を受け入れません。新schedule、サービス、Secrets、monitor_connectedの変更はしていません。通常判定にLLMや毎朝の管理画面巡回は不要です。

## 復旧・長期保存

合成復元試験は、ローカル0005のprivate/public schema・観測・lineage・モデル訂正履歴を空のローカルDBへ再構成し、schema/行/外部キー/immutable trigger/過去as_ofと現在APIの一致、その後0006適用を検査します。本番export、クラウドDB複製、Time Travel実行、R2実データ復元、物理ページ破損修復を検証したものではありません。

[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)はPaid30日・Free7日の同じDBへの破壊的な巻戻しです。clone/forkは未対応で、同時queryは取消し。巻戻す前のbookmarkを保存すれば再復元できますが、private/public/R2の分散整合性は自動ではありません。別環境の訓練は、別途承認したSQL export/importで行う方式です。[export/import仕様](https://developers.cloudflare.com/d1/best-practices/import-export-data/)を確認し、長時間の影響、schema版、適用中policy、バックアップ内の削除義務を先に審査します。R2 evidenceの再解析、現在のarchiveだけの完全SQL復元、Time Travelは別の手段です。

Models.devは原カタログ全文を保存せず許可された投影証拠90日、正規化D1/公開/差分1095日、R2 archive365日、Time Travel30日。5年以上（少なくとも1825日）という将来目標に対し、D1で730日、archiveで1460日不足します。MITに1095日上限があるという意味ではなく、運用上の所有者承認範囲です。現行のscope/retention条件と第三者条件を再確認し、新policy版とcapacity審査を経るまで期間を延長しません。

配置案はD1に最新・検索対象の履歴を残し、承認した長期正規化履歴を年度単位のprivate R2 archiveへ移すものです。公開可否の記録、元ID/時刻/fingerprint/訂正/lineage/単位/schema・parser・policy、manifest/checksumを保持し、書込み→件数/hash照合→合成と承認済み隔離環境で読戻し→承認後の期限処理の順です。R2へ置けば権利や復元設計を省略できるわけではありません。raw90日の延長、DB backupを5年残すこと、archiveを5年残すことは別の承認です。今の365日archiveを放置した後で失われた年を作り直すことはできません。

[D1上限](https://developers.cloudflare.com/d1/platform/limits/)は1DB10GB、Paid account既定1TB。private/publicの空きを融通する共通20GBではありません。[既存154モデル実測](p0-runtime-review.md)の一定構成＋余裕50%から5年へ線形延長するとprivate約4.30GB/public約7.19GB。年30%増の例では約8.88GB/14.87GBでpublicが超過します。これらは過去ローカル1日実測からの仮定で、現155モデル650 componentsの5年保証ではありません。現在のprivate 5,988,352 bytes / public 7,045,120 bytes（約6MB/7MB）でも将来成長は証明できません。5GB実容量/7GB予測で再審査、8GB実容量を緊急域とする既存方針を維持します。

[D1料金](https://developers.cloudflare.com/d1/platform/pricing/)は合計5GB超で$0.75/GB月、一定構成の上記5年終点11.49GBなら保存超過分は概算$4.87/月。Workers基本料金・query・他の利用は別です。[R2 Standard](https://developers.cloudflare.com/r2/pricing/)は10GB月の無料枠を共有し超過$0.015/GB月＋操作料。圧縮archiveの実bytes、restore時の重複容量と操作数、削除義務の検証が未了なのでR2の5年総費用は未確定です。新規保存資源も料金契約も追加していません。

ECB/Modelsの内部policy再確認期限は2026-12-26T00:00Z（12月26日09:00 JST）。30日前は11月26日、7日前は12月19日。同期限を元ライセンスの失効日と説明せず、自動延長しません。

## 検証・受け入れと反映手順

合成、read-only本番確認、候補配信後の実測を分離します。次表は**すべて今回の固定状態で各コマンドを最初から完了した結果**です。前回の153件成功と部分再実行21件成功は今回の合格根拠に使用しません。今回、コード修正・テスト修正・選択的な再試行はありません。

| 対象 / コマンド | 実行時間（2026-10-04 JST） | 今回の結果 |
|---|---|---|
| API `pnpm check` | 22:58:20–22:58:27 | 型・format・境界検査成功、exit 0 |
| API `pnpm test --testTimeout 60000 --reporter verbose` | 22:58:28–23:14:07 | **20 file / 157件すべて成功**、skipなし、exit 0 |
| API `pnpm test:runtime` | 23:14:07–23:14:58 | workerdの通知dry-run/失敗/復旧、GPU 1,051件/22ページ/23 invocation、Models 50/250/1,000件成功、exit 0。外部HTTPなし |
| API `pnpm build` | 23:14:58–23:15:03 | Collector/API両方のWrangler dry-run成功、exit 0 |
| API `pnpm preflight` | 23:15:03–23:15:05 | offline、ready=true、errors/blockersなし、exit 0。通知先未設定・外部監視未接続等のpendingは維持 |
| API `pnpm operations:check` | 23:15:05–23:15:06 | offline、network_performed=false、external_monitor=not_verified、exit 0 |
| API `node scripts/generate.mjs` と生成物・差分検査 | 23:15:06 | source schema/OpenAPIの対HEAD差分なし。`git diff --check`成功、working tree clean |
| Admin `pnpm check` / `pnpm test` | 23:15:56–23:16:03 | 型、8 file / **93件すべて成功**、skipなし、各exit 0 |
| Admin `pnpm build` | 23:16:03–23:16:06 | Vite/server/client build・client境界成功、exit 0 |
| Admin `pnpm test:browser` | 23:16:06–23:16:40 | Edge/ローカル合成 **14件すべて成功**、exit 0 |
| Admin `pnpm deploy:dry-run` | 23:16:41–23:16:43 | 生成Vite設定からのdry-run成功、exit 0。`git diff --check`成功、working tree clean |

Adminに独立した `test:runtime` / `preflight` scriptはありません。既存のVite/workerdブラウザ試験・client境界・生成設定によるdry-runを実行した範囲で記録し、存在しない試験を成功扱いにしません。API全体テスト内の合成復元も今回成功しています（schema・観測・系譜・訂正・as_of・FK・immutable trigger・0006適用後の読戻し）。本番復元訓練ではありません。

API全体テストの60秒指定は、Windowsホスト上での各testの待ち時間上限です。assertion、入力、skip、収集・公開・通知の期待値、workerdで検査する処理制限は変更していません。既存のCI設定はそのままです。今回のローカル結果はCI既定timeoutやUbuntu/Chromiumでの成功を証明しません。**GitHub CIはpush保留により未実行**です。ログと開始/終了時刻は各repoのGit対象外 `work/final-review-*.log` / `work/final-review-results.json` にあり、本書へ今回の結果だけを記録しました。

今回生成したCollector `dist/collector/collector.js` のSHA-256は上記候補 `c7c7ea5e…` と一致しました。検証対象commitとlockfileに変更はありません。コード・テスト・設定を後から修正する場合はこの検証結果を新状態へ転用せず、対象を固定し直して必要な検証を再実行します。

### 自然実行の確認範囲

23:07 JSTのSELECTで確認できた直近の日次枠だけを記録します。各枠とも両sourceのstate=complete、error_code=nullでした。

| 予定枠（JST / UTC） | ECB 観測/受入 | Models 観測/受入 | 完全snapshotのモデル数 / 隔離数 | 対象版への算入 |
|---|---|---|---|---|
| 10月2日03:17 / 10月1日18:17Z | 2/2 | 308/264 | 154 / 44 | a534ff0切替前、算入しない |
| 10月3日03:17 / 10月2日18:17Z | 2/2 | 310/265 | 155 / 45 | a534ff0切替前、算入しない |
| 10月4日03:17 / 10月3日18:17Z | 2/2 | 310/265 | 155 / 45 | a534ff0切替前、算入しない |

目標は「同じ検証対象版で7つの連続する日次枠が手修正なしで収集・公開完了」。現a534ff0は10月5日03:17 JSTが最初の日次枠で、今回確認時点は**0/7**です。今回の通知修正版cf726bdも未配信なので**0/7**。旧版での成功やidle continuationを混ぜません。7日分を待機せず、手動Collector起動・新規監視予約も行っていません。新CLI本番経路、実Webhook、独立監視の送達/欠落検知、配信後CPU、本番復元も未検証です。

### NetlifyとGitHub push保留

今回の既存ブラウザでGitHubのInstalled Appsを読み、Netlify Appが存在することを再確認しました。[Netlify App設定](https://github.com/settings/installations/97316872)は「Confirm access / Verify via email」で停止し、対象repo一覧は表示されません。[Netlify](https://app.netlify.com/)はログイン画面で、既存の認証済みセッションは利用できませんでした。実行環境に `NETLIFY_AUTH_TOKEN` もありません。本人確認メール送信、新しい認証連携、権限追加、設定変更は行っていません。

再認証の目的と残る確認は次のとおりです。

| 読み取り先 | 必要な再認証の目的 | push前に必要な確認結果 |
|---|---|---|
| GitHub Netlify App | 現在のAppのRepository accessを閲覧するための本人確認（sudo） | All/Selected repositoriesの別、API/Admin両repoを含むか。対象外ならその設定の確認記録 |
| Netlify既存アカウント | 接続済みprojectのdeploy設定を読むためのログイン | 両repoとの接続、production branch、branch deploy対象、PR Deploy Preview、automatic publishing/build停止状態。保全/修正branchへのpushとPR作成で公開が起きるか |

GitHub App対象外の確認だけで他の既存Netlify project連携まで不存在とは扱いません。repo Webhook/deployment履歴0やCIにdeploy工程がないことも、Netlify側の自動公開不存在の証明にはなりません。両repoについて公開経路がない、または対象branch/PRから自動公開されない根拠を揃える必要があります。設定変更が必要なら別途その変更を承認します。

安全を確認してもpush保留は自動解除しません。再開には、最終未公開差分の点検後、API/Admin両repoの `codex/preserve-production-20261004` と `codex/operations-acceptance-20261004` の公開対象commitを提示し、**所有者によるGitHub push/PR再開の明示承認**が必要です。main mergeと本番deployは含めません。今回のGitHub CIは未実行のままです。

### 0006とCollectorだけを通知無効で反映する手順（未実施）

| 対象 | 適用済み | 未適用・今回の扱い |
|---|---|---|
| private D1 `ai-investment-private` | `0001_initial.sql`、`0002_gpu.sql`、`0003_models_catalog.sql`、`0005_admin_release_ledger.sql` | 候補repoでは `0006_notification_incidents.sql` だけが未適用 |
| public D1 `ai-investment-public` | `0001_initial.sql`、`0002_gpu.sql`、`0003_models_catalog.sql` | 候補repoに未適用なし。今回触れない |
| 独立GPU/電力worktree | 上記本番に0004の適用記録なし | private/publicの `0004_energy.sql` は別作業。複写・適用・番号変更しない |

適用済みSQLは本番Collectorソースa534ff0からの差分がないことを確認しました。今回の0006のbyte hashは `7a289907203ad8663920072784828bc09e4e193f48ee208ad48c55ea9d25db8b`。台帳の空き番号を埋めるために0004を取り込んだり、0005/0006を振り直したりしません。

[D1 migration仕様](https://developers.cloudflare.com/d1/reference/migrations/)とインストール済みWrangler 4.140.0の処理を確認すると、`migrations apply` は指定ディレクトリ内の未適用SQLをすべて対象にします。単一SQLを指定するapply引数はありません。今後承認された場合は、次の順に対象を限定します。今回は以下の適用コマンドを実行していません。

1. 直前のprivate migration台帳・schema・稼働Collector version・Cron・bindings・通知設定を再取得。前提が変われば停止し差分を再レビューする。既存outboxのID/state/attempts/記録時刻と本文digestを非公開に保全し、本文を公開成果物へ含めない。
2. ローカルの専用releaseディレクトリに、上記hashの `0006_notification_incidents.sql` **1ファイルだけ**を同名で置く。専用Wrangler設定のaccountは `0f9bb71bb987011462a91596f7cc9e6f`、D1は `ai-investment-private` / `f9239883-9929-4137-8079-5a03d9a8beb2` の1 bindingだけ、`migrations_dir` はその専用フォルダー、journalは既存 `d1_migrations` とする。public binding・0004・他のSQLを含めない。
3. 所有者の**0006 private-only適用の直前承認後**、その専用設定を明示した `pnpm exec wrangler d1 migrations apply ai-investment-private --remote --config <専用設定の絶対パス>` を使う。通常のCollector設定やGPU worktreeで一括applyしない。SQLだけの `d1 execute --file` で台帳記録を省略しない。非対話環境ではWranglerの確認が省略されるため、ツール内確認を所有者承認の代わりにしない。
4. 台帳への0006追加、表1・nullable列3・index1、既存outbox全行の不変、既存観測/schemaの保護を確認する。不一致・失敗時は旧Collectorを維持して後続を止める。
5. **Collector upload/本番切替の別の直前承認後**、cf726bdと上記artifact hashの候補をアップロードし、version/configを照合して100%切替する。既存Cron・COLLECTION_ENABLED・取得範囲・権利・retention・CPU・DB/R2 bindingsを維持。初回は `NOTIFICATIONS_ACTIVE_FROM` 未設定、`ALERT_WEBHOOK_URL` Secret不存在の両方を必須とし、通知を有効化しない。どちらかが存在・変更されていれば停止して別レビューとする。
6. 切替後はread-onlyの稼働version/設定・Admin読取り互換性・公開APIを確認する。手動収集・実送達試験・新schedule・public migration・API/Admin deploy・配信台帳への書込みを、この承認範囲に含めない。自然枠は到来済みのものだけを別記録する。

rollback候補は現Collector `764bb171-582b-47a0-ad40-5d6aadc61ee6` / a534ff0。旧codeはactivationを無視して旧pendingを送信できるため、**旧versionへ切り替える直前のWebhook Secret不存在確認、または別途所有者が承認した無効化の完了確認が必須**です。確認対象は戻し先versionのbindingと、切替後に実際に有効になる設定です。現在版の設定だけでは代用しません。新codeのactivation未設定だけでは旧codeの誤送信を防げません。Secretが存在する・不存在を確認できない場合はrollbackを停止します。今回の作業からSecret削除の許可は導きません。rollback自体も直前承認と設定照合の対象とし、0006のadditive schemaは残します。DROP・Time Travel・旧pendingの削除/state書換えは行いません。

| 今後必要な承認 | 具体的な対象 | 含まれない変更 |
|---|---|---|
| GitHub push/PR再開 | Netlify公開経路の確認後、両repoの保全/修正branchと最終commit | main merge、本番反映、自動公開設定の変更 |
| private D1 0006 | 上記SQL hash、private DBだけ、専用ディレクトリから1件適用 | 0004、public migration、既存観測/旧pendingの変更 |
| Collector upload/100%切替 | cf726bd・artifact `c7c7ea5e…`、直前の設定差分、通知無効の維持 | Admin/API deploy、Secrets/activation、実通知、監視追加、保存期間変更 |

既に完了した0005、a534ff0/97277de配信、台帳5件追記は完了したままです。上記は次の承認対象を確定した手順であり、今回の実適用承認ではありません。独立GPU作業への変更もありません。

## 2026-10-05 Schema drift recovery候補（別branch・未配信）

追加依頼は `codex/schema-drift-recovery-20261005` で実装し、[調査・権利境界・復旧gate・夜間運用・検証記録](schema-drift-recovery.md)にまとめた。上記cf726bdの凍結検証結果と、新しい候補の結果を合算しない。元operations checkoutの未コミット文書、Admin、独立GPU checkoutは編集していない。

新候補は既存metrics/raw_artifactsを使い、schema recovery用migrationは追加しない。0006候補への依存、0004分離、通知無効、旧Collector rollback時のWebhook不存在確認、GitHub push/PR保留は継続する。`SCHEMA_RECOVERY_ENABLED`、独立runner/schedule、Secrets、実通知、本番反映を有効にしていない。

新候補の最終コードは `148774babd9d1ad476ab9d4b5f64a95ba589bfbb`。2026-10-05 02:22–02:40 JSTに固定状態で194件全test、型・境界検査、runtime、dry-run build、offline preflight/checker、生成物差分確認を通した。別branchの合成修復候補 `3490e2083b2fbf7b716dc03d192432e4b6839d80` は195件全testと同じ5種類の候補検証・保存Evidence再解析がPASS。上記cf726bdの検証結果との合算ではなく、GitHub CI・本番反映の成功でもない。失敗した予備候補を含む詳細とhashは[今回の検証記録](schema-drift-recovery.md#検証結果)に記載した。

## 2026-10-05 GitHubレビュー再開と残件

所有者の「Netlifyは問題ないのでそちらも進めて」に基づき、対象2 repoのGitHub push/PR保留を解除した。根拠は所有者の確認であり、こちらでNetlifyのrepo/branch/preview設定を再認証して検査したという意味ではない。Netlifyの設定変更・deployは行っていない。main merge、本番deploy、remote migration、実通知、Secrets、新schedule、権利・保存期間変更の承認には拡張しない。

指定された本番Collector `a534ff06c776987844dad68ad7112501b52fc82b` とAdmin `97277dee49f888c69e54cef72e8566d1d432ef73` は、それぞれ最新作業branchの祖先で、GitHubでも取得できる。通常push後にremote headを照合した。API mainは `dd43e543ced4703819b68a9e061c20a85f997376`、Admin mainは `5ed8eb66312d3f1e88714d447ea4a58c7b89b375` のまま。force-push、main mergeはしていない。

| repo | 公開・CI検証済みcommit | GitHub CI | Draft PR |
|---|---|---|---|
| API | `32f85f3e2eff60d0a3f8a0d5fb70c25d7d829c4e`（コード基準148774b、後続は検証記録） | [37246616324](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/actions/runs/37246616324)：09:17 JST完了。22 file / 194 tests、型・境界、preflight、runtime、dry-run build、生成物差分が成功 | [#7](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/pull/7) |
| Admin | `ff46be8ecf20f9df8df52374e3991c5a217e21fe` | [37246640534](https://github.com/kaznaritanaka-ctrl/AI-Investment-Admin/actions/runs/37246640534)：09:14 JST完了。8 file / 93 tests、14 browser tests、型、build/client境界、lockfile/差分が成功 | [#3](https://github.com/kaznaritanaka-ctrl/AI-Investment-Admin/pull/3) |

この追記では文書・作業境界の記録だけを更新する。上記成功を文書更新後の新しいCI実行結果と呼ばず、各runの対象commitを保持する。今回の公開前検査ではAPI 88 / Admin 75の未公開blobと履歴を確認し、共通credentialパターン・認証ファイル名に該当する追加はなかった。完全な秘密情報不存在の証明ではない。合成repair例3490e208とその195件を本PRの194件へ合算せず、その例branchも公開していない。

### 実装済みだが反映・受け入れを保留しているもの

| 項目 | 現在の状態 | 残る条件・承認 |
|---|---|---|
| GitHub mainへの統合 | 最新2 branchのpush・CI・Draft PR作成まで完了 | PRレビューとmain mergeの明示承認。Netlifyは現在のblockerではない |
| 運用判定・通知incident管理 | checker、通知epoch、有限retry、旧pending除外は実装・合成検証済み。本番は従来版 | private `0006_notification_incidents.sql`だけの直前承認と、最終Collector候補のupload/切替承認。初回はactivation未設定・Webhook Secret不存在を維持。0004は含めない |
| Schema drift capture/診断 | private quarantine、権利/field whitelist、構造診断、fail closedは実装済み。`SCHEMA_RECOVERY_ENABLED`は未設定 | 最終artifact、実CPU/追加容量、R2 private/lifecycle・期限処理を確認し、Collector反映とflag有効化を個別承認 |
| remote operations checker | 固定GET/SELECT経路を実装。既存MCP読取り結果は取得済み | 前回確認時にCLI用の適切な最小権限tokenがなく、`--remote --allow-network`は未検証。Admin Secret取出し・権限拡大で代用しない |
| 実通知の有効化 | 送信判定・冪等性/retryのローカル検証済み。宛先未接続・実送達未検証 | 宛先、activation日時、Secrets登録、初回送達確認を別承認。旧pendingを再送しない |
| GPU・電力の実収集 | 独立`codex/gpu-energy-expansion` / `a0196dc`にLambda・Sakura DOK・EIA月次・JEPXの実装と159件の合成試験。eBay Browse/Price of Compute latestも既存adapterあり。実sourceは停止中 | 現行v3 Collectorとの統合・再検証、用途別権利、キー、実plan/metadata、live収集、共有capture枠・CPU/容量、独立0004とdeployの承認。キー未準備は最後の所有者回答であり今回再確認していない |
| 本番運用の受け入れ | 過去のread-only照合・合成復元は実施済み | 同じ本番versionで7日間の自然実行、実通知/独立監視、実R2/隔離DBの復元訓練、新候補の実CPU/長期retention負荷は未受け入れ。今回は自然枠を追加取得せず、待機・手動起動・監視予約もしない |

private 0006未適用、private適用済み0001/0002/0003/0005、public適用済み0001/0002/0003、Webhook不存在という本番根拠は10月4日22:59–23:10 JSTの照合である。今回新たに本番DBやSecretsを照会した値ではない。実適用直前に再照合する。上のcf726bd用artifact `c7c7ea5e…` を最新schema recovery候補へ転用せず、最新を配信するならコード基準148774bを含む最終HEAD/artifactを改めて固定する。旧Collector rollbackでは、戻し先の実効Webhook Secret不存在または別承認済み無効化の確認を必須とする。

### まだ実装・接続していないもの

| 項目 | 既にあるもの | 未実装・未接続の範囲 |
|---|---|---|
| 夜間の独立監視と朝briefing | source別overnight JSONと修復receiptの結合CLI、03:20–09:20/5分＋09:25最終の無効なschedule案 | 外部runner、定期起動、独立heartbeat/死活監視、宛先への自動送達。runner/認証/非公開artifact保持/schedule/Secrets/実通知は別承認 |
| 汎用のrepair候補生成 | Models.dev既知wrapper変更の決定的patch、parser版更新、合成contract、回帰・保存Evidence再解析 | field rename、pagination metadata、ECB/GPUの一般的な修復、外部AI runner、同じ本文の別runへの候補再利用・receipt再検証 |
| 本番の保存Evidenceからの復旧完了 | ローカルのpatch/test/reparse/gateと既存の訂正基盤 | quarantineから通常Evidenceへの昇格、対象run/hash/parser版を固定した本番の再解析・訂正・公開を完了する運用経路。再解析PASSだけでは公開完了にしない |
| 追加ソース・長期履歴取得 | GPU共通基盤、辞書、source調査/提案 | Runpodの比較条件付きadapter、Highreso/そろばん・CCIR・日本中古の許諾feed、Price of Compute history、一般backfill。EIA RTO時間別需給、メモリ/DC供給網・rates-credit・capex-utilizationは設計/候補段階 |
| 5年以上の保存と復元 | 現行Models正規化1095日・R2 archive365日、容量推定、manifest/分割配置の設計 | 長期R2履歴の検索・読戻し・一括restore/移行、成長時のD1分割、全DBの自動restore。新保持policy・容量・削除義務・隔離復元の検証と承認が必要 |
| Adminの操作機能 | Overviewと専用7ページ、読み取り/検索/比較は配信済み | 画面からの再実行、設定変更、権利変更。初版で予定した次段階のため、今回のGitHub保全には追加しない |

自動production deploy・未検証の自動公開は意図的に無効で、今回有効化する残件には数えない。価格/単位/意味の推測、前日値による欠測補完、source rights/retentionの自動変更も許可しない。ECB/Modelsの内部policy再確認期限2026-12-26（30日前11月26日、7日前12月19日）は既存の将来確認事項であり、元ライセンスの失効日ではない。

独立GPU checkoutと元`work/p0-main-integration`の未コミット文書は変更していない。既に完了したP0、ECB表示修正、8管理ページ、0005、a534ff06/97277deeの配信、配信台帳5件は保留に戻さない。
