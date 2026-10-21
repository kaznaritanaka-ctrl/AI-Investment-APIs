# Highreso／Rebroの非公開日次研究（Issue #17）

PR #24をマージしたmain=b30554eに、Kazの2026-10-21 21:05 JST承認に基づく本番準備を追加しました。非secretフラグ`PRIVATE_GPU_RESEARCH_ENABLED='true'`と、Highreso/Rebroに固定した研究設定の全承認検査を通った場合だけ、本番経路を開きます。初期フラグはfalseです。両候補の自動取得・非公開保存・内部分析のみallowed、公開表示・再配布・外部LLM・AI学習は禁止です。新しいsecret、binding、Cron、依存、有料サービス、migrationはありません。

規約確認は[2026-10-21記録](license-review-20261021.md)のgpusoroban／rebroを参照します。呼び出し側が21:06 JSTに取得したwork内の本文を使い、この実装作業では外部通信も実収集も行いません。Highresoは現行と11/1適用新版を確認済み、Rebroは/reason/・/rules/・robotsのContent-Signalまで記録しました。robots指紋は保存本文から計算済みです。規約は抽出テキストなので既存HTML指紋との一致を保証できず、terms_sha256=nullを維持します。source.enabled=false、wire未確認、保持unapproved、Time Travel/lifecycle未確認も維持しており、フラグだけを切り替えても取得しません。権利承認と未確認の技術ゲートを混同しません。

## 収集と保存

`collectPublicGpuDay` は非公開の日次呼出し口です。承認済み設定を渡した場合も、既存の研究用取得・保存・分析、terms、owner、wire、保持、外部取消し・削除記録を検査します。1 source／UTC日1 run、1ページ、1 run最大3 HTTP要求（robots→規約→価格を各1要求）、取得窓6時間、5分lease、SQL batch最大20文です。失敗はsourceごとに分離します。429のRetry-Afterは日を跨いでも守り、403、規約・robots・表構造の変更などは新しい設定のレビューまで停止します。単純再実行では要求予算を復活させません。

HighresoはA100/H100の候補scope、実候補ではGPU 1枚のインスタンスを選び、時間／月額を別の原単位で保存します。最大24インスタンス×2価格＝48観測で、超過を切り捨てず停止します。Rebroは選別公開事例の1 GPUあたり買取単価・掲載年月・掲載数量を保持し、実取引日時や全市場を補完しません。同内容の重複事例も別の出現として保持し、安定した取引IDとは見なしません。金額はdecimal文字列、未掲載はnull、0は0のままです。

HTML解析はPR #18の解析規則を移植し、追加依存を避けて既存のfast-xml-parserを使用しています。明示的に閉じた表を要求する厳格なHTML部分集合で、HTML5による省略タグの補修はしません。対応外のHTML、入れ子の表、colspan／rowspan、途中で切れた表、検証画面は停止します。実ページ適合性・robots・規約の指紋は有効化前の確認事項です。Highresoは2026-11-01適用の新版（最終改定2026-08-27、国外は同日適用）まで内容確認済みとして、再確認期限を2027-01-15に置きました。11/1を一律停止境界にはしません。11/1 00:00 JST以降は`/5401872`の固定URLと`next_terms_sha256`を選び、以前は`/terms`と`terms_sha256`を使います。要求数は3回のままです。両指紋は未設定で、デプロイ前に既存HTML指紋形式で照合する必要があります。実応答が承認済み指紋と違う場合は従来どおり取得前に停止します。

private R2には生HTMLではなく許可した最小投影とhashだけ、private D1には `research_gpu_observations` を保存します。既存のresearch_sources／runs／pages／config_versionsと保持評価台帳を再利用します。PR #24のmigrationは **private/0015_private_gpu_daily.sql** で、今回の追加migrationはありません。GPU観測テーブル、索引2本、UPDATE禁止・保持削除制限triggerだけを追加し、既存テーブルを再構築しません。0001〜0009・0014の期限、FK、保持台帳のDELETE禁止を維持します。Public API／PUBLIC_DB／公開migrationは変更しません。

## 履歴と系列比較

