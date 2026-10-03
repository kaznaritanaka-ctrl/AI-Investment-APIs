# Models.dev拡張の有効化・停止手順

これはP0の本番反映手順です。2026-10-01 JSTに、先行watchdogの本番確認、scope・権利・保持の承認、隔離ローカルlive測定を反映しました。P0のremote migration、deploy、本番拡張収集は未実施です。毎日の人手作業を追加する手順ではありません。

## 維持する設定

本番はWorkers Paid確認済みで、Collectorの明示CPU上限は5,000msです。先行リリースのcommitは `5c95d8e274f349228843ee3178b402141acaaab5`、versionは `620b932f-12d6-414c-aa68-32ac487dae64`。2026-10-01 03:17 JSTのECB／Models.devは各complete・観測2・受入2、03:47のwatchdogは同じ成功runを認識しました。これは既存scopeの実績で、P0拡張の本番容量検証ではありません。

2026-10-01の本番用候補では、確認済みPaidの根拠、`d1_time_travel_days=30`、Collectorの `limits.cpu_ms=5000` を同期しました。scope・権利・保持の[所有者承認](p0-owner-review.md)と、現154モデルでの[容量・runtime審査](p0-runtime-review.md)を記録しています。PaidのTime Travelは30日という[公式仕様](https://developers.cloudflare.com/d1/platform/limits/)を保持審査に含め、source側のbackup許可をPaid承認から推測しません。

stage=enabled、COLLECTION_ENABLED=true、AGENT_ENABLED=false、既存3 Cron、Collectorのrouteなし・workers.dev/preview無効を維持します。APIのcustom domainは `api.ai-investment-research.net`、DB bindingはPUBLIC_DBだけです。値やIDは既存ファイルを使用し、bootstrapのCron空配列・gate falseを再適用しません。API／Adminに同じCPU上限を機械的に追加しません。

ローカル本番候補の `config/sources/models_dev.json` は、承認済み5 provider・17 fieldの新policy v3へ切り替えました。旧v2設定は `config/history/models_dev.v2.json` に保存し、legacy回帰試験で使用します。本番はCollectorを別途承認してdeployするまで既存2モデル経路です。ECB・disabled GPU・Admin/Access・Secretsを変更しません。mainへのmergeも別承認です。

## 一度だけ必要な判断

1. [policy案](../config/proposals/models_dev.v3.json)のprovider部分集合、field部分集合、各権利gate、保持期間をレビューします。直接providerの取得許可とは別です。公開未許可ならprivate-onlyを選べます。raw配信・外部LLM許可は不要です。
2. `owner_approval_ref`、`runtime_review_ref`、`retention.reviewed_ref`、policyの判断主体・根拠・有効期間を実際の記録で確定します。モデル別の日次追加承認は不要です。既存v2の同名上書きはしません。
3. Workers Paidは承認・確認済みです。[費用と実測](models-validation.md)と[追加のCPU比較](collector-performance.md)の開発時点のFree記載を、現在のプラン判定へ転用しません。[新しいruntime審査](p0-runtime-review.md)では500モデル・64 components・3日分と大きな入力をローカル検証しました。現154モデルの3年容量試算と、500×64では3年保持不可という上限を分けています。クラウドCPU／memory・長期DB実行性能は未実測で、初回本番観測後に再評価します。
4. raw90/archive365/normalized1095/backup30日という提案を確認します。許諾上限があればcleanupの余裕とbackupまで含めて短くします。R2のevidence/models_dev/とarchive/models_dev/の非公開lifecycleを確認します。既存のarchive/365日ルールは同等に使えます。保持年数・最大componentがD1 10GB/DBに収まるか審査します。
5. 通知先・外部read-only health監視は既存未設定事項です。通知用Secretは`ALERT_WEBHOOK_URL`（既存コードの設定名）を使用し、値をGitやチャットへ貼りません。Models.dev自体のAPIキーは不要です。

## ローカル準備

以下は本番操作ではありません。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:runtime
pnpm models:benchmark
pnpm models:cost
pnpm build
pnpm preflight
pnpm models:status
pnpm preflight --proposal config/proposals/models_dev.v3.json
node scripts/generate.mjs
git diff --check
```

最後のproposal preflightは現在の未承認案ではexit 2が正しい結果です。実source設定に書き戻さず、想定有効化時の権利・plan・承認不足を報告します。通常preflightがpassしてもクラウド実在・現在稼働の証明にはなりません。PowerShellでpnpmの非対話再確認や長い一時パスが問題になる場合は、ローカル検証時だけ `$env:CI='true'` と `$env:AI_APIS_TEMP_DIR=Join-Path ([System.IO.Path]::GetTempPath()) 'ai-model-tests'` を設定します。

## DB・Worker適用（別途承認後だけ実行）

既存account/zone/domain/2 D1/R2を照合し、Time Travelの復元点と退避/復元権限を確認します。`pnpm preflight:cloudflare` は明示read-only接続です。必要な認証名は`CLOUDFLARE_API_TOKEN`、任意の`CLOUDFLARE_ACCOUNT_ID`は設定済みaccountと一致させます。Freeをsubscriptionの不在だけで推定しません。適用前は0003未適用のblockerが出ることを承知した上で、対象を誤っていないか確認します。

以下の重大ステップはそれぞれ直前に対象・実行内容・失敗時の復旧方法を提示し、所有者の承認を得ます。一方の承認を後続のmigration／deployの包括承認にはしません。コマンドは実在するbindingとconfigを使用し、新リソースを作りません。

まずread-onlyでmigration履歴を確認し、復元可能期間・bookmarkと現在のreleaseを記録します。

```sh
pnpm exec wrangler d1 migrations list PRIVATE_DB --remote --config wrangler.collector.jsonc
pnpm exec wrangler d1 migrations list PUBLIC_DB --remote --config wrangler.collector.jsonc
```

**1. private D1の0003を直前承認後に適用**します。

```sh
pnpm exec wrangler d1 migrations apply PRIVATE_DB --remote --config wrangler.collector.jsonc
```

private 0003はdataset CHECKを拡張するため、observationsの複写と表の置換を含みます。空DBの新設だけではありません。既存観測のID・件数・時刻・保存済fingerprint、foreign key、immutable triggerを適用前後で照合し、0003の記録を確認します。privateの検証が通るまでpublicへ進みません。本文を含む全テーブルexport／SELECT *はこの確認に含めません。

**2. public D1の0003を別の直前承認後に適用**します。

```sh
pnpm exec wrangler d1 migrations apply PUBLIC_DB --remote --config wrangler.collector.jsonc
```

既存公開観測・完了batch、追加column／table／indexと0003の記録を確認します。0001/0002適用済み環境では0003だけが追加されます。片側で失敗したらWorker適用へ進まず、migration履歴と原因を確認します。既存Workerを維持し、前進修正を検討します。DROPによるリセット・既存観測削除・schema巻戻しを復旧手段にしません。

両DBの検証後、ローカルdry-runを確認します。

```sh
pnpm build
```

**3. backward-compatible APIを直前承認後に先行deploy**します。

```sh
pnpm exec wrangler deploy --config wrangler.api.jsonc
```

version／commit、PUBLIC_DBだけのDB binding、health、公開schema、既存価格endpointの互換性を確認します。失敗時は直前の互換API版へ戻す案を提示し、Collectorへ進みません。

**4. Collectorを別の直前承認後にdeploy**します。

```sh
pnpm exec wrangler deploy --config wrangler.collector.jsonc
pnpm preflight:cloudflare
```

version／commit、CPU 5,000ms、bindings、Cron3本、scope、AGENT_ENABLED=false、外部非公開を確認します。その後の自然なcollection／continuation／watchdogでlive確認します。手動市場取得を増やしません。失敗時は当該schema・scopeと互換な直前版へ戻す案を提示し、DBの追加履歴を保持します。

拡張sourceの権利が未承認なら、そのprovider／fieldはfail closedのまま既存ECB／Mistral収集を維持します。上のdeployコマンドはdry-runではありません。この手順更新では実行していません。

## 拡張scopeの切替

承認済みの提案だけを新policy版として`config/sources/models_dev.json`へ反映するレビューを別途作成します。enabledをtrue、selectionを空、models.providers/fieldsを承認範囲へ設定します。scopeの権利gate、保持日数、review参照、上限、適用日を確定し、必要なgateだけallowedへ変更します。全権利を一括allowedにするコマンドは用意していません。

owner/runtime/retention参照を埋めるだけで実測が完了したことにしてはいけません。50/250/1000 synthetic結果に加え、承認された最小scopeで明示opt-inのlive検証と実行予算の確認が必要です。承認済みsource設定を使い `pnpm models:live --allow-network` を実行すると、隔離development環境の `work/live-models-state` で取得・履歴・公開投影を検証します。既定ではネットワークopt-inを要求し、現行2モデル設定や未承認案では取得前に停止します。出力は件数・理由・計測だけで、実レスポンスはGitignore対象のprivate stateに保存します。これも本番CPU検証ではありません。既存`smoke:live`へ拡張案を混入せず、本番観測は承認済みコード/設定と日次Cronから開始します。

最大500モデル案は既存72 continuation枠内の計画です。1000件・GPU同時運転・大量component・長期DBで予算を超える場合はpreflight/容量審査で止め、範囲・処理方法の見直しを先に行います。Cron増設、別サービス導入、値の切捨て、日次手作業で補いません。

source設定変更のdeploy承認後はcollectorのみ再適用します。Wranglerが唯一のCron管理元で、別のGit連携deployを有効にしません。次の日次runとcontinuationが自動処理します。`AGENT_ENABLED=false`のままです。

## 確認・停止・復旧

`pnpm models:status` はoffline設定、`pnpm models:status --local` はローカルD1の読取、`pnpm models:status --remote --allow-network` は本番D1の固定SELECTです。最新予定run、complete/partial/failed、最終進捗・checkpoint、catalog/price/component/隔離件数、理由、観測時刻、expiry、data_originを表示します。DBが0003未適用ならmissing reasonを返し、自動migrationしません。

statusの`--local`はWranglerのlocal stateを対象とします。isolated live検証の`work/live-models-state`とは別です。live検証の結果は`work/models-live-report.json`で確認し、合成fixture・Wrangler local・live stateを混ぜません。

公開許可後は `/v1/models/coverage` で完全snapshot ID・live件数を確認し、そのIDのobservationsをページングします。public確認だけではprivate-only sourceを失敗と判定しません。DB記録があってもCronが今設置されている証拠にはならないため、cloud preflightと併せて確認します。最初のlive完全snapshotを確認するまでは「拡張収集中」と報告しません。

障害はlease失効後に保存証拠から自動再開します。HTTP失敗/partialは0件や提供終了に変換しません。schema修正・新provider/field・権利更新・繰返し大幅価格変化だけが例外レビューです。

緊急停止は既存`revokeSource`の順序（public policyをrevoked→private suspended）を使います。管理HTTPは追加していません。本番SQL操作は対象確認と例外承認が必要です。その後models_devをdisabledにした新設定でcollectorを適用しても、ECB・他sourceのCronを止めません。DB・R2・migrationは巻き戻さず保持義務を守ります。公開を隠す操作と証拠を物理削除する義務は別で、正式な削除時には当該sourceのraw/archive/派生・公開コピー/backupも対象にします。

再開は新policy版と停止理由のレビュー後に行い、privateのsuspended解除も承認対象です。旧v2ファイルへの単純巻戻しやpublic revokedの自動解除をしません。訂正は保存証拠の期限内でreview_ref・別parser版により追記し、元観測時刻を維持します。復元時は公開を止めたまま現行policy/retentionを再適用してから検証します。
