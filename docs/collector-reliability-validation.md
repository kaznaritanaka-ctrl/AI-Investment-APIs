# Collector継続運用修正 — 検証結果（2026-09-30 JST）

**実装済み・ローカル検証済み。本番反映待ち。** 開始HEAD `481eca7` のP0を保持し、`codex/collector-reliability` に分離しました。今回、本番deploy、remote migration、課金・権利・Secret・Cron・公開先の変更、通知送信、push／mergeは行っていません。

## 1. 修正とファイル

| コミット | 主なファイル | 内容 |
|---|---|---|
| `ae0967e` | src/run-identity.ts、collector.ts、pipeline.ts、gpu-pipeline.ts、operations.ts、tests/run-identity.test.ts | 論理slot、旧秒付きrun互換、保存証拠限定復旧 |
| `c3a3237` | src/models-pipeline.ts、tests/models-run-identity.test.ts | P0の旧run／checkpoint互換 |
| `d3df069` | src/util.ts、adapters.ts、models.ts、scripts/collector-*、tests/evidence-allocation.test.ts、tests/collector-benchmark-runtime.ts | UTF-8変換再利用、合成性能比較 |
| `4c13889` | src/telemetry.ts、collector.ts、operations.ts、各pipeline、tests/telemetry.test.ts | 安全なログ、完了種別・公開件数、idle通知抑制 |

README、AGENTS、operations、P0有効化手順、性能資料と[リリース計画](collector-reliability-release.md)を更新しています。package scriptsに合成benchmarkを追加。新規migrationは不要で、既存0001/0002/0003、config、Wrangler両設定、lockfileは開始HEADと差分なしです。source v2、stage=enabled、3 Cron、COLLECTION_ENABLED=true、AGENT_ENABLED=false、API公開先、private/public境界を維持しています。

## 2. watchdogと互換性

Collectorの18:17:35とwatchdogの18:17:00を別hashにしていた原因を、expected complete / received missingの回帰失敗として再現しました。UTCの予定slotから同source・同minuteの旧runを認識し、成功runを既存の誤missingより優先します。実時刻と論理slotを分離し、旧ID／証拠／checkpoint／immutable観測を保持します。

日付をまたぐ遅延、重複・並行実行、旧成功と誤missingの共存、true missing、別source／slot／namespace、leaseと保存済み復旧を検証しました。P0 checkpointも旧IDのまま翌日に完了でき、再HTTPしません。本番の旧missing行は変更していません。

本番基準の別worktree `AI-Investment-APIs-watchdog-validation`／branch `codex/watchdog-only`／commit `2a12725` は**0003なしで先行リリース可能**です。フルP0ブランチは0003依存があるため、混同してdeployしないでください。

## 3. テスト結果

| 検証 | 最終結果 | 範囲 |
|---|---|---|
| pnpm check | PASS | Prettier、TypeScript、設定・公開境界 |
| pnpm test --fileParallelism --maxWorkers=2 --reporter=json --outputFile=work/reliability-test-results.json | **119 PASS / 0 FAIL / 0 SKIP / 0 TODO、13 files** | 既存suite全件＋追加回帰。test設定ファイルは未変更 |
| pnpm test:runtime | PASS | workerd内FX/AI 2 synthetic source、blocked source 1、D1/R2/API |
| 同runtimeのGPU | PASS | 1,051 synthetic listing、22 page、23 invocation、batch最大20、replay／公開pagination |
| 同runtimeのP0 | PASS | 50／250／1,000 synthetic model、5／13／43 invocation、履歴・checkpoint・replay |
| pnpm build | PASS | collector／APIのWrangler **deploy --dry-run**のみ |
| pnpm preflight | PASS、exit 0 | 現行設定offline。クラウド実在・本番CPUの証明ではない |
| pnpm preflight --proposal config/proposals/models_dev.v3.json | **想定停止、exit 2** | 未承認rights3種、Paid予算、owner/runtime/retention review不足。PASS扱いしない |
| node scripts/generate.mjs、git diff --check | PASS | schema/OpenAPIの再生成差分なし |
| watchdog独立版 | PASS | check、0001/0002で回帰9件、既存runtime、両Worker dry-run、offline preflight |
| 性能before/after | PASS（合成のみ） | 各A/B/C 5 Node試行＋1 workerd snapshot、出力digest同一 |
| 本番live smoke／手動収集／deploy／remote migration／実通知 | **未実行** | 今回の許可範囲外 |
| Cloudflare MCP | **未検証・未接続** | Wrangler metadata照会成功と区別 |
| GitHub CI | **未実行** | ローカル結果。pushしていない |

ローカルtest結果の詳細は`work/reliability-test-results.json`（ignored、全件passed）です。追加内訳はslot9、P0互換1、encoding/精度2、ログ・通知5。既存suiteにはデータ入りDBへの前進migration、FK、immutable trigger、rights停止、partial、価格大幅変動、listing消失、再実行、公開境界等が含まれます。fixture成功をlive成功とは数えません。

