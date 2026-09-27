# 検証記録（2026-09-27 JST）

## 到達範囲

Phase 0の調査・設計とPhase 1のローカル全工程を実装・検証した。本番Worker、D1、R2、Cron、外部通知先は未接続。本番自動収集が稼働しているという意味ではない。

- オフライン: Vitest 39件（domain 9、network 6、D1/R2 integration 24）。HTTPは自作synthetic。テスト用DBは都度分離。
- 実行環境: pnpm test:runtime は本体コードをbundleし、Cloudflare公式Miniflare/workerd内でsynthetic 2ソースの取得・R2・D1・公開APIを実行。禁止ソースは0リクエスト。通常のintegrationはNodeから同じローカルD1/R2 bindingsを操作する。
- 型/境界: TypeScript strict、source schema、9権限、public API binding、fixture隔離、公開設定の静的検査。
- ビルド: collector/API双方のWrangler dry-run。公開やCloudflareリソース作成はしない。
- スキーマ: source JSON SchemaとOpenAPIを生成元から再生成。CIで生成差分を検出。
- CI: push/PRで上記検証。実ソース取得、秘密データartifact、本番deployを含めない。GitHub上の実行結果はPRのChecksを参照し、ローカル成功と区別する。

ローカル環境: Node 24.19.0、pnpm 11.19.0、Wrangler 4.140.0、Miniflare 4.20260730.0。Miniflareのcompatibility dateは2026-07-30、本番設定は2026-09-01。本番リソースと最新runtimeでのCPU・メモリー・D1制限・通知・Cron到達確認は未実施。

## 実取得（fixture不使用）

詳細な実行UTC、件数、HTTP回数、ローカルCPU/時間は [live-smoke-report.json](live-smoke-report.json)。取得本文、DB、認証値を公開リポジトリへ含めない。最終smokeは新規のローカル永続ストアで実施した。

| ソース | 実HTTP | 結果 |
|---|---:|---|
| ECB XML | 1 | EUR/USD・EUR/JPYの2原系列を保存・受理。USD/JPY自前計算1件と系譜も保存・公開投影 |
| Models.dev JSON | 1 | mistral-large-latest / mistral-small-latest の2モデルを保存・受理。二次カタログ、適用日時・実体model版はunknown |
| OpenRouter | 0 | policy_skipped。自動取得・蓄積・再配布の適用範囲が未確認 |
| GPU4候補/後続分野 | 0 | 候補のみ、disabled。collector未接続 |

公開投影を読むローカルAPIはHTTP 200、5件の応答スキーマ検証に成功。外部Webhookはnot_configured、agent_enabled=false。有料契約・インスタンス作成・本番公開なし。

初回smokeで旧Anthropic選定IDが現行カタログに無く、残った2件をcatalog_incompleteとして隔離した記録は [live-smoke-initial.json](live-smoke-initial.json)。この失敗を成功件数へ含めない。選定範囲を明示変更したpolicy v2で最終検証している。provider公式の価格確認成功とは主張しない。

## 指示書の受入条件との対応

| # | 検査対象 | 実施内容 |
|---:|---|---|
| 1 | 冪等性 | 同じslot再実行、保存証拠再処理、同時lease、公開失敗後の再開 |
| 2 | 同価格と欠測 | 翌日別観測、未取得runはmissing、changeなし |
| 3 | 0/欠損/tier/不正数 | lossless JSON、decimal、nullと0、未知条件の隔離 |
| 4 | 100万倍 | Models.dev million_tokensとOpenRouter token/requestの別契約 |
| 5 | provider混合防止 | 集約catalogとprovider_catalogを区別、集約から固定token費用を計算しない |
| 6 | ソース失敗分離 | ECB 403でもAI価格を保存、watchdogのpolicy異常も他sourceを止めない |
| 7 | 有限HTTP | 429・Retry-After・timeout（bodyを含む）・403・空・pagination・最大bytes |
| 8 | FX | 向き、40桁計算、TARGET週末/祝日、stale、future/as_of |
| 9 | 訂正履歴 | parser版で追記・supersedes・UPDATE拒否・当時の記録参照 |
| 10 | 禁止ソース | policy gateがHTTPより先、実smokeでもOpenRouter 0回 |
| 11 | 非公開/派生 | public DB分離、private-only、全入力rights、change前値の権限も要求 |
| 12 | 失効/停止 | 読取時失効、sticky revoked、derived非表示、no-store |
| 13 | R2後のDB失敗 | evidence未登録状態からrefetchなし復旧 |
| 14 | 公開途中 | staging非表示、完了直前失敗からの再公開、変更イベント再読込 |
| 15 | 接続未設定 | notification not_configured、agent警告、認証必要sourceは実収集disabled |
| 16 | 環境分離 | syntheticをproduction/developmentで拒否、live用state分離 |
| 17 | API契約 | Zod/OpenAPI、filter/limit/期間、cursor snapshot、UTC正規化、エラー、rate limit |
| 18 | 外部命令 | 固定endpoint、redirect拒否、余計な文章/URLを無視、設定権限は外部本文から変更不可 |

加えて、取得中のsuspendで保存を阻止、policy/endpoint/選定範囲の同一版書換えを検出して公開停止、expired/mismatched証拠の直接再解析拒否、異常検知時刻を過去as_ofへ漏らさないことを検証。

## 残る実運用検証

Cloudflare実アカウント上の性能・Cron・通知・Time Travel復元訓練、長期archiveだけからの自動一括復元、platform全体停止の外部監視は未実施/未接続。自動AI修復、GPU実収集、固定token費用の公開指数化は未実装。代わりに日次作業をユーザーへ要求する設計ではなく、[初期設定](setup.md)と例外時のレビューで接続する。
