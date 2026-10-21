# Highreso／Rebro 非公開研究のデプロイ前チェックリスト

2026-10-21更新。現時点は両sourceがdisabled、規約HTML指紋・wire・保持・Time Travel/lifecycleも未承認で、フラグtrueだけでは取得しない。本書は有効化の許可やremote作業の実施記録ではない。運用方針はAGENTS.mdに従う。

## 配備・有効化前

- [ ] 現行本番のCollector/PoC/Modelsのコード・設定・migration状態を固定する。古いmain版を新しい本番構成へ上書きしない。既存Cron、公開範囲、Admin、Secrets、binding、NASを維持する。
- [ ] Claude Codeとの相互レビューとcheck/test/test:runtime/build、オフラインpreflight、生成schemaの検査を完了する。不一致はOpusの判断をPRに記録する。制約環境のSQLite代替試験をD1/workerd本体の通過と読み替えない。
- [ ] privateの0007_private_research.sql、0008_research_retention.sql、0009_research_retention_states.sql、0014_research_assessments_append_only.sql、0015_private_gpu_daily.sqlの適用を確認する（0010〜0013はこのrepoにない）。既存0001〜0003等も維持する。研究Cronは全5ファイルの台帳確認に失敗したらresearch_schema_unavailableでskipし、自動適用はしない。remote migrationはmigration自体の相互レビューと既存データ相当のローカル検証後だけ。破壊的migrationはOpus判断が必要。
- [ ] 各sourceの取得形式と最小投影を実応答で確認しwire_contract_review_refを記録する。ネットワーク禁止の作業では行わず、後日許可された検証として実施する。本文・実fixtureをGit/CIへ保存しない。
- [ ] [規約確認記録](license-review-20261021.md)のRebro別サイト利用規約の未公開・第10条の適用リスクを確認する。公開範囲や既存grantを広げず、禁止と判明した場合は収集を止める。
- [ ] robotsFingerprint（CRLF→LF、前後trim、UTF-8のSHA-256）を実応答と照合する。規約はtermsFingerprintによるHTML解析・可視本文正規化で照合する。抽出テキストだけから規約hashを推測しない。
- [ ] Highresoは11/1 00:00 JSTより前にterms_sha256、以降は確認済み新版のnext_terms_sha256を使用する。URLは/termsが第一。新版が/5401872にしかない場合はレビューしたhighreso_terms_fallback=trueと新policy版で切替を記録する。redirectや同一runの4要求目は認めず、再取得には明示登録・日次予算を確認する。
- [ ] 保存モード・期間・根拠、実際のTime Travel日数（7/30）、backup上限、R2 lifecycleを確認しretentionのreview refを埋める。target_daysは許諾ではない。research-control/を短期lifecycleから除外し、取消し・削除マーカーを復元でも巻き戻さない。
- [ ] 各runのimmutable config_versionsと保持snapshotが保存されることを確認する。設定変更後の保守は保存版で行い、期限は延長しない。旧履歴への読取許可は現行権利・history_accessで独立に審査する。新config取得には新policy版とadoptReviewedResearchConfigの明示更新が必要。Cronはこの権限更新を自動化しない。
- [ ] 最終設定でassertResearchAllowedが通ることを確認する。source.enabled、所有者承認、wire、独立した各権利、規約指紋、保存環境の全検査が必要。新grant、Secrets/権限拡大、ドメイン/Access、公開範囲拡大、費用増は個別にKazの承認を得る。
- [ ] フラグfalseの版で既存処理の回帰を確認してから、許可済み設定と厳密な文字列trueへ切り替える。既存継続枠で2source交互、1 source/UTC日1 run・最大3要求、private履歴の出典情報、PUBLIC_DBへの研究行ゼロを確認する。
- [ ] 取得停止、取消し、特定run削除、期限到来、R2削除失敗、復元後の再削除を確認する。固定コードのログとprivate保持台帳で判断し、Collector全体の健康情報を研究成功の証明にしない。1runの例外後も巡回が進み、失敗runを再試行できることを確認する。
- [ ] 保持評価台帳の増加（参考: 24行/日なら約9千行/年）、HTTP最大約45秒の健康更新遅れ、1MB HTMLの実クラウドCPUを確認する。ローカルCPUを5000ms適合の証明にしない。18:05台の前日slot空振りを欠測成功に数えない。月額アカウント合計20ドル超の見込みはKazに相談する。

## 取得停止・取消し・削除と復旧

Kazはブラウザ／スマホのチャットで停止方針・対象をAIへ伝える。AIが対象JSONを編集し、相互レビュー・CI後に反映する。日次の手入力やKazのコマンド操作を要求しない。

1. 取得だけ止めるならmaintenance.collection_stopped=true、またはsource.enabled=false。PRIVATE_GPU_RESEARCH_ENABLED=trueを維持する。config hashが変わっても、保存済み版の期限削除・証拠削除は継続する。
2. 取消しはmaintenance.revoke_atに発効日時を設定する。取得は直ちに止まり、発効後CronがR2の取消し記録を先に保存し、D1をsuspendして対象を削除する。R2失敗は成功扱いせず、次の巡回でも再試行する。
3. 特定runの削除はmaintenance.delete_requestsへrun_id、requested_at、basis_ref、all_copies_delete_byを記録する（最大5件）。実際の削除義務と全コピー期限をKazへ報告・確認した上で反映する。Cronがsourceを照合して削除マーカーを保存し、1回20観測ずつ処理する。全コピー期限を満たせない場合はbackup_deadline_missedを確認し、消去完了と報告しない。
4. 設定から停止・削除要求を消してもR2の取消し・削除記録は解除しない。未知の権利、内部レビュー期限だけを削除義務や無期限保持の根拠にしない。
5. フラグfalseは保守も止める。緊急の全停止時だけ使い、元の削除期限を守る代替保守と復旧を確保する。取得停止のためにフラグfalseや旧版を通常運用しない。
6. DB復元ではR2 research-control/を巻き戻さず、保存済みconfig版・snapshot・現行権利と外部マーカーを照合して全runを再評価する。本文だけ復元されたR2も再削除し、元のdeleted_at・削除期限・backup情報を維持する。D1行DELETEをTime Travelコピーの消去と説明しない。
7. 再開は新policy版、登録更新、必要な旧hash利用承認と全取得ゲートを確認してから行う。自動でgrantを更新しない。デプロイ後の動作確認に失敗したら直前の動作版へ戻してKazへ報告する。その版が研究保守を持たない場合も期限内の代替保守を確保する。新しい本番構成を古いmainで上書きしない。