開発中に確認した失敗は隠していません。最初のwatchdog回帰は修正前にmissingで失敗。P0 testのcheckpoint期待値をingest後のabsence stageに合わせて修正。telemetryの未計測公開件数をundefinedプロパティとして返すとsummary JSONが壊れる問題は、項目省略と回帰追加で修正しました。途中の全件実行は117 pass／2 failで、**最終状態の再実行で119 pass**です。pnpmの非対話virtual-store条件、長いWindows一時パス、esbuildのsandbox親ディレクトリ読取制限による初期停止は環境問題として分離し、必要なローカル実行条件で再検証しました。検証をskipしてpassにはしていません。

再現時のWindowsローカル環境補助:

```powershell
$env:pnpm_config_enable_global_virtual_store='false'
$env:AI_APIS_TEMP_DIR=Join-Path ([System.IO.Path]::GetTempPath()) 'ai-apis-reliability'
```

## 4. CPU結果

**本番監査の過去観測**はdaily CPU 363.684 ms、wall 4.919485 s、memory約56.15 MiB、status successです。1回の成功はFree超過が今後も許される根拠ではありません。変更後の本番CPUは未計測です。

**合成ローカル比較**のevidence処理elapsed中央値:

| ケース | 入力サイズ | 選定／出力観測 | 改善前→後（ms） | Node CPU代理中央値（ms） |
|---|---:|---:|---:|---:|
| A 現行選定方式 | 8,666,543 bytes | 2／2 | 422.36 → 372.29 | 547 → 453 |
| B P0想定 | 8,527,543 bytes | 250／500 | 47.68 → 37.98 | 47 → 47 |
| C P0モデル数上限 | 8,666,543 bytes | 500／1,000 | 65.03 → 56.61 | 94 → 93 |

Aはカタログ全体のlossless JSON解析が主負荷。B/Cは選定後のschema/decimal、保存証拠の再検証、hash、DB処理も影響します。単純なモデル数比例は使っていません。独立probeは重複を含むため足しません。Node CPUはCloudflare CPUではなく、0のproxy値もゼロCPUを意味しません。DB/HTTP待ちを含むworkerd elapsedをCPUとは呼びません。B/Cの全pipeline elapsedは改善後に増え、全処理が高速化したとは主張しません。

DBはA37／B4,212／C8,372 SQL（全snapshot）、B/C最大416 SQL・**263 D1呼出し/invocation**。batch最大6、source fetchは各1回。cold module CPU／workerd isolate memory／変更後本番CPUは未測定です。保持・長期履歴・64 components/modelの最悪容量も未検証です。[全測定、メモリーと範囲](collector-performance.md)、[機械可読結果](collector-performance-results.json)を参照。

## 5. FreeとPaid

小さな改善だけではFree適合を示せません。Free CPU 10 ms、D1 50 queries/invocationに対し、既存の本番CPUとP0合成処理の負荷が大きい状況です。既存運転は止めず、P0本番有効化は保留します。

Paid案はUSD 5/account/month、月10 million requests／30 million CPU ms込み。既存74 Cron invocation/dayは30日で2,220回。各回1,000 msとする**仮の予算枠**では月2.22 million CPU ms、5,000 ms枠では11.1 millionです。これは測定に基づく本番予測ではありません。API/Admin・D1/R2・Logs・税は別途考慮し、Paidでもmemoryは128 MBのままです。契約とcollector `limits.cpu_ms=5000`案は別承認・実計測が必要です。[公式URLと確認日、超過単価・D1/R2見積り](collector-performance.md)に記載しました。

## 6. ログ・通知

安全なログとsummary/outboxの再利用は実装済み。collector実行と新観測完了を分け、価格不変の再観測を正常と判定します。休日・source_dateの据置とpolicy停止を混同しません。監視の休日カレンダー評価は自動実装済みと主張しません。

pending5件はread-only metadataで、**誤missing1件／収集成功1件／idle continuation3件**と分類しました。rows_written=0、全件未送信のままです。本番Logs、sample率、保持、通知先、Webhook Secret、外部監視は未設定／承認待ち。Secret値・source本文・private R2本文は取得していません。通知先設定だけで過去pendingが送られ得るため、個別の扱いを先に承認する必要があります。

## 7. 未解決

本番WorkerとGit SHAの完全一致、変更後本番CPU・memory・日次安定性、長期容量／復元訓練、最大component workload、P0 live検証と権利・保持レビューが残ります。Admin domain drift、Access／MFA／IAM、MCP認証、GPU等のsource有効化は別作業です。既存ECB／Models.dev初回収集は過去監査で本番確認済みですが、この修正やP0拡張の本番稼働は未確認です。

## 8. 所有者の承認・操作

1. watchdog単独deployを先行するか、P0全体とまとめるかを決定。
2. Paid契約とCPU設定案、アカウント全体の費用・D1/R2/Logs予算を承認。
3. 全体適用なら0003両DB remote migrationとWorker deployを別承認。P0 scope・権利・保持・live確認も独立承認。
4. Logs有効化、通知先、pending5件の個別処理、Secret登録、試験通知、外部監視を承認。

日次の手書き・転記・CSV作業は要求しません。事前照合→（全体版なら）両DB前進migration→互換API→Collector→自然な日次実行・source観測・公式metrics確認、という順です。watchdog単独版はCollectorのみでmigration／API deploy不要。具体的コマンドと失敗時の分岐は[リリース計画](collector-reliability-release.md)にあります。code rollbackでDBをDROP／巻戻しせず、既存観測と現行rightsを保持して復旧します。
