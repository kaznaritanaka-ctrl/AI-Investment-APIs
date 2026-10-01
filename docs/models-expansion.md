# P0: Models.devのprovider別観測履歴

この実装は2026-09-30のデータ拡張仕様のP0です。既存のFX・Mistral 2モデル・GPU処理を保ち、承認後にOpenAI、Anthropic、Google、xAI、Mistralの掲載モデルを設定駆動で日次観測できます。新しいprovider/fieldの権利は付与していません。実装・migration・合成試験を納品し、本番deploy・remote migration・拡張live取得は行っていません。

## 調査と識別

2026-09-29T19:12:37Z（2026-09-30 JST）時点でModels.devの公開コードを確認しました。対象版は `747925c4fb0142db3e508cac02202c2748a34cf0`。provider IDは表示名から作らず、同版の[openai](https://github.com/anomalyco/models.dev/blob/747925c4fb0142db3e508cac02202c2748a34cf0/providers/openai/provider.toml)、[anthropic](https://github.com/anomalyco/models.dev/blob/747925c4fb0142db3e508cac02202c2748a34cf0/providers/anthropic/provider.toml)、[google](https://github.com/anomalyco/models.dev/blob/747925c4fb0142db3e508cac02202c2748a34cf0/providers/google/provider.toml)、[xai](https://github.com/anomalyco/models.dev/blob/747925c4fb0142db3e508cac02202c2748a34cf0/providers/xai/provider.toml)、[mistral](https://github.com/anomalyco/models.dev/blob/747925c4fb0142db3e508cac02202c2748a34cf0/providers/mistral/provider.toml)から確認しました。

[README](https://github.com/anomalyco/models.dev/blob/747925c4fb0142db3e508cac02202c2748a34cf0/README.md)、[schema](https://github.com/anomalyco/models.dev/blob/747925c4fb0142db3e508cac02202c2748a34cf0/packages/core/src/schema.ts)、[生成](https://github.com/anomalyco/models.dev/blob/747925c4fb0142db3e508cac02202c2748a34cf0/packages/core/src/generate.ts)、[API出力](https://github.com/anomalyco/models.dev/blob/747925c4fb0142db3e508cac02202c2748a34cf0/packages/web/script/build.ts)を照合しました。`api.json?type=all` の各provider内model IDをそのまま列挙し、`latest`という名前だけで選別しません。特定の現在モデルIDや実価格をテスト初期データに転記していません。

canonical_model_idはソースが報告する識別関係として保持し、lab識別子とserving providerを分けます。mapping_basis/versionを付け、異なるprovider/aliasを自動的に同系列へ統合しません。canonical切替はsource_mapping_changedです。固定versionかaliasかを名称で推定せず、identifier_kind=unknown、model_version=nullにします。

## Policy proposal

根拠候補は同版の[root MIT LICENSE](https://github.com/anomalyco/models.dev/blob/747925c4fb0142db3e508cac02202c2748a34cf0/LICENSE)と上記データ生成経路です。MIT通知は公開metadataに維持します。これはAPIが公開されていることだけを根拠にした許可でも、Models.devに含まれる全著作物・モデルウェイト・提供企業への直接アクセスの包括的許可でもありません。

`config/proposals/models_dev.v3.json` は実ソース設定から独立し、enabled=false、9権限すべてreview_requiredです。既存v2を上書きしません。審査単位は以下です。

| 審査対象 | 提案内容・境界 |
|---|---|
| provider | openai、anthropic、google、xai、mistral。任意の部分集合で承認可能 |
| identity | id、canonical_model_id。モデル別手動selectionは空。承認済みprovider内の新IDは自動追跡 |
| limits/modalities | limit.context/input/output、modalities.input/output |
| capabilities | reasoning、tool_call、structured_output、attachment、temperature |
| lifecycle | release_date、last_updated、status。未知フィールド全体を保存しない |
| price | cost内の対応数値・tier条件、experimental.modes.cost内のmodeラベル・対応数値 |
| 除外 | description、logo、任意URL、benchmark、request body/header、認証情報、モデルウェイト |
| 権利 | HTTP取得、private保存、内部分析、公開表示、正規化配信、派生配信、商用配信を独立判断。raw配信・外部LLMは使用しない |
| 保持案 | evidence 90日、archive 365日、normalized/public/events 1095日、backup上限30日 |
| 実行予算案 | max_models=500、25モデル/invocation、64 component/model上限、max_bytes=16 MB。runtime review必須 |

`models.providers/fields` は `policy.models_scope` の部分集合に限定されます。policy.fieldsのprojection marker、owner approval、runtime review、retention reviewもHTTP前に検証します。policy/hash・endpoint・scopeを同一policy版で書き換えると停止します。fieldを外す場合はnullとnot_in_policyを保存し、R2読込時もfield範囲を再検査します。公開未許可でも最初の3権限を満たせばprivate-onlyで動作します。

## 保存・完全取得・復旧

private/public各0003 migrationを追加し、0001/0002は変更しません。共通observationsを保持してdataset CHECKを広げ、型付きcatalog domain、snapshot、membership、eventsとpublic投影を追加します。既存データ入りDBのforeign key・immutable trigger・FX APIを回帰試験します。

1. 日次Cronでsource/runの10分leaseを取り、固定endpointを上限・timeout・最大3試行で取得。許可部分だけR2のrun別固定キーへ保存します。
2. 次の既存continuationで最大25モデルを処理。モデルごとのprivate原子batch後、public stagingへ冪等に投影し、archive保存後にcheckpointを進めます。
3. 前回の完全・同一scopeとのnot_seenを50件ずつ処理。scopeはendpoint、provider、field、上限、policy、parser仕様のhashです。
4. private件数とpublic staging件数を照合して公開を一括確定します。途中失敗・lease競合・同runの再実行で二重観測を作りません。R2以降の失敗は再HTTPせず復旧します。

原JSONはintakeで全体解析します。さらに各continuationで最小投影を読み直すため、bounded SQLだけでCPU・メモリーの問題が解消するとは言えません。ローカルNode CPU/RSS、workerdのSQL/D1/R2、50/250/1000規模を別々に計測します。2026-10-01時点で本番のWorkers PaidとCollector CPU上限5,000msは確認済みです。P0ブランチの開発時点の設定は本番用候補で同期し、拡張時の実CPU・最大component・長期容量・保持期間の審査を別に完了します。手順は[有効化計画](models-enablement.md)に記載します。

上限超過は保存対象を空にしてpartial/model_limit_exceededを記録し、切り取った先頭だけを完全取得としません。provider欠落・model identity/schema破損もpartialです。価格だけ未対応ならcatalog membershipは維持してそのpriceを隔離します。parser失敗/timeout/partial/scope変更は提供終了でもnot_seenでもありません。

初回baseline_seenは発売イベントではありません。次回はfirst_seen、observed_again、reappeared、not_seenを分離し、明示status=deprecatedへの変更だけsource_deprecatedとします。それでも実APIの利用不能を確認したことにはなりません。

## 価格と時系列

input/output/cache_read/cache_write/reasoning/input_audio/output_audio、明示context tier、experimental modeの数値を原通貨・原単位で保持します。画像・request/storage課金等の未知構造は該当priceを隔離します。ソースにないbatch/priority、税、platform fee、promotion、cache TTLを補いません。modeのrequest条件を保持できない場合も隔離します。

0はzero_unverified、未掲載はmissing、明示nullはunknown、変換不能はunsupportedです。無料確認の根拠を持たないためfree_confirmedを生成しません。USD/million_tokensはソース原単位で、換算値ではありません。価格の50%超変化は該当モデルで隔離を継続し、翌日同じ値が出ただけで解除しません。FX/旧AIの閾値は変更しません。

同じ値でも翌日の観測を保存します。価格以外の系列条件が変わった場合はprice_conditions_changedとし、値上げ率を作りません。metadata変更、canonical変更、明示deprecatedを別イベントにします。first_seen_atは従来の「同一内容の初記録」、first_model_observed_atは同一source/policyの保持済みモデル初観測です。

訂正入口は内部 `collectModels` の `revision: {snapshot_id, review_ref}` と異なるparser版です。保存済み最小投影、同run/policy、元のobserved_at、現在recorded_atを使い、新snapshotとsupersedesを追記します。HTTP管理口はありません。保存されなかったfieldや原文は復元できません。元資料の期限切れ・未レビューparserでの再解析や、現在値による過去日埋めは拒否します。as_ofは当時の保存・公開完了時刻を越える訂正を返しません。

## 公開契約

`/v1/observations?dataset=ai_model_catalog&model_snapshot=<ID>` をcursorでページングできます。latestは最大100件です。従来のdataset未指定latest/observationsには新catalogを含めず、既存Adminの価格レスポンスを維持します。価格は既存ai_api_prices、同条件の価格差は既存changesにも出します。

`/v1/models/coverage` はscope、provider/field、complete/partial、列挙件数、catalog/price/component件数、隔離件数と理由を返します。partialの新catalog/価格は公開せず、最後の完全snapshotを維持します。`/v1/models/events` は現在と前の入力の権利・公開batch・expiryを確認します。両APIはsource/scope/snapshot/as_of/limit/cursorを受け付け、no-storeです。原証拠、private理由の全文、契約、R2キー、Secretは公開しません。

policy更新時は既存のfail-closed規則に従い旧公開policyをinactiveにします。旧観測はprivate履歴に残りますが、過去版の再公開は別レビューであり自動復活しません。

## 保持と運用上の限界

旧90日は投影証拠の期限で、旧正規化価格の90日削除ではありません。新正規化履歴はsnapshot expiryを持ち、read時に期限切れを非表示、continuationで最大25モデルずつpublic→privateの順に削除します。訂正の参照先を壊さないよう子revisionを先に消します。disabled/旧設定への切戻し後もexpiry処理を継続します。R2 source別lifecycleとTime Travelを別確認し、法的な全source削除には派生archive・backupを含む例外手順を適用します。

既存continuationは72枠/日です。500モデル案はingest・最悪の全件入替・定常retentionを含め54枠の計画で余裕を残します。1000モデルは合成処理可能でも同条件では104枠を要し、preflightで有効化を止めます。複数GPU sourceとの同時有効化も別予算レビューが必要です。Queues等を追加せず、既存Cronsを勝手に増やしません。

実データ件数・最大component・CPU・128 MB isolate・長期DB query/容量は未検証です。範囲超過・認証/権利・schema変化は理由付きで停止し、他sourceを継続します。日常の手動selection追加、CSV、価格転記やLLMは不要です。必要な例外判断だけを[有効化手順](models-enablement.md)へまとめています。
