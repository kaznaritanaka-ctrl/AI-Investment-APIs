# 本番Collector基点へのPR #18統合・ローカル検証

2026-10-18。対象branch: codex/collector-personal-integration-20261018。元のPR #18 checkoutを変更せず、別worktreeに統合した。これは本番反映ではない。

- 第一親: 0abf2b647f1e1da23e91473f8c4f26d83e739802（直前の本番metadata監査で確認したversionのGit tag）。
- 統合元: PR #18 / 2f32cf99ce690374aac8e6ae1bb5de07763dfabc。PR #16 / abd6766を含む。
- [本番監査と承認手順](collector-production-integration-20261018.md) / [時点を固定した監査JSON](collector-integration-audit-20261018.json)。
- main、元のPR branch、本番Collector/API/Admin、DB/R2、NASは更新していない。本番metadataを今回再照会したものではない。

## 競合解消と保持した本番機能

競合したAGENTS.mdは本番側の0006適用済み記録とPoC承認範囲を保持し、個人研究の最新承認/停止境界を取り込んだ。PR #16の「merged」は#18へ取り込み済みという意味に訂正し、mainへmerge済みとは記載しない。

collector-handlers.tsは本番のresumeCollections、Models優先、条件付きGPU保持処理を維持した。個人研究初回hookを既存pipelineのtry末尾から独立したfinally側へ移した。初回/日次のどちらも有効化していない。

以下は本番基点と差分なし:

- config/sources全体、config/deployment.json、wrangler.collector.jsonc、wrangler.api.jsonc。
- ECB、Models.dev v3、PoC private H100-SXMの3 sourceがenabled。その他のsource/grantは追加承認しない。
- collection_workload_mode=models_then_private_poc_v1と共有予算レビュー、COLLECTION_ENABLED=true / AGENT_ENABLED=false、既存3 Cron。
- src/collection-continuation.ts、既存API・Admin read/recovery・telemetry・PoC pipeline/retention、復旧/バックアップ実装。
- 適用済みprivate 0001/0002/0003/0005/0006とpublic全migration。新規0007〜0014も#18からバイト変更なし。
- CollectorのHTTP制御口は404、workers.dev / previewはfalse、Public WorkerはPUBLIC_DBのみ。

共通コードの変更はcollector-handlers / network / policy / CollectorEnv型と追加researchモジュール。networkは本番のPoC予約/cooldown/失敗記録を保持し、既存の最大3試行を変えず、研究専用の1試行/HTMLを追加。通常canCollectは同じ権利・GPU/Models scope検査を通る。parse5とentities以外の依存版を変更していない。

自動mergeされたCI、package/lock、run.mjs、runtime-smoke、recovery testも確認した。既存resilience・backup testとshared Models/PoC runtimeを残し、個人研究runtimeを追加している。CIの自動deployはない。

## 継続処理の予算分離

単にfinallyへ2つの保守を追加すると、既存Models/GPU処理と同じinvocationに積み重なる。そのため、既存resumeCollectionsが「Models保守/継続なし、GPU結果なし」と確認したcontinuationにだけprivate保守を割り当てる。

| 既存5分CronのUTC分 | 空き枠の用途                                           |
| ------------------ | ------------------------------------------------------ |
| 00 / 15 / 30 / 45  | 既存GPU保持処理                                        |
| 05 / 20 / 35 / 50  | 初回private保守が有効なら初回。無効なら既存GPU保持処理 |
| 10 / 25 / 40 / 55  | 日次private保守が有効なら日次。無効なら既存GPU保持処理 |

Models/GPUの仕事がある場合はそれが優先される。初回と日次を同じinvocationへ追加せず、GPU保持にも最低1/3の空き枠を残す。daily intake / watchdogにはprivate保守を重ねない。新しいCronは作らない。

空き枠を確認した後のsummary/health等の失敗でも、選択済みprivate保守はfinallyから実行する。resume自体が失敗すると残予算が不明なので次のslotへ延期する。private保守失敗は他のmode/既存処理を巻き込まず、ログには固定event/stateだけを残す。既存last_collector_completed_atは従来の処理記録で、private成功やデータ更新を表すものではない。

両保守flagsが未設定の現在は、全idle slotで本番と同じGPU保持処理となる。新しい取得承認、契約pin、NAS_EXPORTがないため、個人研究の収集を始める構成ではない。

保守を将来有効化しても「5分ごとに必ず個人研究が進む」とは保証しない。既存workload/backlogによって延期され、Cloudの実稼働窓はUTC18〜23時台。NASの5分poll案は別であり変更していない。実CPU・SQL/R2操作量・容量・費用・stale/停止時の受入は本番承認前後に別途必要。

## 新たに追加した検証

tests/collector-personal-integration.test.ts:

- 本番のenabled 3 sourceとPoCのprivate権利/単一partitionを維持。
- 個人研究OFFなら旧slot動作が変わらない。
- Models保守/継続・GPU処理・GPU保持とprivate初回/日次の予算を重ねない。
- 選択後の報告失敗でも保守を続行し、resume失敗は未確認予算を使わず延期。
- private失敗が既存health記録や次のmodeを妨げず、任意エラー本文をログへ出さない。
- 日次/未知Cron/collection OFF/HTTP入口の境界を維持。

tests/production-research-migration.test.ts:

