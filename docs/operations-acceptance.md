# 継続運用の受け入れ・本番保全（2026-10-04）

本番の最小メタデータを2026-10-04 14:51–15:16 JSTに読み取り確認した記録です。今回の修正はローカル候補で、本番反映していません。公開前検査でNetlify Appの対象repo範囲を確認できず、所有者がGitHubへのpush保留を指定しました。PR作成・main mergeも未実施です。

## 本番とソースの対応

| Worker | 稼働version（100%） | Git SHA | tree | 切替UTC |
|---|---|---|---|---|
| API | d51a23b0-afbb-4c49-b3ef-a220d1b5ff4f | 24768e9e19f26b70555a7d1f738be43cde758d01 | 9ea7f7f92debc1c5796501357d112b4a7ff4b049 | 2026-10-01 02:05:02 |
| Collector | 764bb171-582b-47a0-ad40-5d6aadc61ee6 | a534ff06c776987844dad68ad7112501b52fc82b | 0ac8dc59eba8d964e49bff29d232f0f496dc7ed1 | 2026-10-04 04:27:29 |
| Admin | 51e3f59d-1586-4507-8370-fdca8823e9f4 | 97277dee49f888c69e54cef72e8566d1d432ef73 | 892d6b742c536e35c9e7f4b48e9aae3e856b9bbd | 2026-10-04 04:44:39 |

private台帳5件と稼働versionを照合しました。[配信台帳の保全](admin-releases/)には3件の過去記録と今回のCollector/Admin記録があります。台帳の既存record/evidence digestは変更しません。record内の `evidence_ref` は配信時workspaceの参照で、同名のevidenceとAdmin manifestをこのディレクトリへ複写して追跡可能にしました。非公開のSQL応答やログはGitへ入れません。

配信時のfrozen Collector module SHA-256は `145c6db6f83d66b60c7ee38c4693759880fcfdf635045d837a8869cde805e8ed`、Admin server moduleは `16185dc38509ffafaee29892c20716f16828eec9a3be9d556728ddff93e4ae94`。Admin台帳のartifactはserver単体ではなくfrozen manifestで、SHA-256は `582bc8c781f1e152135e1ac7b8649ab25774716c8ec671c60b59ebd8c446eaec` です。配信時のreadback一致と、今回のソースtree照合を根拠に対応を確定しています。今回の修正版ビルドや別環境の再ビルドが本番バイナリと一致したという意味ではありません。今回の検証環境はNode 24.19.0・pnpm 11.19.0・API Wrangler 4.140.0・Admin Wrangler 4.143.0です。再ビルドではNode 24・pnpm 11.19.0、各commitのlockfile、API/Collector compatibility 2026-09-01・Admin 2026-09-29とWrangler/Vite設定を再ビルド条件として固定します。

API repoの元HEADはa534ff0、Admin repoは97277deで、両方cleanでした。両repoで `codex/preserve-production-20261004` が元commitを保持し、修正は `codex/operations-acceptance-20261004` です。APIのGitHub origin/mainはdd43e54、AdminのGitHub mainは5ed8eb6。Adminの従来originはローカルrepoなので維持し、GitHubを `github` remoteに追加しました。既存worktree、独立したoperations-phase1/GPU作業には変更していません。

開始時の未公開履歴はAPI 2 commit/26 blob、Admin 4 commit/66 blobを検査しました。credentialパターン候補は2件とも合成テストのredaction sentinel。変更ファイル一覧・fixtures・release証跡の点検で本番本文、実価格fixture、私的ログ、認証値の追加を認めませんでした。網羅的な秘密情報不存在証明ではありません。追加修正も検査してローカルcommitへまとめ、公開前には最終未公開履歴全体を再検査します。Cloudflare Workers Buildsは3 Workerともtriggerなし、Pagesなし、両repoのWebhookとGitHub deployment履歴は0、CIは検証だけ。Netlifyのrepo接続範囲は再認証が必要で未確認のため、公開条件は未達です。

