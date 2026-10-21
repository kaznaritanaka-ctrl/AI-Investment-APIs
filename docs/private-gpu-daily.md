# Highreso／Rebroの非公開日次研究（Issue #17）

PR #18 の公開ページ解析と研究用履歴を main（5bea9c4）へ限定移植したものです。**初期状態では収集は走りません。** `config/proposals/research/{highreso_public,rebro_public}.json` は enabled=false、研究の取得・保存・分析権限は review_required、保持期間は unapproved、owner／wire／保存／robots・規約確認は未承認です。既存Collector／Cronには接続しておらず、production呼出しも拒否します。新しいsecret、binding、Cron、サービス、grantはありません。

ライセンス判定はmainの[2026-10-21記録](license-review-20261021.md)の `gpusoroban`／`rebro` を参照し、「記載なし→研究用・非公開」を候補の `license_url`、`rights_checked_at`、`rights_evidence_ref`、`known_limitations` に記録しました。これは取得・保存の許可ではありません。今回ネットワークによる再確認はしていません。Rebroの解析対象はPR #18で扱った `/reason/`、規約監視候補は `/rules/` で、既存のQ&Aに関するライセンス判定を取得grantへ拡張しません。稼働sourceの設定には変更を加えていません。

## 収集と保存

`collectPublicGpuDay` はローカル用の日次呼出し口です。承認済み設定を渡した場合も、既存の研究用取得・保存・分析、terms、owner、wire、保持、外部取消し・削除記録を検査します。1 source／UTC日1 run、1ページ、1 run最大3 HTTP要求（robots→規約→価格を各1要求）、取得窓6時間、5分lease、SQL batch最大20文です。失敗はsourceごとに分離します。429のRetry-Afterは日を跨いでも守り、403、規約・robots・表構造の変更などは新しい設定のレビューまで停止します。単純再実行では要求予算を復活させません。

HighresoはA100/H100の候補scope、実候補ではGPU 1枚のインスタンスを選び、時間／月額を別の原単位で保存します。最大24インスタンス×2価格＝48観測で、超過を切り捨てず停止します。Rebroは選別公開事例の1 GPUあたり買取単価・掲載年月・掲載数量を保持し、実取引日時や全市場を補完しません。同内容の重複事例も別の出現として保持し、安定した取引IDとは見なしません。金額はdecimal文字列、未掲載はnull、0は0のままです。

HTML解析はPR #18の解析規則を移植し、追加依存を避けて既存のfast-xml-parserを使用しています。明示的に閉じた表を要求する厳格なHTML部分集合で、HTML5による省略タグの補修はしません。対応外のHTML、入れ子の表、colspan／rowspan、途中で切れた表、検証画面は停止します。実ページ適合性・robots・規約の指紋は有効化前の確認事項です。PR #18が記録したHighresoの2026-11-01 JST規約切替を越えて自動継続しないよう、候補の再確認期限を2026-10-31T15:00Zに置いています。新規約の許可を推測していません。

private R2には生HTMLではなく許可した最小投影とhashだけ、private D1には `research_gpu_observations` を保存します。既存のresearch_sources／runs／pages／config_versionsと保持評価台帳を再利用します。migrationは **private/0015_private_gpu_daily.sql 1本のみ**。GPU観測テーブル、索引2本、UPDATE禁止・保持削除制限triggerだけを追加し、既存テーブルを再構築しません。0001〜0009・0014の期限、FK、保持台帳のDELETE禁止を維持します。Public API／PUBLIC_DB／公開migrationは変更しません。

## 履歴と系列比較

`readPublicGpuHistory` は期間・synthetic区分を明示した最大31 complete runを返し、上限超過をtruncatedで表示します。partial／失敗日は掲載消失の根拠になりません。現行の権利、明示承認した旧config hash、元の保持期限、外部取消し・削除記録を読取ごとに検査し、返せない旧runがあればエラーにします。空のcomplete snapshotも保存し、期限切れの空snapshotを読める扱いにはしません。出典・ライセンスURL・規約・権利確認記録を伴うprivate関数で、HTTP API／外部exportはありません。

`dailySeriesDefinition` はPR #18から小さく独立させました。source／endpoint／parser版／対象model・GPU数／正規化版／原単位から系列hashを計算します。元のimmutable config_versionsを使うため追加の系列台帳は不要です。権利や保持の更新は価格系列を分割しませんが、旧履歴の利用には既存 `adoptReviewedResearchConfig` による明示承認が必要です。scopeや解析方法の変更は別系列で、暗黙に繋げません。

`comparePublicGpuRuns` は同一系列・同一synthetic区分の日次snapshotを比較します。記録された条件が一致した掲載価格だけ変化率を計算し、0基準・欠測・条件変更には率を出しません。地域などが未確認なら経済的比較は既存 `compareDomesticGPU` によりnot_comparableとし、掲載価格の変化と区別します。Rebroの価格変更は内容別の公開事例の増減で、取引の価格改定と推定しません。

履歴は追記式で first_seen／reobserved／revised／not_seen／reappeared を区別します。not_seenは直前の同scope complete snapshotとの掲載差だけを示し、価格・取引・在庫0を作りません。連日の未掲載は重複イベントを追加せず、再登場は以前のnot_seenに繋ぎます。保持処理は既存の最大20観測ずつの削除と、復元後の証拠再削除をGPUにも適用し、外部control記録や元の削除日時を消しません。Time Travelコピー消去完了とは主張しません。

## 有効化前に残るもの

ソース別research grant、取得形式・robots・規約、保存・Time Travel・R2 lifecycle、現行本番構成との相互レビューが必要です。将来の本番接続では既存Cron内の有限処理と保持削除の自動運用も同時に審査します。このPRでは本番entrypointを追加せず、日次手作業を要求する運転も開始しません。Claude Codeとの相互レビューと通常環境でのテスト／CIは呼び出し側に引き継ぎます。
