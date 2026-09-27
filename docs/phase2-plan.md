# Phase 2 実装計画と実施範囲

開始時にgit fetchと作業ツリーを確認しました。origin/mainは指定基準55a9c243eb62ecbe1235567ce58a286959147ca7と一致し、作業ツリーはcleanでした。Phase 1作業ブランチとの差はmerge commitの履歴で、内容差はありませんでした。codex/phase-2-gpu-observationsを分岐し、他の進行中変更を上書きしていません。

追加仕様はユーザーが設計要件として指定した添付Briefとして読みました。現在の依頼による「コード・設定準備・ローカル検証」の範囲を優先し、本番作成・公開・Cron有効化・有料契約・外部問い合わせ・main merge・新規権利承認は行いません。

## 実装範囲

- P0: 2 Worker/private-public D1/private R2維持、Cron明示停止、offline preflight、read-only cloud preflightの準備、段階別deploy planとrunbook。
- P1: GPU rental/secondaryの型だけでなく、認証付きbounded network、最小証拠投影、ページ保存、lease/checkpoint、履歴、公開確定、API/latest/changes、OpenAPI、forward migration。
- P2: 同条件分位点、7/30/90日参照、観測listing数、matched cohort、availability根拠比率、spot/世代/FX系譜付き日米比較。履歴不足と比較不能を保持。
- P3: DC project/site/phase、MW basis、取引関係のschemaと調査手順。企業クローラーは作らない。

GPU sourceはすべてdisabled/review_requiredです。さくらの日本regionを扱う接続コードを準備しましたが、許諾・認証が揃わず実取得はしていません。実運用への切替はsourceごとに可能です。

## 設計判断

既存0001 migrationは不変。0002でCHECK制約を再構築し、旧ID/FK/index/immutable triggerを保ちます。private/publicの分散transactionは仮定せず、publicはstaging後にsnapshot全体を確定します。partial coverageだけは安全な投影を返します。

Queues/Workflowsは追加しません。Wrangler Cronで日次runを作り、5分間隔のcontinuation候補枠で1source・1page/回を再開します。これは取得頻度の増加ではなく日次検索の分割です。GPU大幅変化の警告・統計除外・隔離を分け、既存FX/AIの基準は維持します。

チェック、試験結果、残る承認と未実装範囲は[納品報告](phase2-delivery-report.md)に集約します。