## 現在の収集・公開

private migrationは0001/0002/0003/0005、publicは0001/0002/0003。0004は独立作業の未適用案であり、番号衝突を解消してから別途扱います。Collector CPU 5000ms、COLLECTION_ENABLED=true、AGENT_ENABLED=false、private/public D1・private R2 bindingsを維持。Cronは毎日03:17 JST、watchdog03:47、continuation03:00–08:55の5分間隔。APIはPUBLIC_DBのみ、AdminはADMIN_READ→Collector#AdminReadと既存ASSETS/metadata用Secret。全Workerでworkers.dev/previewは無効です。Secret値は取得していません。

最新予定枠2026-10-03T18:17Z（10月4日03:17 JST）：ECBは2観測/2受入、原系列2＋派生1公開。観測03:18:01 JST、公表対象日は10月2日で前回と同じですが、今回も取得済みです。Models.devは155モデル、310観測/265受入、完全snapshot・公開batch完了、650 components。取得03:18:06、公開03:56:02 JSTで約38分です。価格隔離45は `price_component_missing` 16と `unretained_mode_conditions` 29、前回から件数・理由とも同じ。2日前は44件（不足15、条件29）でした。品質gateは緩和していません。

直近3拡張枠で公開完了を記録していますが、いずれも現Collector版へ切替前です。旧秒付きrunと誤missingを同じ分の予定枠として照合。healthの最終完了08:56 JSTはidle continuationであり、新観測時刻ではありません。公開 `/health` は15:16 JSTにHTTP 200。過去403/1010はアクセス障害の記録として保持し、収集失敗へ読み替えません。DB照会は必要なSELECTのみ、書込み0・市場再取得0・実通知0です。

## 状態判定と通知候補

`operational-status.ts` は既存の予定枠resolverとAdmin `runDTO` /公開gateを再利用します。API到達性、処理記録、観測完了、完全snapshot/公開、外部監視receiptを分離します。日次起動の猶予10分、Models進捗停止20分（通常5分の4枠）、Models最終期限6時間です。6時間は既存capture windowで、03:47は期限ではありません。価格不変・changes=0は正常。ECB source_dateの据置を取得失敗にせず、カレンダー未評価を明記します。disabledは対象外、enabledのpolicy停止・設定driftは要確認。隔離は同scope/policyの前回完了snapshotと件数・理由を比較し、新理由・総数増加・同じ総数でも理由別件数の増加・確認不能を区別します。

`pnpm operations:check` はoffline、`pnpm operations:check --remote --allow-network` は固定先のCloudflare GET/単一SELECTと公開health GETだけを行い、送信しません。Secretは環境の既存 `CLOUDFLARE_API_TOKEN` に限定し、対象accountのD1 ReadとWorkers Metadata Read-Onlyが前提です。[D1 queryの公式permission](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)はD1 Readを受理します。既存Admin Secretを取り出したり権限を拡大しません。このCLIの本番接続自体は今回未実行で、本番確認は既存MCP/通常GETを使いました。未取得や例外は0件・Healthyにしません。

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

合成、今回のread-only本番確認、将来の候補配信後の実測を分離します。2026-10-04の最終ローカル確認は次のとおりです。

| 対象 | 結果 |
|---|---|
| API check | 型・format・境界検査が成功 |
| API test | 20 file/157ケースを確認（初回153成功＋失敗3 file/21ケースの再検証が全件成功） |
| API runtime | workerd内の通知dry-run/失敗/復旧、GPU 1,051件/22ページ/23 invocation、Models 50/250/1,000件が成功 |
| API preflight / build | offline preflight成功、network=false。Collector/API dry-run成功。source schema/OpenAPI差分なし、git diff --check成功 |
| 合成復元 | private/public schema・観測・系譜・訂正・as_of・FK・immutable trigger・0006適用後の読み取りが成功。本番復元訓練ではない |
| Admin | 型、単体93件、Vite/client境界、dry-run、既存browser14件（Edge/合成）が成功。画面コード変更なし |

