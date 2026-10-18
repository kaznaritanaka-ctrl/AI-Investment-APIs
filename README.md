# AI-Investment-APIs

2026-10-18 PR #19レビュー: [既存3sourceへの影響・初回Cloud実行の残件](docs/pr19-review-20261018.md)。保存済み初回証拠を取得OFFでもHTTPなしで復旧する経路と、個人研究binding/pin/flagのoffline検査を追加しました。未有効化のままで、実行承認や実IAM/NASの確認を代替するものではありません。

2026-10-18 本番基点のローカル統合: 本番CollectorのGit記録 `0abf2b6` にPR #18 `2f32cf9`（#16を含む）を隔離branchで統合しました。[統合内容・synthetic検証](docs/collector-integration-validation-20261018.md)と[直前の本番read-only監査](docs/collector-production-integration-20261018.md)を参照してください。ECB・Models.dev・private PoC、既存Cron、source grant、Public APIを維持し、個人研究の新flags/bindingsは未設定です。以下のmain由来branchに関する注意は統合前の履歴です。本番deploy・remote migration・実収集は行っていません。

2026-10-18 最新の承認・実装: 所有者はHighreso/Rebroの非公開・個人研究限定の例外と長期保存を承認済みです。NAS専用exportの分離と停止状態の初回Cloud準備は [専用資料](docs/nas-export-isolation-20261018.md) を参照してください。提供者許諾はunconfirmed、実収集・権利grant変更・本番deploy・実鍵・NAS実機変更は未実施です。以下の旧段階の「例外承認待ち」「分離は設計のみ」は履歴で、現在の実行承認待ちとは区別します。

2026-10-18 非公開の個人研究: [現行DOM・規約適用・具体的な開始承認票](docs/public-gpu-private-start-review-20261018.md)。一回限りの構造調査は完了、価格履歴の実収集は未開始です。

2026-10-18 レビュー修正: [source別受入表・parser/cohort・11/1規約版・NAS権限分離のrelease blocker](docs/public-gpu-review-acceptance-20261018.md)。PR #16の再削除/台帳保護を取り込み、Highresoの見出しスコープと明示cohort、Rebroの重複事例を修正しました。実市場観測0件、未有効化。既存private evidence全体を読めるcredentialをNASへ渡す構成ではreleaseしません。

2026-10-18 日次拡張: [日次取得・複数run履歴export・NAS監視連携](docs/personal-daily-cloud-nas-20261018.md)を未有効化で実装しました。正規化履歴に年齢TTLを設けず、日次の取得・暗号化backup・整合性/復元検査・監視を自動継続する構成です。[synthetic検証記録](docs/personal-daily-validation-20261018.md)と未承認の初期設定案を参照してください。実収集・実鍵・実NAS・本番変更はありません。以下の初回一runのみという説明は追加前の記録です。

2026-10-18 Cloudflare→NAS実装: [実装・synthetic受入・未有効化設定・承認事項](docs/personal-cloud-nas-implementation-20261018.md)を追加しました。専用Cloud契約、private分割export、最新control、NAS固定read、age暗号化、自動保守、空のローカルD1への復元検査に対応します。実収集・実鍵・NAS実機・本番変更は未実施。日次新規取得は別スコープです。

2026-10-18 初回実行準備の方針更新: 所有者の指示により、ローカルはsynthetic専用、初回実データもCloudflareで取得しNASへバックアップする準備に変更しました。[設定・実行契約・鍵管理・承認事項](docs/personal-cloudflare-nas-setup-20261018.md)と[非実行の設定提案](docs/personal-execution-20261018/cloudflare-nas.setup-proposal.json)を参照してください。既存personal-gpu-v2はローカル専用の実装で、local v2による本番接続はできません。後続のCloud専用実装は上記の通り未有効化です。従来のローカルlive契約案は有効化せず参照資料として残します。実収集・鍵作成・NAS設定・grant変更・本番反映は行っていません。

2026-10-18 継続保存の追加: [個人研究v2の実装・運用手順](docs/personal-continuing-20261018.md)を追加しました。正規化履歴の年齢による削除をなくし、追加の契約レビュー、暗号化バックアップ、最新の取消しを反映した復元、自動保守の停止状態の設定案に対応します。以下の有限保持v1は互換性維持対象です。実収集・実契約・鍵設定・タスク登録・権利grant変更・本番反映は未実施です。

