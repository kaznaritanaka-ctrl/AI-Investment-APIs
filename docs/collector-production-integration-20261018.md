# 初回Cloud実行に向けた本番Collector監査・統合手順

この文書は統合前のread-only監査記録です。後続の隔離branchへの統合内容とローカル検証は [統合検証記録](collector-integration-validation-20261018.md) を参照してください。本番の反映状態・承認状態を変更するものではありません。

2026-10-18。Cloudflare MCPのGETと固定SELECT、GitHubのPR/ref参照、ローカルGit差分で確認した。Cloudflare確認時刻は10:00〜10:03 UTC（19:00〜19:03 JST）。これは実行承認書ではない。

**PR #18を現在のcheckoutからそのまま本番deployしてはいけない。本番の配信元として記録された0abf2b6を基点に、PR #16を含むPR #18を統合する必要がある。** そのまま置換すると既存のPrice of Compute（PoC）収集と共有処理予算の対策を失う。private D1の0007〜0014は8本すべて未適用。public D1の追加migrationはない。

機械可読の根拠は [監査メタデータ](collector-integration-audit-20261018.json)。価格本文・HTML・R2 object本文・Secret値を含まない。D1から返った11個のSELECT結果はすべて rows_written=0 / changed_db=false。取得先サイトへのアクセス、remote migration、deploy、権利grant変更、鍵設定、NAS変更は行っていない。

## 1. 配信中の状態

| 項目               | 確認した実状態                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Account            | 0f9bb71bb987011462a91596f7cc9e6f                                                           |
| Collector          | ai-investment-collector                                                                    |
| 配信version / 比率 | cbf5a90d-9ab9-40b0-8847-eb0149f20e58 / 100%                                                |
| Deployment         | 359cd6d0-395a-4863-ac85-0a6e6798aa18                                                       |
| 配信開始           | 2026-10-09 12:58:42 UTC（21:58:42 JST）                                                    |
| VersionのGit tag   | 0abf2b647f1e1da23e91473f8c4f26d83e739802                                                   |
| Runtime            | compatibility_date=2026-09-01、cpu_ms=5000                                                 |
| 既存flags          | COLLECTION_ENABLED=true、AGENT_ENABLED=false                                               |
| Cron（UTC）        | 17 18 * * * / 47 18 * * * / */5 18-23 * * *                                                |
| Cron（JST）        | 日次03:17 / watchdog03:47 / 継続処理03:00〜08:55の5分間隔                                  |
| 公開入口           | workers.dev=false、preview=false、Collector Custom Domainなし。対象zoneのWorker routesも空 |
| private D1         | ai-investment-private / f9239883-9929-4137-8079-5a03d9a8beb2                               |
| public D1          | ai-investment-public / cf0f6bf8-142a-4c48-8468-4f9a5b1a42b3                                |
| Origin R2          | EVIDENCE → ai-investment-evidence-private                                                  |
| 新機能の接続       | NAS_EXPORT / NAS_HEALTH / PERSONAL_* は存在しない                                          |
| Observability      | settingsではlogpush=false、observability=null。Logs有効・負荷余裕ありとは判定しない        |

配信中version自身のbindingsも照合した。Secretは存在する名前だけを確認し、値は取得していない。NAS用Secretはない。

Git tag、設定、DB内の現行source policy hashは本番基点commitと整合する。ただし配信bundleのバイト比較はしていないため、ビルド成果物の完全一致まで証明したものではない。統合releaseでは採用commit・tree・artifact hash・新version・検証根拠を結び付ける。

公開APIはversion 83c3fe32-a524-4eae-9333-bc4818d7bb39、deployment f7d640e3-0c72-4953-afab-c3ac11448fa9。本件でAPI/Adminのdeployは不要。Public Workerにprivate D1/R2を追加しない。

### 現行sourceの処理記録