初回全体テストでは、既存Modelsの2ケースがWindowsの30秒上限、配信記録の1ケースが実行ユーザー差によるGit所有者確認で停止しました。追加した隔離理由別増加の1ケースも変更前moduleと変更後テストが同一実行に混在して失敗したため、最終コードを新しいプロセスで読み直して再検証しました。再検証コマンドは `pnpm test tests/models-integration.test.ts tests/operations-acceptance.test.ts tests/admin-release.test.ts --testTimeout 60000 --reporter verbose`。Git例外は当プロセスの対象repoだけ（GIT_CONFIG_COUNT/KEY_0/VALUE_0）です。CIのグローバルtimeout・assertionを緩めておらず、新規の複数snapshotを読む受け入れケースだけ60秒枠を明示しました。GitHub CIはpush保留のため今回未実行です。

通知CLIはoffline既定動作を確認し、本番接続は既存MCPによる最小SELECT/通常health GETだけです。新checkerのremote認証、外部監視の送達、実Webhook、配信後CPU、新版の自然Cronは未検証のまま残します。

目標は「同じ検証対象版で7つの連続する日次枠が手修正なしで収集・公開完了」。現a534ff0は次の10月5日03:17 JSTが最初の日次枠で、現在は0/7です。今回の通知修正版も未配信なので0/7。旧版での成功を混ぜず、途中deploy/手修正があれば対象版と起点を再確認します。待機・新しい予約・手動Collector起動はしません。

次の自然枠では03:17起動、ECB完了、Models5分checkpointの進捗、03:47の同一run認識、完全snapshotと公開件数・時刻、隔離理由/前回差、09:25時点の未完了を確認します。件数は155/265を固定値にせず、当日snapshotから照合します。

| 別途承認する変更単位 | 理由・具体的変更 | 影響・費用 | 戻し方 |
|---|---|---|---|
| GitHub公開の再開 | Netlify対象外または自動公開なしを証拠付きで確認後、2repoの保全/修正branchをpushしてPR。現在は所有者指定で保留 | code/検査済metadataの公開。新サービス費用なし | 新branchを維持しmainへmergeしない。履歴を上書きしない |
| private D1 0006 | 上記SHAのSQLでincident表、outbox nullable列3/index1を追加。既存pending不変 | 小さなschema/metadata追加。既存D1従量内 | additive schemaを残してcodeを戻す。DROP/Time Travelを通常rollbackに使わない |
| Collector修正版の配信 | 承認直前にcommit/artifact/version/config差分を固定。activation未設定で通知は停止のまま | Cron・権利・収集範囲維持。通知候補を通常成功から生成しなくなる | 0006を残し、旧versionへ戻す前に通知Secretを外すか未設定を確認。旧codeはcutoffを無視して旧pendingを送るため、Secretありのまま旧版へ戻さない |
| 通知経路の有効化 | 送信先・受信側idempotency確認、Secretと新しいNOTIFICATIONS_ACTIVE_FROMを設定、dry-run後に承認した1通知で送達確認 | 最大5件/回、継続24h、最大3試行。送信先料金は選定後確定 | activationを外して停止。旧pendingは保存しsentへ変えない。新epochで再開 |
| 独立監視/dead-man | 上記read-only checkerの外部schedule、限定credential、receipt監視と通知を個別設定 | runner/query/通知先の従量あり。見積・送達/停止試験が必要 | schedule停止・専用credential失効。Collectorを止めない |
| 5年以上の保存 | 新policy、容量測定、archive/読戻し設計と段階移行を別レビュー | R2/D1/移行の追加費用未確定 | 検証完了前は現データを削除せず現policyを維持。移行済みデータの短縮/削除も別承認 |

既に完了した0005、a534ff0/97277de配信、台帳5件追記を再承認待ちに戻していません。Admin/APIの新しいdeployは今回不要です。main mergeは今回行いません。