AI投資研究向けの出典・時刻・単位・比較条件・権利付き観測履歴APIです。投資判断や「AIバブル指数」を出すサービスではありません。

2026-10-18 個人研究例外: 追加指示により[Highreso/Rebro限定のlocal実装とsynthetic検証](docs/personal-gpu-implementation-20261018.md)まで進めました。提供者の許諾未確認と所有者の実行判断を分離し、初回1試行・有限保持・復元後の停止を専用経路で検査します。通常の権利gate・grant・disabled設定は維持。[判断票](docs/public-gpu-personal-research-draft-20261018.json)は未承認で、実収集・watch稼働・本番反映は未実施です。

2026-10-18 公開GPUの条件確認追補: [Highresoの11/1改定（国外例外あり）・Rebroの未特定規約と初回準備](docs/public-gpu-rights-review-20261018.md)を整理しました。`node scripts/public-gpu-check.mjs` は両社の設定を通信/保存なしで診断します。現状は両方blocked（exit 2）。権利grant・本番設定は変更せず、実収集も開始していません。

2026-10-18 Issue #17: [Highreso/Rebroの公開HTMLを使うPrivate研究経路](docs/public-gpu-research-20261018.md)を、PR #16から独立したstacked Draft PRとして追加しました。固定URL、専用GPU履歴0010、最小R2証拠、再観測/改定/not_seen、source別停止と保持をsynthetic検証します。公開ページの接続・構造を確認しましたが、自動取得/保存/内部分析はreview_requiredのまま、collector live観測0件・日次稼働0日です。公式未公開feedの返答を必須条件にせず、この公開範囲の条件を別途レビューします。本番dispatch/保持scheduler・grant・deployは未反映です。以下のPR #16のfeed待ち記述は、その時点の履歴です。

2026-10-18: PR #16の追加指示に従い、[研究履歴のレビュー待ち・収集停止・削除義務と保持モード](docs/research-long-retention-20261016.md)を分離しました。review_dueでは許諾内の履歴を保持し、明示された継続保管根拠とowner承認があるsourceだけuntil_revokedを選べます。0007/0008/0009はローカルのみ、旧期限は不変です。[運用手順](docs/private-research-runbook.md)と[検証結果](docs/source-expansion-validation-20261015.md)を参照してください。新sourceの実観測数0、本番変更0。次の候補はHighreso/GPUSOROBANとRebroの公式feed・権利確認待ちで、EIA/JEPXはcritical path外です。容量試算は参考に留め、新archive/DB分割は実装しません。Cloudflare配信版はmainと異なり、このbranchを古い設定のままdeployしないでください。[調査台帳](docs/source-expansion-20261015.md)に差分を記録しています。

10/18最終修正: 通常のfixed_days/until_revoked収集では `storage_review_hold` を一律必須にしません。実際の保存権が不明でholdもない場合は取得/readを止め、保存可否と削除期限を即時人間レビューへ上げます。無期限保管の許可は付与しません。

以下の本番対応の記録は2026-10-04〜05時点です。10/15のread-only確認との差分は上記台帳へ分離しています。

