# Models.dev拡張の有効化・停止手順

これは承認後に実施する手順です。このP0開発では本番deploy、remote migration、rights grant変更、plan契約、live収集を実行していません。毎日の人手作業を追加する手順ではありません。

## 維持する設定

`config/deployment.json` はstage=enabled、現プランはfree（Dashboard確認根拠あり）、Time Travelは7日です。collectorはCOLLECTION_ENABLED=true、AGENT_ENABLED=false、既存3 Cron、routeなし・workers.dev/preview無効。APIのcustom domainは `api.ai-investment-research.net`、bindingはPUBLIC_DBのみです。値やIDは既存ファイルを使用し、bootstrapのCron空配列・gate falseを再適用しません。

P0のコードを適用しても、`config/sources/models_dev.json` を承認して切り替えるまでは既存2モデル経路です。ECB・disabled GPU・Admin/Access・Secretsを変更しません。mainへのmergeも別承認です。

## 一度だけ必要な判断

1. [policy案](../config/proposals/models_dev.v3.json)のprovider部分集合、field部分集合、各権利gate、保持期間をレビューします。直接providerの取得許可とは別です。公開未許可ならprivate-onlyを選べます。raw配信・外部LLM許可は不要です。
2. `owner_approval_ref`、`runtime_review_ref`、`retention.reviewed_ref`、policyの判断主体・根拠・有効期間を実際の記録で確定します。モデル別の日次追加承認は不要です。既存v2の同名上書きはしません。
3. 現行Freeは拡張のD1 query/解析予算に適合しません。[費用と実測](models-validation.md)を確認し、必要ならWorkers Paidを別承認で契約・確認します。Website用Proプランと混同しません。Paid確認後だけdeploymentのplan根拠とTime Travel（30日）を更新します。この開発は契約を実行しません。
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

**remote DB変更の承認後**、両方を前進migrationします。コマンドは実在するbindingとconfigを使用し、新リソースを作りません。

```sh
pnpm exec wrangler d1 migrations list PRIVATE_DB --remote --config wrangler.collector.jsonc
pnpm exec wrangler d1 migrations list PUBLIC_DB --remote --config wrangler.collector.jsonc
pnpm exec wrangler d1 migrations apply PRIVATE_DB --remote --config wrangler.collector.jsonc
pnpm exec wrangler d1 migrations apply PUBLIC_DB --remote --config wrangler.collector.jsonc
```

0001/0002適用済み環境では0003だけが追加されます。既存Workerが動く環境を想定した前進変更です。履歴・FKを保持し、DROPによるリセット・schema巻戻しをしません。片側で失敗したらWorker適用へ進まず、migration履歴と原因を確認します。

**コードdeploy承認後**、承認済みstage/Cron/routesを保ったまま各Workerを1回ずつ適用します。

```sh
pnpm build
pnpm exec wrangler deploy --config wrangler.collector.jsonc
pnpm exec wrangler deploy --config wrangler.api.jsonc
pnpm preflight:cloudflare
```

最初は既存sourceのままコード・migrationだけ適用できます。拡張sourceの公開権限が未承認でも既存運転を止めません。上のdeployコマンドはdry-runではありません。この納品では実行していません。

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