- 本番と同じ0006までのschemaに、実設定のenabled 3 sourceを使い、HTTPだけsynthetic responderへ置換してFX・Models・private PoCを保存。
- 既存private/public全ユーザーテーブルを比較し、0007〜0014の適用・再実行で内容が変わらないことを確認。
- public journalは不変、PoCはprivateだけ、FK違反なし、immutable observation保護を維持、新research/dailyテーブルは空。
- migration hash照合と、既存の0014→0012順でもassessment DELETE防護が戻るテストを維持。

## 検証結果

| 検証                                             | 結果                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| pnpm check                                       | 成功。format / TypeScript / 公開境界検査。                                             |
| pnpm test（下記のローカル実行オプション付き）    | 全53ファイル・461件成功、skip 0。続いてNode resilience 6件成功、skip 0。583.58秒。     |
| pnpm test:backup                                 | 21件成功、skip 0。synthetic age暗号化、capture、保守、復元。                           |
| pnpm test:runtime                                | 全runtime harness成功。ネットワークはsynthetic responderだけ。                         |
| pnpm build                                       | Collector / APIのWrangler dry-run成功。upload / deployなし。                           |
| pnpm preflight                                   | offline ready=true、errors/blockers空、network=false。個人研究実行の承認を意味しない。 |
| node scripts/generate.mjs                        | source/research schema・OpenAPIの生成差分なし。                                        |
| 保持対象diff / migration hash / git diff --check | 成功。既存本番設定は不変、新規8 migrationは監査済みPR #18と一致。                      |

全件テストの最終実行コマンド:

```powershell
pnpm test --pool=threads --maxWorkers=1 --fileParallelism=false --testTimeout=120000 --hookTimeout=120000 --reporter=default --reporter=json --outputFile=work/integration-sequential.json
```

Windowsで子processを増やさないようthreads poolを指定し、既存vitest設定と同じファイル直列実行にした。120秒はテスト/hookの上限であり、期待値・対象・assertionは変えていない。全件を再実行して成功した結果で、失敗ケースだけの再試行を全件成功として数えていない。JSON報告はignored work配下に保持する。

最初の2-worker並列実行は447成功/14失敗だった。Miniflareとworkerd間のlocalhost接続で `EADDRINUSE` が発生し、後続のcleanup失敗もあった。失敗時は別のruntime検証も並行していた。OSのポート枯渇自体を計測できたわけではないため断定しない。並列実行を止め、他のMiniflare検証と重ねず全件直列で再実行したところ、同じ14ケースを含む全件が成功した。OSネットワーク設定やテスト期待値の変更は行っていない。

runtimeの主なsynthetic受入結果:

- 既存FX / AI価格 / operations / Admin recoveryが成功。
- Models 500件 + private PoC 50件をModels優先で処理。Models継続22回、PoC 2 invocation、最大SQL 528。PoCの公開件数は0。
- GPU 1,051 listing / 22 page / 23 invocation。最大batch 20 / SQL 237。
- Models 50 / 250 / 1,000件を5 / 13 / 43 invocationで処理。最大SQL 525 / batch 6。
- Highreso/RebroのHTML fixtureは2 source・6 mock GET・6 observation。初回Cloud/NAS exportと継続保存の11年経過・復元を検証。
- 日次は40日・40 run・80 observation・120 mock GETを80 bounded invocationで処理し、11年経過の履歴を保持。
- 本番相当0006から0007〜0014への移行・再実行で、既存ECB / Models.dev / private PoCのデータ、public journal、immutable保護が不変。

これらはlocal synthetic結果である。外部データソースへの実HTTP、Cloudflare本番CPU、実IAM、実NAS、実鍵による受入を検証したものではない。

dry-run artifact（ignored dist配下）:

- Collector: 1,873,782 bytes、SHA-256 `976f03bb900cda588c484f4ba19cb55bf1dc1f7751f3a7dc70ed001d7f300029`。
- API: 923,707 bytes、SHA-256 `1e6f5758534ed8a0cd0d42fc587ae88d65757b7d6c00cf75cfd70932448a059b`。既存API境界の検証用で、今回の本番deploy対象を承認するものではない。

## 実行環境と制限

Windows / Node 24.19.0 / pnpm 11.19.0。元checkoutのnode_modulesを共有せず、このworktreeへlockfile固定で導入した。pnpmのWindows symbolic link作成がEPERMとなるため、ローカルinstallだけnode-linker=hoistedを使用した。offline cacheにない本番lockのundici 7.29.1等はnpm registryから取得した。依存のupgrade、global設定、Gitの本番設定変更は行っていない。

pnpmの実行前自動installとGit safe.directoryはprocess限定で設定する。テスト用age 1.3.2は既存の検証用ツールをこのworktreeのignored work/toolsへコピー。synthetic鍵・DB・バックアップ・報告書はignored work配下だけ。実鍵やNAS credentialは使用していない。

backup-maintenanceのhardlink拒否試験はsandboxのリンク作成制約で最初にEPERMとなった。同じ21件をローカル作業領域に限定してsandbox外で再実行し、全件成功。テストをskipしたり、拒否条件を削除していない。

Docker/Podmanはローカルで利用できず、CIにあるNASコンテナの非root/read-only filesystem受入はここでは実行していない。ホスト上のbackup/age/restore試験とは区別する。CI定義は保持している。

今回の統合を本番へ反映する承認はない。remote migration、deploy、実収集、権利grant変更、実鍵設定、NAS実機変更は未実施。初回契約の実行窓、実IAM/NAS、CPU/コスト、リリース台帳更新と本番反映は [承認一覧](collector-production-integration-20261018.md) に従う。