現在の本番はWorkers Paid・stage=enabledで、ECBとModels.devの5 provider/17 fieldを既存の日次Cronで収集・公開しています。2026-10-04にCollector a534ff0、Admin 97277deとprivate 0005/配信台帳を反映済みです。public APIは24768e9です。GPU実ソースはdisabledのままです。[本番対応・継続運用の受け入れ](docs/operations-acceptance.md)に配信version/tree/artifact、履歴保全、通知・復旧・保持の確認結果と現在の残件をまとめています。通知修正/0006とschema drift recoveryは未配信・未適用です。2026-10-05の所有者によるNetlify確認でGitHub push/PR保留を解除し、最新作業branchを公開して[Draft PR #7](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/pull/7)を作成しました。main mergeと本番変更は引き続き別承認です。

- [Phase 2納品報告](docs/phase2-delivery-report.md)
- [P0 Models.dev設計・policy案](docs/models-expansion.md) / [有効化・停止手順](docs/models-enablement.md) / [検証報告](docs/models-validation.md)
- [設計](docs/architecture.md) / [権利方針](docs/rights-policy.md)
- [GPUソース調査](docs/gpu-source-review.md) / [方法](docs/gpu-methodology.md)
- [Cloudflare初期設定](docs/cloudflare-runbook.md) / [運用](docs/operations.md)
- [データ辞書](docs/data-dictionary.md) / [コスト](docs/cost-model.md) / [OpenAPI](openapi.json)

## 構成

collector Worker → private R2の最小証拠 → private D1のimmutable履歴 → 権利/品質/完全取得gate → public D1 → API Worker。公開Workerはprivate DB、R2、取得用Secretsを持ちません。

GPUはrun/partition/page/snapshotを分離し、leaseとcheckpointで再開します。1,051件のsynthetic listingをworkerdで分割検証します。出品消失はnot_seen、API障害はpartialです。正常な大幅変動、条件変更の隔離、統計除外を分けます。日常の価格転記、CSV移動、Web巡回は運用に含めません。LLM常駐は不要です。

## 開発・検証

Node 24、pnpm 11.19.0。NAS暗号化試験の初期tool準備は `node scripts/setup-test-age.mjs --allow-download`（公式age、checksum固定、ignored work内、実鍵なし）。通常test/buildはtoolをdownloadしません。全件進捗は `pnpm test --reporter=verbose` で確認できます。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:runtime
pnpm build
pnpm preflight
```

buildはWrangler dry-runだけです。preflightは現行設定を検査し、blockerがあればexit 2を返します。拡張案は `pnpm preflight --proposal config/proposals/models_dev.v3.json` で実ファイルを変えずに評価できます。CIはnode scripts/preflight.mjs --allow-unconfiguredで構造を検査します。本番deployやlive収集をCIに含めません。

`pnpm models:status` はソースの設定・権利・認証待ちを表示します。DBを読まない既定モードで稼働中と判定しません。`pnpm models:benchmark`、`pnpm models:cost` はsyntheticの解析負荷と容量・費用の見積りです。Windowsで長い一時パスによりworkerdのSQLite起動が失敗する場合は、`AI_APIS_TEMP_DIR` を短い一時ディレクトリへ設定します。

pnpm smoke:liveは従来のFX/AIソースだけを対象とする明示ネットワークopt-inです。GPUを無断で追加していません。docs/live-smoke-report.jsonはPhase 1時点の記録で、Phase 2の実データ検証ではありません。

## API

既存/v1/observations、/latest、/changesにgpu_rental/gpu_secondaryとSKU/source/provider/country/region/contract/condition/basis/snapshot/as_ofフィルターを追加。履歴は最大100件のcursor pagination、期間上限366日です。latestは最大100系列で、GPUは最新の完全scopeに残るofferのみです。全件取得はcoverageのsnapshot IDでobservationsをページングします。

/v1/gpu/catalogは識別辞書、/v1/gpu/coverageは取得範囲、/v1/gpu/metricsは同条件統計、/v1/gpu/comparisonsは条件付き比較です。decimalは文字列、nullは0ではありません。すべてno-storeで現行権利を再検査します。

P0追加: `dataset=ai_model_catalog` と `model_snapshot` フィルター、`/v1/models/coverage`、`/v1/models/events`。既定のlatest/observationsには新catalog datasetを混ぜず、明示指定で取得します。価格は既存ai_api_pricesです。完全な同一scope間だけでnot_seenを生成し、掲載消失を提供終了としません。`latest` は最大100件なので全件はcoverageのsnapshotを指定してobservationsをページングします。

コード配布ライセンスは未選択です。全データに共通する再配布ライセンスを付けず、sourceごとの出典・条件を返します。

## Collector継続運用

UTC予定slotと秒付き旧runの照合、保存済み証拠からの有限復旧、Admin専用read-only入口は本番にあります。今回の候補は既存summary/outboxを使い、異常・復旧・継続通知と安全な有効化条件を追加します。正常時は通知しません。外部監視/通知送達と新版7日間実測は未受け入れです。通常判定は決定的処理で、常駐LLMを必要としません。

`pnpm collector:benchmark before` / `after` は合成データだけのNode/workerd性能検証です。[改善前後の測定とFree/Paid比較](docs/collector-performance.md)には、ローカル経過時間・CPU代理指標と本番Cloudflare CPUを分けて記録しています。Free適合や本番反映済みを示す結果ではありません。
