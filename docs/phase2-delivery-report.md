# Phase 2 納品・検証報告

対象: kaznaritanaka-ctrl/AI-Investment-APIs
基準: 55a9c243eb62ecbe1235567ce58a286959147ca7
作業ブランチ: codex/phase-2-gpu-observations
確認日: 2026-09-27 JST

## 状態の区別

| 状態 | 今回の結果 |
|---|---|
| 実装済み | Phase 0/1を維持したGPU rental/secondaryの縦の処理、統計、API、前進migration、設定準備 |
| synthetic検証済み | 65テストと1,051件のworkerd分割処理。実データとは別のテスト専用入力 |
| 実データ検証済み | 今回は0ソース・0件。公式資料の閲覧は行ったが、価格・listingデータAPIのlive取得は実行していない |
| 本番稼働済み | なし。本番作成、remote migration、deploy、独自ドメイン公開、Cron有効化は未実行 |
| 認証待ち | Lambda、さくら、eBay等。ローカルに実資格情報は設定されていない |
| 権利待ち | 新規GPUソースはすべてdisabled。取得・保存・分析・公開・再配布・派生・商用・保持期間を個別確認する |

**GPU市場の観測は開始していません。** 過去のPhase 1 live-smoke記録は今回の取得実績に含めません。ユーザーのCloudflareアカウント・所有ドメイン取得済みという情報は保持し、具体的なIDやドメイン名は推測していません。

## 実装内容

- 2 Worker、private/public D1、private R2を維持。公開WorkerはPUBLIC_DBとrate limiterだけ、collectorのHTTPは404。初期設定は明示的なcrons=[]とCOLLECTION_ENABLED=false。
- offline preflightと明示opt-inのCloudflare read-only照合コード、公開・Cronを分けたdeploy plan。CIはテストとdry-runだけ。
- GPU識別辞書、GPU rental/secondary別dataset、SKU・VRAM・form factor・台数・販売単位・地域・契約・税・通貨・basisの保持。B300とGB300/NVL72を分離し、不明項目を推定補完しない。
- Lambda、さくら高火力DOK、eBay Browse、Price of Computeの固定request planと投影adapter。認証endpointを分離し、次ページURL・redirect・応答サイズ・再試行回数を制限。
- run / partition / page / snapshot、lease、R2保存済みページからの再開、checkpoint、冪等性。1ページ50件、private batch最大20文で保存。snapshot完成までは価格を公開せず、partialの取得範囲を別途表示。
- 観測・証拠・source policy・訂正履歴を保持。条件が同じ大幅価格変動は警告付きの有効観測、lot等の条件変更は隔離。FX/AIの既存安全策は維持。listing消失はnot_seenであり、成約ではない。
- 訂正は新snapshotと新観測を追加し、supersedesとbackfillを付ける。保存済み証拠の訂正用関数は管理処理専用で、HTTP操作口を設けていない。
- 同条件の中央値・四分位点、7/30/90日参照、観測listing数、matched-offer変化、first-seen範囲、availability根拠比率、spot/世代間比較。履歴不足はnull/insufficient_data。
- 日米比較は現地通貨を残し、税抜・比較条件一致の場合だけ既存FX observation IDを付けた派生値にする。全入力の公開権限を確認してpublic D1へ保存し、読取時にも再確認。
- source別保持期限の自動処理、公開停止優先の削除、既存通知outboxとpublic healthの最終実行時刻。
- /v1/observations、/v1/latest、/v1/changes等とOpenAPIを拡張。薄いGPU APIは/v1/gpu/catalog、coverage、metrics、comparisons。scope、SKU、provider、region、contract、condition、basis、期間・as_of等を各endpointの定義に従って指定。
- DC・電力・取引関係はproject/site/phaseとMW basisを分けたschema、synthetic test、調査手順まで。企業クローラーやAIバブル指数は実装していない。

主なコードはsrc/gpu*.ts、src/request-plan.ts、src/network.ts、src/schema.ts、src/api.ts、src/publication.ts、src/collector.ts。migrationはprivate/publicの0002_gpu.sqlを追加し、0001は変更していません。

## 検証結果

| 検証 | 結果 |
|---|---|
| check | 成功。format、TypeScript、公開境界・設定検査 |
| test | 全65件成功（既存39件＋Phase 2追加26件）。最終修正対象の再検証結果は下記 |
| test:runtime | 成功。既存2 synthetic source、停止source、GPU 1,051件、再実行、公開API全件ページング |
| build | 2 WorkerともWrangler dry-run成功。本番deployなし |
| 生成整合性 | Source schema/OpenAPI再生成後のhash一致 |
| offline preflight | 構造検証成功、ready=false・exit 2。ID/ドメイン/プラン/retention/本番承認の未設定を意図どおり検出 |
| 0001・Git差分 | 既存0001不変、git diff --check成功 |
| 公開bundle | private DB/R2/取得用Secret名・fixture importを含まないことを確認 |

旧DBにFX/AIデータを投入した移行、immutable trigger/FK/系譜保持、unknown rightsでHTTP 0回、private-onlyの派生値がpublic DBへ入らないこと、権利停止、partialと正常0件の区別、価格大幅変動、lot変更、not_seen、lease競合、証拠再開、訂正・as_of、日米FX系譜、spot/世代間比較を含みます。

