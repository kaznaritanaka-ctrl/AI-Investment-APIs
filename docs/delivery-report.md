# Phase 0 / Phase 1 実装報告

リポジトリ開始時はREADME一行のみ（main c64950e）。設計だけで終了せず、Cloudflare Workers / D1 / R2の最小パイプラインを実装した。本番は未公開・未稼働。

## 実装したもの

- ソース台帳12件、9区分の独立した利用権限、根拠・有効期間・保持条件。未確認ソースは取得前に停止。
- 日次collector、有限HTTP/Retry-After/timeout、source単位の失敗分離、lease、circuit breaker、ETag/304、保存証拠からの再開。
- 許可されたR2証拠、private D1の追記観測・訂正・品質/変更イベント、decimal精度、原値と自前FX計算の系譜、R2正規化archive。
- private/public DBの分離、完了batchだけを公開、権限失効/停止を読取時にも適用。public APIにはprivate DB/R2をbindしない。
- 読取専用API、OpenAPI、llms.txt、source/方法論/再利用条件、stable cursor、stale理由、上限付き検索、rate limit設定。
- 日次summary、通知outbox/重複抑制、watchdog、初期設定・運用・コスト資料、オフラインCI。
- GPU schema/adapter契約、synthetic fixture、日本2社・海外2社の候補調査。

## 検証と実取得

[検証記録](validation.md)を参照。オフライン39件、workerd内のsynthetic全工程、型/境界検査、collector/API dry-runに成功。

ECBは2通貨、Models.devはMistralの2モデルを実HTTP取得し、ローカルR2/D1保存と5件のAPI応答検証まで成功した。fixture成功とは別に [集計結果](live-smoke-report.json) を記録。メーカー公式価格の検証や本番日次運用の成功は意味しない。

OpenRouterは利用根拠の適用範囲が未確認でHTTP 0件。GPU4候補は認証・蓄積/再配布権・offer別条件等の確認待ちでdisabled。未実施を成功として扱わない。

## 初期設定・例外承認

[setup.md](setup.md)に一度だけ必要な項目を列挙した。Cloudflareアカウント、private/public D1と非公開R2、migration/保持lifecycle、Webhook、CPUと料金プラン、本番公開先・公開承認。設定は担当エージェントが行える。日々の価格転記やCSV作業は不要。

有料契約、外部許諾メール、本番公開、mainへのmerge、破壊的変更は行っていない。未確認ソースの新規許諾、コード配布ライセンス、外部agent runtimeは別判断。

## 未実装

GPU実collector、メモリー/電力/金利/設備投資/指数の実系列、外部AIによる例外診断・修正PR自動生成、固定token費用の公開指数化、archive-only一括復元、外部死活監視、本番deploy workflowは後続。決済/MCP/会員管理/売買機能は今回の対象外。

次の一作業は、レビュー後にCloudflare接続・通知先・公開可否を確定し、承認された環境で性能・Cron・通知を検証すること。