| source           | 有効 | last_success_at（JST） | last_count | 連続失敗 / suspended |
| ---------------- | ---- | ---------------------- | ---------- | -------------------- |
| ecb              | true | 2026-10-18 03:17:52    | 2          | 0 / 0                |
| models_dev       | true | 2026-10-18 03:18:06    | 165        | 0 / 0                |
| price_of_compute | true | 2026-10-18 04:10:51    | 13         | 0 / 0                |

これは既存sourceの成功メタデータであり、価格本文・最新public行・全runの正常性を今回再検証した結果ではない。last_countを市場全体在庫や公開件数に読み替えない。Highreso/Rebroの開始を意味しない。ebay_browse / lambda / openrouter / sakura_dokはdisabledのまま。

ECB / Models.dev / PoCのDB内policy hashは0abf2b6のschema正規化後の設定と一致した。PR #18はECB / Models.devが一致する一方、PoCが古いdisabled設定に戻っている。

### リリース台帳のdrift

private D1の最新Collector台帳はf689aa5e-7e3c-47dc-a21b-34394c3f5158、Git 41ed514f51302f51354007ed61f829b50d057e8f、記録時刻2026-10-05。Cloudflareの現在の配信情報より古い。

これは台帳の遅れであり、Collector停止の証拠ではない。今後のreleaseではscripts/admin-release-record.mjsによる検証可能な追記SQLを準備し、D1書込みの承認後に追加する。過去行を修正せず、証明できないartifact hashを埋めない。

## 2. Git差分と統合上の注意

| 対象                  | 確認したHEAD / 状態                                                      |
| --------------------- | ------------------------------------------------------------------------ |
| GitHub main           | 1d42d981cb93c5185ecba8cf53b108c496d91cf7                                 |
| 本番annotation        | 0abf2b647f1e1da23e91473f8c4f26d83e739802                                 |
| PR #16                | abd676633a0e591e1f65996a8d4860192f992292 / open・Draft・main未merge      |
| PR #18                | 2f32cf99ce690374aac8e6ae1bb5de07763dfabc / open・Draft・#16 branchがbase |
| 本番と#18のmerge-base | 41ed514f51302f51354007ed61f829b50d057e8f                                 |