`readPublicGpuHistory` は期間・synthetic区分を明示した最大31 complete runを返し、上限超過をtruncatedで表示します。partial／失敗日は掲載消失の根拠になりません。現行の権利、明示承認した旧config hash、元の保持期限、外部取消し・削除記録を読取ごとに検査し、返せない旧runがあればエラーにします。空のcomplete snapshotも保存し、期限切れの空snapshotを読める扱いにはしません。出典・ライセンスURL・規約・権利確認記録を伴うprivate関数で、HTTP API／外部exportはありません。

`dailySeriesDefinition` はPR #18から小さく独立させました。source／endpoint／parser版／対象model・GPU数／正規化版／原単位から系列hashを計算します。元のimmutable config_versionsを使うため追加の系列台帳は不要です。権利や保持の更新は価格系列を分割しませんが、旧履歴の利用には既存 `adoptReviewedResearchConfig` による明示承認が必要です。scopeや解析方法の変更は別系列で、暗黙に繋げません。

`comparePublicGpuRuns` は同一系列・同一synthetic区分の日次snapshotを比較します。記録された条件が一致した掲載価格だけ変化率を計算し、0基準・欠測・条件変更には率を出しません。地域などが未確認なら経済的比較は既存 `compareDomesticGPU` によりnot_comparableとし、掲載価格の変化と区別します。Rebroの価格変更は内容別の公開事例の増減で、取引の価格改定と推定しません。

履歴は追記式で first_seen／reobserved／revised／not_seen／reappeared を区別します。not_seenは直前の同scope complete snapshotとの掲載差だけを示し、価格・取引・在庫0を作りません。連日の未掲載は重複イベントを追加せず、再登場は以前のnot_seenに繋ぎます。保持処理は既存の最大20観測ずつの削除と、復元後の証拠再削除をGPUにも適用し、外部control記録や元の削除日時を消しません。Time Travelコピー消去完了とは主張しません。

## 既存Cronとの統合と保持

`src/research/collector.ts`は既存継続Cronのidle枠を使用します。従来のModels/GPU処理を優先し、空き枠の3回中2回は既存GPU保持、1回を研究に割り当て、Highreso/Rebroが交互に進みます。研究の取得時刻は既存の日次UTC論理slot（現在18:17 UTC、03:17 JST）へ固定します。同日再実行でrun数やHTTP予算は増えません。Cron追加はありません。フラグ未設定/false時は研究用DB/R2/HTTPに触れず、従来の保持呼出しを維持します。

1研究枠で1ソースの証拠最大5 run、保持評価・削除最大1 run（20観測）、取得最大1ページを処理します。期限到来・削除途中・取消しを優先し、それ以外もresearch-control/maintenance内の巡回位置で再評価します。削除済みrunも巡回してR2だけが復元された場合を再削除し、元の削除日時・期限・外部制御記録を維持します。新しい制御用メタデータにも本文や価格は含めません。取得権限の失効や取消し後もフラグtrueなら保持・削除は継続します。取得・読取は常に現行権限で停止します。

研究側の例外は既存Collectorの収集・通知・健康更新へ伝播しません。保持処理に失敗した回は研究取得を行いません。研究の結果はprivateのrun/保持評価台帳で確認し、Collector全体の成功を研究成功と見なしません。Public API/Adminのimport経路は研究に依存せず、研究結果をPUBLIC_DBや既存公開summaryへ追加しません。

## 有効化とロールバック

必要migrationはprivate 0007/0008/0009/0014および0015です。現行本番構成との照合、実応答の取得形式と規約指紋、保持と保存環境のレビュー、source.enabledを含む承認済み最終設定、Claude Codeとの相互レビューとCIを完了してからフラグを切り替えます。デプロイ前の具体的な検証項目と復旧手順はローカルの`work/codex-c-report.md`に記載しました。運転は既存Cronで自動化し、日次手作業を要求しません。

取得のみ停止する場合は審査済みの新policyでsource.enabled=falseにし、保持フラグtrueを維持します。フラグfalseは研究保持も止めるため、緊急停止・旧版復帰では既存の削除期限を満たす保持作業を別途確保します。R2のresearch-control記録を復元で消さず、再評価・再削除後に再開します。稼働設定や公開範囲を拡大せず、新しい本番設定の上に過去のmain版を配備しません。
