# 日次収集slotと旧runの互換性

2026-09-30。監査の18:17:35成功runと18:17:00の誤missingを、合成データで再現して修正。

- 日次slotは設定済みのdaily UTC CronとScheduledController.scheduledTimeから決める。実行時のDate.now()はslot決定に使わない。
- 新しいcollection runはsource + UTC分単位slotの既存hash規則を使用。watchdog/continuationは独立した起動種別であり、collection runの新しいIDを作らず、対象runを照合・再開する。
- 旧秒付きrunは同じsource・同じ予定分の範囲だけを既存UNIQUE(source_id,scheduled_for) indexで検索。complete/quarantinedを旧誤missingより優先し、元のrun ID・scheduled_for・証拠キー・checkpointを引き継ぐ。異なるID namespaceはfail closed。
- observed_at / recorded_at / started_atは実時刻。予定slotへの置換はしない。再開は保存された元slotで行い、実行が翌日になっても今日のslotを作らない。
- 同時起動は同じIDと既存leaseを使う。watchdogはsavedOnlyで復旧し、証拠が消失した場合も新しいHTTP取得に転じない。
- 誤missingや旧観測は削除・書換えしない。再照合したsummaryで実際の成功runを示す。過去の誤通知に訂正を付ける運用は別承認とし、outboxの一括再送・削除をしない。

この共通修正は0001/0002だけのDBで回帰検証する。0003・P0 grant・P0の有効化に依存しない。P0の専用models pipelineへの同じ識別処理の組込みは後続の別差分。Cron、COLLECTION_ENABLED、bindings、公開先、権利設定は変更しない。

`tests/run-identity.test.ts`で秒35/秒0、同時・重複起動、日付をまたぐ遅延、旧成功+誤missing、旧lease/保存済み証拠の復旧、真のmissing、source/日付/namespace分離、外部キーとimmutable triggerを検証する。GPUのcheckpoint/lease/partialは既存integration testsも実行する。

修正前の回帰テストはexpected complete / received missingで失敗。修正後の対象3ファイル42テストはpass（Windowsの短い一時ディレクトリを利用）。本番コードとGit SHAの完全一致・修正後本番実行は未検証。