[PR #16](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/pull/16)は#18に取り込み済みだが、mainへは未merge。AGENTS.mdの「PR #16 ... is merged」をmain反映済みの根拠にしない。

本番→#18の単純置換で失われる主な内容:

- config/sources/price_of_compute.json: enabled・private H100 SXM設定を古いreview/disabled設定に戻す。
- config/deployment.json: collection_workload_mode=models_then_private_poc_v1と共有予算レビュー記録を失う。
- src/collection-continuation.ts: Models保守/継続を優先し、残枠でGPUを進める処理を失う。
- CollectorのGPU保守の実行条件、fetch成功/失敗の安全な表示、Adminのcapture_verified・private publication判定・recovery/schema drift情報を戻す。
- src/admin-recovery.ts、operational-gpu.ts、operations-handoff.tsや関連の復旧・バックアップ・運用検証が欠落する。
- APIのbounded latest/input処理やGPU metricsの防護も古くなる。今回はAPI更新が不要でも統合Gitから落とさない。

本番と#18のWrangler Collector/API設定に差分はなかった。問題は主にbranchの分岐後に入ったコードとsource設定であり、Wranglerだけの比較では検出できない。

作業tree/index/branchを変更しない三方mergeの試算では、AGENTS.mdとsrc/collector-handlers.tsが競合した。.github/workflows/ci.yml、package.json、pnpm-lock.yaml、scripts/run.mjs、runtime-smoke、recovery tests等は自動mergeされたが、正しさの検証は別途必要。

**Collector競合の受入条件**:

1. 本番のresumeCollectionsと条件付きexpireGPUData、Models/PoCの共有予算制御を保持する。
2. private初回保守/日次保守を独立した例外境界に接続する。現在の#18初回hookは既存pipelineのtry末尾にあり、その前の例外で到達しない。日次hookはfinally内。この差を解消/検証することを統合の受入条件とする。
3. 初回のみ有効化して日次flagsはOFF。既存処理と個人研究処理の合計CPU・SQL・R2操作量を検証し、前者を圧迫する場合は既存継続slot内の割当を調整する。CPU上限やCronを勝手に増やさない。
4. personal保守失敗・収集なし・確認済み観測を区別し、last_collector_completed_atをデータ鮮度に使わない。
5. network/policy/schemaの共通変更とparse5依存を精査し、通常sourceの権利gateを緩めない。通常のHighreso/Rebro grantをallowedにしない。

## 3. migrationの適用状況

### 適用済みjournal

private: 0001_initial、0002_gpu、0003_models_catalog、0005_admin_release_ledger、0006_notification_incidents。

public: 0001_initial、0002_gpu、0003_models_catalog。

0004は別系統用の予約番号であり、今回の個人研究に必要な未適用migrationではない。0006はすでに適用済みなので、古い「未適用」という資料より実journalを優先する。

既存のprivate 0001/0002/0003/0005/0006とpublic全migrationは、本番基点と#18で同一ファイルだった。journalにはSQL hashがないため、これはGit間の不変確認であり本番DDLの全バイト比較ではない。

### privateに未適用の8本

| migration                                 | 役割 / 注意                                                        |
| ----------------------------------------- | ------------------------------------------------------------------ |
| 0007_private_research.sql                 | private研究run・page・観測・評価と履歴保護                         |
| 0008_research_retention.sql               | 設定version・保持契約                                              |
| 0009_research_retention_states.sql        | 保持状態拡張。researchテーブルの再作成・データ移送を含む           |
| 0010_private_gpu_research.sql             | private GPU観測                                                    |
| 0011_personal_research_authority.sql      | 通常grantと別の個人研究authority/run                               |
| 0012_personal_continuing.sql              | owner_continuing・レビュー。researchテーブル再作成とDELETE保護復元 |
| 0013_personal_daily.sql                   | 日次契約・run・観測・監視。初回とは別の入口                        |
| 0014_research_assessments_append_only.sql | assessmentのappend-only DELETE防護                                 |

各ファイルSHA-256は監査JSONに固定した。本番にresearch_* / personal_daily_*テーブルは存在せず、journalにも8本の記録はない。export分離そのものには追加migrationはない。

**8本一括のschema承認を推奨するが、日次収集の有効化承認とは分ける。** 初回機能は0007〜0012と0014を使い、0013は日次用。初回だけにschemaを限定する場合は専用release構成を別途レビューし、journalの偽装・既存ファイルの改名で飛ばさない。

0009/0012にはDROP/renameがあり、「CREATE追加だけ」と説明しない。対象はresearch系で、旧FX/AI/PoCテーブルを置換するものではない。現状はresearch未使用なので順序どおり適用すると新設直後のテーブルを再構成する。中途適用・再実行・外部キー・immutable triggerを確認してから進む。

Cloudflareはd1_migrationsで適用済みファイルを管理するため、適用直前に一覧と承認済み8本を再照合する。[D1 migrations公式資料](https://developers.cloudflare.com/d1/reference/migrations/)。publicにはapplyを行わない。

## 4. 保存先の実状態と境界

EVIDENCEはr2.dev無効・Custom Domainなし。確認済みlifecycleは次のとおり:

- 未完了multipart upload: 7日でabort。
- archive/: 365日、archive/price_of_compute/: 7日。
- evidence/ecb/: 365日、evidence/models_dev/: 90日、evidence/price_of_compute/: 7日。

これらに個人研究のcurrent controlや正規化履歴を年齢で削除する規則はない。既存prefixの保持設定を変更しない。bucket一覧は名前フィルターai-investmentを使った範囲であり、account全bucketの不存在証明ではない。

追加する専用export bucket名・health bucket名は未確定。初回ではNAS_EXPORT、日次監視を使う段階では別NAS_HEALTHと別credentialが必要。NASデータcredentialはexport bucketだけのObject Readとし、元EVIDENCEの読取権を与えない。実IAMの拒否試験は未実施。

非公開・個人研究例外とowner_continuing保存は承認済み。30日や10年を履歴削除TTLにしない。提供者許諾はunconfirmedのまま。明示的な保存終了・取消し・現在制御の復元防護を維持する。7日の証拠projection、90日のbackup世代は正規化履歴の保存期間と別である。

## 5. 本番統合から初回実行までの手順案

以下は順序と受入条件の提案であり、今回実施していない。

1. **ローカル統合**: 配信元0abf2b6から隔離統合branchを作り、#16を含む#18の固定HEADを三方mergeする。既存の本番履歴を維持し、上記2ファイルの競合を解消する。mainや別作業を上書きしない。統合commitを新たに固定する。
2. **ローカルsynthetic受入**: check / test / test:runtime / build（dry-run）/ offline preflight / schema再生成と差分検査を実行する。本番と同じenabled 3 sourcesの設定で、private/publicの現在のmigration段階→8本の前進、再実行、取消し/保持/復元、取得flag OFF、片側失敗、Models/PoC継続との共存を試験する。integration済みの成果物で新たに評価し、PR単体の合格を転用しない。
3. **採用範囲の確定**: Collector bundle・lockfile・private migrations・追加設定だけをrelease対象として提示する。API/Admin、public migration、既存source grant、Cron、通知、DNS/Accessは対象外。新しいauthority/transport pinと通常source設定を混同しない。
4. **保存先・鍵・NASの初期設定承認**: 新export bucket名、非公開設定、lifecycle、credential scope、NASの専用UID/ACL/暗号化root/回復鍵/コピー一覧を確定する。承認後にのみresource/鍵/NASを設定する。実データを使わない空staging・専用synthetic objectで拒否範囲と復元を受け入れる。実鍵をGit・チャットへ渡さない。
5. **private migration承認と適用**: DB ID・8本のhash・採用commit・復旧手段を一組で承認する。実行直前の配信version/journalとTime Travelの利用可否・実保持窓・復旧bookmarkを記録する。現在のconfigには30日とあるが、この監査では実保持窓を検証していない。順序どおり適用しjournal・research外の既存処理・FK/triggerを確認する。失敗時は次段階へ進めない。
6. **取得OFFでCollector反映**: 統合候補のdeployを別途承認し、PERSONAL_INITIAL_COLLECTION_ENABLEDと日次の両flagsをOFFのまま反映する。最初は保守もOFFで既存3sourceとAdminReadを確認できる。必要な契約/pin/輸送設定が確定した後だけPERSONAL_MAINTENANCE_ENABLEDをONにし、取得なしで保守を確認する。新version/traffic/設定を確認し、リリース台帳への承認済み追記を行う。
7. **source別の初回実行承認**: method v2の契約、規約/robots fingerprint、対象範囲、24時間の開始/終了、source別1試行、最大3 GET・15秒timeout・内部retryなし、保存先とNAS受入根拠を固定する。Highreso/Rebroを個別に開始できるようにする。既存Cronの稼働窓（JST03〜08時台）を含む時刻にする。取得flagは実行直前の承認後にのみON。日次取得はOFFを維持する。
8. **初回受入**: 各runの実試行・schema/coverage・unknown値・正規化保存・manifest/gate確定・NAS暗号化copy・空staging復元・取消し再適用をメタデータで確認する。snapshot/manifestが未生成の段階を転送成功としない。失敗は0在庫にせず、再試行が必要なら新たな限定実行として扱う。
9. **日次への移行は別承認**: 初回結果とCPU/R2操作量/容量/費用を確認後、daily authority・NAS_HEALTH・署名receipt・独立監視を準備する。日次1回/source、履歴export、5分NAS timer、自動復元検査で通常の日々の手作業を不要にする。Cloud保守は既存Cron窓内なので24時間常時保守とは表現しない。

Highreso旧国内版の新規取得停止は2026-10-31T15:00Z（11月1日00:00 JST）。それ以後の開始/継続には別の新版の適用評価とhashが必要。Rebroの別サイト規約の未特定、サービス契約状態unconfirmedも契約に残す。既に承認された私的利用/継続保存を再び未承認へ戻さず、提供者の返信や公開再配布権をこの非公開例外の必須条件にはしない。規約fingerprintの再確認は取得許可の範囲を明確にして実施する。

## 6. 残る承認と決定事項

| 項目                            | 現在                   | 承認時に固定する内容                                                         |
| ------------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| 非公開の個人研究例外 / 長期保存 | 承認済み               | 再承認不要。通常grantと分離                                                  |
| provider許諾 / 通常rights grant | unconfirmed / 変更なし | allowedへ書き換えない                                                        |
| Cloud resource/IAM              | 未承認                 | 専用export名・非公開/lifecycle・Object Read scope・拒否試験。日次healthは別  |
| 実鍵/NAS                        | 未承認                 | 鍵custody・専用root/UID・コピー一覧・復元先・timer・監視。実鍵を送らない     |
| private migration               | 未承認                 | DB f9239883-9929-4137-8079-5a03d9a8beb2、0007〜0014の8本とhash、適用窓、復旧 |
| Collector deploy/設定           | 未承認                 | 統合commit/artifact、新bindings/pins、最初は取得OFF、既存versionへの戻し方   |
| 初回の実収集                    | 未承認                 | source別method v2契約hash、規約適用とfingerprint、24時間窓、各1試行          |
| 日次実収集 / health / 外部通知  | 未承認                 | 初回受入後に別契約・容量/運用費・監視先。通知は未接続                        |
| 台帳の追記                      | 未承認                 | 検証済みrelease metadataのみ、既存行を変更しない                             |

ローカル統合・synthetic検証は本番変更と分けて進められる。今すぐ所有者に実鍵の提出や日々の手作業を求める必要はない。実行可能なrelease成果物・対象・影響を完成させてから、該当する本番操作だけの承認を求める。

## 7. 停止・rollbackと検証の限界

- 初回取得前の候補不具合では、承認を受けて現在の100% version cbf5a90d-9ab9-40b0-8847-eb0149f20e58へ戻す手段を準備する。worker version切替はD1/R2の状態を戻さない。[Workers rollback公式資料](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)。
- 新規データ取得後は、旧versionに戻すだけではpersonal保守/exportも止まる。まず取得flagsだけを停止し、正常な統合versionの保守・長期保存・取消し伝播を維持する。旧versionへ戻す必要がある場合は代替保守と保存状態を個別に確認する。
- migrationを戻すためにDB全体をTime Travel restoreすると、既存FX/Models/PoCの新しい履歴まで戻り得る。自動down migrationや一括restoreをrollbackの既定にしない。適用済みschemaは原則維持し、前進修正を検討する。
- NAS_EXPORT/current control・履歴・権利評価をrollback時に削除しない。実鍵やNASの切替も自動的に巻き戻るとは仮定しない。

既存PR #18のsynthetic検証は、ローカルWindows 414 passed、最終HEADのGitHub CI 413 passed / Windows専用1 skipped。[検証記録](nas-export-validation-20261018.md)および[PR CI](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/actions/runs/39116676926)参照。これは本番基点と統合した新候補の検証ではない。

今回実施したのは本番metadata/SELECT、Git差分・三方mergeの試算、設定hashとmigrationファイル比較、監査文書/JSONの整合確認まで。統合の実装と新たな全件testは未実施。本番bundleの完全一致、source価格pipeline、実IAM、実NAS、長期容量、CPU/コスト、Time Travel復元は未検証。Highreso/Rebroの実収集・本番稼働を開始したとは報告しない。