訂正済みsnapshotを後日の比較参照として選ぶ修正後、対象GPUテスト17件も再検証済みです。長い訂正シナリオはWindowsローカルD1通信で30秒上限に達したため、そのテストだけ60秒へ変更し成功を確認しました。本番の取得timeout・page/SQL予算は緩めていません。

2026-09-27 22:37 JSTの[workerd計測](runtime-phase2-report.json): 1,051件、22ページ、23分割呼出、最大batch 20 SQL、最大236 SQL/呼出、最大45 D1呼出/実行、R2操作88、mock HTTP 44、最大mock応答12,340 bytes。実外部データHTTPは0回。D1 metaの部分集計はrows_read 46,555、rows_written 20,494。ローカル経過2,453msであり本番CPUではありません。

費用例は1,000 listing/日・90日保持なら片側DB約0.675 GB、R2約0.285 GBという仮定です。権利の保持期限や実契約プランには転記していません。詳細な前提・除外費用は[cost model](cost-model.md)に記載しています。

## 実ソースの接続状態

| ソース | 技術実装・確認範囲 | 停止理由 |
|---|---|---|
| Lambda | Bearer認証のinstance-types取得と価格・region投影をsynthetic検証 | 実API key、用途別権利、保持期間、開始承認待ち |
| さくら高火力DOK | Basic認証unit_pricesのrequest/adapter。公式資料でis1aを石狩として確認 | 実認証・用途別権利待ち。ドキュメントのライセンスは価格再配布の許諾としない |
| eBay Browse | OAuth、USED/FIXED_PRICE検索、A100/H100 partition、pagination、最小投影を実装 | Production利用審査・認証、履歴保存/分析/商用再配布の権利待ち |
| Price of Compute | SKU別latest adapter。二次ソースとして独立件数から除外 | 履歴蓄積/派生/商用再配布の権利未確認。history adapterは未実装 |
| Runpod | 公式GraphQL仕様と認証を調査 | 比較条件・regionを含む取得adapterは未実装、権利・認証も未確認 |
| Highreso/そろばん | 公式サービス・規約を調査 | 本用途の正規feed/endpoint未確認、権利待ち |
| CCIR | ask・報告実売・推計のbasis分離を調査 | 正規feed/API未確認、権利待ち |
| 日本の中古市場 | 将来の許諾feed接続点のみ | 許諾された接続先なし。任意スクレイピングでは補完していない |

日本リージョンの候補接続コードはさくらですが、**日本の実レンタル価格を取得できた状態ではありません**。A100/H100/B200/B300等の辞書対応と、実収集済みの世代を混同しない表示です。外部問い合わせは文案のみで、送信していません。根拠と権利区分は[gpu-source-review](gpu-source-review.md)を参照してください。

## 一度だけ必要な設定・承認

1. 実Account ID、zone ID、所有ドメイン、既存private/public D1 ID、R2 bucketの照合。所有リソースを確認してから設定し、重複作成しない。
2. Workersの契約プラン、D1 Time Travel、source別evidence/archive/normalized/backup retentionの確認。GPU処理はFreeの50 SQL/呼出を超えるため、Paid確認をpreflightで要求する。有料契約が必要なら別承認。
3. ソースごとの用途別許諾とowner承認。取得/内部保存のみ許諾されたsourceはprivate-onlyで開始可能。公開や派生再配布は別gate。
4. Collector SecretsへのAPI/OAuth資格情報、通知先、外部health監視先の設定。秘密の値をGitやチャットへ記録しない。
5. 本番DB migration、初回deploy、API独自ドメイン公開、夜間Cron継続取得をそれぞれ対象を明示して承認。その後にread-only照合、canary、実CPU・費用確認を行う。

正常運転は決定的なプログラムで進みます。日々の価格転記、Web巡回、CSVダウンロード/アップロードをユーザーに要求する設計ではありません。権利失効・認証失効・schema変更などは例外通知とレビュー対象です。

## 限界・未実装

- 実GPUデータ、実アカウント照合、本番migration、公開、Cron、通知送達、外部監視は未検証・未稼働。
- Runpod、Highreso、CCIR、日本中古、POC historyは未接続。全GPU世代や全市場を取得する実装ではない。
- 不明SKUや契約・region・税条件は統計から除外するため、取得可能でも比較可能なサンプルが0になる場合がある。
- node価格の按分、月額の時間換算、実売feed、listing再出品の推定統合、粗い中古/賃料倍率は公開指標として実装していない。
- 既定continuation枠は72回/日を全GPU source・page・統計処理で共有。5,000件以上を既定設定で完走すると保証しない。比較候補は同日最大10 cohort、統計処理は1 cohort/回。必要なら実測に基づくADRで拡張する。
- retention処理は1 snapshot内の最大50観測/回などに分割。実運用の取得量と削除処理量の均衡、権利上限内の削除完了、バックアップ復元を設定後に検証する必要がある。
- Cloudflare課金CPU、完全なD1課金行数、実ネットワーク負荷は未測定。通知未設定・監視未接続を正常監視とは表示しない。
- 標本の中央値は記述統計。性能調整、稼働率、市場全体在庫、供給過剰の判定や売買判断を意味しない。

手順は[Cloudflare runbook](cloudflare-runbook.md)、定義は[GPU methodology](gpu-methodology.md)、費用仮定は[cost model](cost-model.md)を参照してください。
