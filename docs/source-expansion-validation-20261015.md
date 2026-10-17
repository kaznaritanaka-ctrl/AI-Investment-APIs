# Issue #15 検証・納品記録

対象: main `1d42d981cb93c5185ecba8cf53b108c496d91cf7` を基にした `codex/source-expansion-private-research-20261015`。Windows / Node 24.19.0 / pnpm 11.19.0 / Wrangler 4.140.0。通常のtest/buildに実ソースHTTPは含めない。

## 2026-10-18：holdの一律開始条件を除く最終修正

基準commitは `78018914679af64f3a712e23133b1b69b85c5fe7`。[owner最終指示](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/pull/16#issuecomment-6236225676)による小規模な追加差分。下記の前回実装で要求した有限holdは、通常の取得条件から外した。

- fixed_daysは通常の権利・scope・terms・レビュー・有限期間・backup/Time Travel条件が有効ならhold=nullでPrivate収集/read可。期限切れの任意holdも、実保存権が有効なら通常収集を妨げない。
- until_revokedも実際の継続保存根拠・owner承認があればhold=nullで可。根拠/承認の欠落・空白と曖昧なnull期間は引き続きHTTP/保存前に拒否。
- 保存権不明で取得時holdがなければ取得/readを停止。storage=unknown / review_rights / review_deadline=評価時刻とし、保存可否・削除期限を即時人間レビューへ上げる。現在configのholdを旧runへ遡及付与しない。既知の有限期限は維持し、null期限は無期限保存許可ではない。
- holdなしのreview_due→再審査→read復旧、明示権利終了、固定期限、削除要求とD1復元/R2マーカーを回帰検証。既存有限holdを使った権利不明時の猶予・期限削除も維持。
- v2 snapshotはhold=nullを保存可能にした。pipelineは既存の共通gate/判定を使い、0009のJSON制約はnull holdを既に許容するため変更不要。0007/0008/0009、過去期限、公開schema/OpenAPI、active source/grant、deployment、Wrangler、Collector dispatch、Admin/NAS、依存packageに差分なし。

| チェック | 最終修正の結果 |
|---|---|
| 保持処理の重点テスト | 2 files / 28 tests成功 |
| pnpm check | format / TypeScript / 公開境界成功 |
| pnpm test（下記Windowsオプション） | **29 files / 297 tests成功、370.48秒**。6件追加、既存holdなしの復旧/削除等の期待値も更新 |
| pnpm test:runtime | workerdのFX/AI・復旧・operations、GPU1,051件/22page、Models50/250/1,000件すべて成功。外部HTTPなし |
| pnpm build | Collector/APIともdeploy --dry-run成功、実deployなし |
| pnpm preflight | offline / static_valid=true / ready=true / blockers=[] / network_performed=false。本番driftの解消を意味しない |
| schema生成 / 差分検査 | source.schema.json / research.schema.json / OpenAPIは再生成して差分なし。git diff --check成功。全migration・本番設定・package差分なし |
| GitHub CI | この最終修正commitの結果とrun URLは[PR #16の検証欄](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/pull/16)へ記録。過去commitの成功を流用しない |

新sourceのlive観測0件、本番変更0件。権利grant、live/backfill、remote migration/deployは未実施。Highreso/GPUSOROBAN・Rebroの公式feedと自動取得/長期保存条件はowner確認待ち。有限holdは通常開始の追加条件にせず、提供者が認める場合だけ任意で記録する。

## 2026-10-18：10/17追加指示の検証（履歴、hold条件は上記で修正）

基準commitは `264d77353c36b611191a760774df1db0758dc094`。既存Draft PR #16への追加差分だけを作成。新sourceの実観測数=0、本番変更=0、新しいallowed=0。以下はsynthetic/localであり、本番稼働や実データ取得ではない。

- review_dueはHTTP/readを停止し、保存許諾内の履歴を保持。永久R2マーカーを作らず、根拠再確認・新policy・過去hash承認後にreadを復旧する回帰試験を追加。
- collection_stoppedと分析権不明を保存権から分離。保存も不明なら事前承認した有限storage-only holdとその全コピー期限でレビュー/削除を判断。内部レビュー期限だけで削除しない。
- unapproved / fixed_days / until_revokedを明示し、null単独・継続保存根拠なし・owner承認なし・有限holdなしはHTTP/DB/R2前に拒否。明示許諾による5年/10年超の履歴、同価格lineage、短期証拠削除後の履歴保持を検証。
- 明示保存権denied/expired、元の保存権終了、固定期限、適用される削除要求は削除。後から短い削除期限が届いても元マーカー日時は保ち、期限を延長しない。Time Travelより短い期限はdeadline missedと報告。
- D1巻戻し後もR2マーカーでread拒否・再削除。旧0007とデータ入り0008→0009で期限/行/FK/immutable triggerを維持。無根拠のnull期限はDB CHECKでも拒否。
- 判定根拠・現在権利・状態・期限・次の対応、証拠の期限/削除と再検証の可否をimmutable台帳へ記録。R2実在/hash未検証をverified扱いしない。

| チェック | 結果 |
|---|---|
| pnpm install --frozen-lockfile | 成功、package/lockfile差分なし |
| pnpm check | format / TypeScript / 公開境界成功 |
| pnpm test（下記Windowsオプション） | **29 files / 291 tests成功、376.39秒**。新しい状態/期限なし保持の10件と既存回帰試験を含む |
| pnpm test:runtime | workerdのFX/AI・復旧・operations、GPU1,051件/22page、Models50/250/1,000件すべて成功。外部HTTPなし |
| pnpm build | Collector/APIのdeploy --dry-run成功、実deployなし |
| pnpm preflight | offline、static_valid / ready=true、blockers=[]、network_performed=false。これは本branchの静的結果で、本番drift解消ではない |
| schema再生成 | research.schema.jsonの再生成hash一致、source.schema.json / OpenAPI差分なし |
| 差分検査 | git diff --check成功。active source/grant、deployment、Wrangler、Collector dispatch、公開API、旧0001〜0008、public migration、依存package変更なし |
| GitHub CI | この追加commitの結果とrun URLは[PR #16の検証欄](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/pull/16)へ記録。過去commitの成功を流用しない |

Highreso/GPUSOROBANとRebroは公式feed・権利・継続保管/有限hold・認証/費用のowner確認待ち。EIA/JEPXはcritical path外。5年容量/80%は参考値へ下げ、archive/DB分割/新DB/費用追加調査なし。本番統合・自動retention・live smoke・remote migration/deployは未実行。[最新の状態と有効化手順](research-long-retention-20261016.md)を適用し、以下は過去の検証履歴として残す。

## 2026-10-16 PR #16追加指示の検証（履歴）

前回の実装commitは`9092ec0`、納品記録は`3369118`。今回の比較基準は後者。新sourceのlive観測追加0、本番変更0、新しい権利grant0。以下は全てローカルsyntheticで、長期運転やCloudflare本番Time Travelの実証ではない。

- research保持schemaに研究目標と許諾済み期間を分離し、未承認proposalのnormalized / Time Travelをnullにした。public schema/OpenAPIとactive sourceを変更していない。
- 追加0008で保持snapshotと全コピー期限、config版をimmutableにする。既存0007行へ長期grantを与えず、旧90日期限をそのまま維持してreview待ちにするmigrationを検証。
- 1095/1825日の直前・一致時刻、証拠7日削除後・91日以降の読取、複数年の同価格再観測/価格改定と旧値の保持を検証。
- policy更新には過去config hashの明示承認を要求。更新による過去runの期限延長を拒否し、保持期間短縮、証拠だけの期間短縮、取得停止と履歴利用継続、terms失効を分離。
- source取消しとrun削除のR2 control記録をD1復元の外に残し、古い権利・suspended=0・元期限内のrunを復元しても読取拒否・再削除。lease中の取消し、R2 control書込み障害時の現行D1停止と再試行を確認。
- backup window増加/削除遅延は残存期限・deadline missedで返す。Time Travelのbackupを即時消したとは扱わない。実R2 lifecycle、5年最大件数のCPU/rows read/writeは未検証。
- DCのobserved_at・証拠参照・内部policy更新だけを内容改定に数えず、発表内容の変更を別hashで検出する合成試験を追加。

| チェック | 10/16の結果 |
|---|---|
| pnpm install --frozen-lockfile | 成功、package/lockfile差分なし |
| pnpm check | format / TypeScript / 公開境界すべて成功 |
| pnpm test（下記Windowsオプション） | **28 files / 281 tests成功、353.19秒**。新しい長期保持12件を含むresearch計33件。Git safe.directoryは対象コマンド環境内のみ |
| pnpm test:runtime | workerdの既存FX/AI・schema復旧・operations、GPU 1,051件/22page、Models 50/250/1,000件が成功。外部HTTPなし |
| pnpm build | Collector/APIのdeploy --dry-run成功。実deployなし |
| pnpm preflight | offline、static_valid / ready=true、blockers=[]、network_performed=false。これは現行branchの静的検査で、本番との差分が解消された意味ではない |
| node scripts/generate.mjs | research.schema.jsonを更新、再生成hash一致。source.schema.json / OpenAPI差分なし |
| node scripts/research-retention-cost.mjs | 3/5年シナリオをローカル計算、実usage・請求額ではない |
| 変更範囲 | active source、deployment、Wrangler、Collector dispatch、Public/Admin、過去0001〜0007、public migration、依存package変更なし |
| GitHub CI | この追加コミットのrun URL・結果は[PR #16の検証欄](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/pull/16)へ記録。旧commitの成功を新commitへ流用しない |

長期費用/上位候補/次の2件/KPI/main統合計画は[長期設計](research-long-retention-20261016.md)と[比較台帳](source-expansion-20261015.md)を参照。Cloudflare Free plan適合、数十万行での検索性能、実R2 lifecycleやTime Travelを検証した意味ではない。

## 2026-10-15 初回検証（履歴）

| チェック | 結果 |
|---|---|
| pnpm install --frozen-lockfile | 成功、lockfile変更なし |
| pnpm check | format / TypeScript / 公開境界 / active設定の検査成功 |
| 新規contract/domain/storage試験（21件全通過） | EIA/JEPX projection、9権限、null license、URL/auth/LLM/export拒否、国内GPU/DC、D1/R2復旧・保持をsyntheticで検証 |
| pnpm test 全体 | Windowsのthreads poolで27 files / 269 tests全通過（331秒）。下記の実行オプションを使用 |
| GitHub CI | 実装commit `9092ec0` の[validate run 38726853846](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/actions/runs/38726853846)が成功。標準のpnpm test、check、offline preflight、runtime、build dry-run、schema生成・差分検査を含む |
| pnpm test:runtime | workerdで既存FX/AI、schema recovery、operations、GPU1,051件/22page、Models50/250/1,000件の処理・replay・公開境界が成功。外部HTTPなし |
| pnpm build | Collector/APIともdeploy --dry-runで成功。Upload表示はbundleサイズであり実deployではない |
| pnpm preflight | mode=offline / static_valid=true / ready=true / blockers=[] / network_performed=false。新research proposalは対象外で、実装した専用schema/gate試験で検査 |
| node scripts/generate.mjs | 既存source schema/OpenAPIは同一。research.schema.jsonを追加 |
| 既存本番設定・migration | config/sources / deployment / wrangler / 0001〜0006 / public API実装の変更0をdiff確認 |

Windowsサンドボックス内ではesbuildが親ディレクトリの読み取り制限で失敗したため、同じローカルschema/runtime/dry-runを必要な実行権限で再実行した。標準の全体testはworker進行を確認できず中断した。その後の実行では268件が通過し、admin-releaseの1件がcheckout所有者と実行ユーザーの違いによるGitのownership検査で失敗した。最終実行では当該checkoutだけをsafe.directoryに指定する一時的なGIT_CONFIG環境変数を子プロセスへ渡し、次のコマンドで27 files / 269 testsが全通過した。Gitのglobal設定とリポジトリのtest設定は変更していない。

```text
pnpm test --pool=threads --maxWorkers=4 --fileParallelism=true --testTimeout=120000 --hookTimeout=120000 --reporter=verbose
```

GitHub CIでは標準のpnpm testをそのまま実行し成功した。Windows用の実行オプションは本番やCIの設定変更ではない。

## 試験が保証する範囲

- 既存のpopulated private DBへ0007を追加して既存行・FKを維持。public DBにresearch tableがない。0001等のSQLは変更しない。
- unknown rightsはHTTP/R2/DB登録前に拒否。license_url=nullでも適用可能な合成grant/レビューがあればPrivate成功。public/LLM/raw exportは拒否。
- EIAは範囲/単位/型/総件数/順序を検査。月を架空の日付へ変換せず、request metadataを除外。認証仕様不一致はHTTP前に拒否。
- JEPXはJST30分48枠、年度境界、null/0/負値、重複/部分日/空日/header変更/入力上限を区別。実CSVを取得したことは意味しない。
- R2 capture後のSQL途中障害、lease競合、20文batch、partial非表示、checkpoint復旧、同日重複、翌日同価格、訂正の追記を確認。
- HTTP失敗はpartialであり正常0件ではない。429のretry_atと同pageの永続試行予算を検査。source/UTC日ごとの一意runでquery変更による上限回避を拒否。
- evidence expiry（未checkpointのcapture含む）、source revoke後の読取遮断、段階削除、terms変更/期限/backup込み保持のgateを確認。Cloudflare本番のR2 lifecycleやTime Travel削除を検証したものではない。
- 国内GPUの4価格種別、取引証拠、month精度、unknown SKU/region、points/minutes、ラック、比較不適合、not_seenを検査。大幅な同条件変化はwarning付き有効観測。
- DC採択をIT稼働にしない。project/site/phase、3水指標、hash付きrevisionと異なる案件のlineage拒否を検査。実資料の自動抽出能力を示さない。

## source別の状態

| source | 実装済み | 合成検証 | 今回の実データ取得 | 本番稼働 | 公開可能性 | 待ち事項 |
|---|---|---|---|---|---|---|
| EIA CO/IND | parser/config/Private保存・改定/recovery。transportは明示拒否 | 済 | なし | 未開始 | 新grantなし、非公開 | URLキー制約の解消、必要ならキー、owner/wire/retention承認、本番統合 |
| JEPX Tokyo | parser/固定request/config/Private保存・coverage | 済 | なし | 未開始 | 新grantなし、非公開 | 自動履歴利用の適用、実wire/encoding、owner/retention承認、本番統合 |
| Highreso | 国内GPU受入・比較契約 | 済 | なし | この追加経路は未開始 | 未確認、非公開 | 正規feed・利用許諾・条件・費用 |
| さくらDOK | 既存adapter保持、国内GPU受入契約追加 | 済 | なし | 今回新規接続なし | 未確認、非公開 | 既存Secretの使用許可とは別に保存用途の承認、個別live確認 |
| Rebro | 4価格種別・選別公開事例の受入契約 | 済、実価格なし | なし、非公開情報にも未接続 | 未開始 | 未確認、非公開 | feed/保存利用許諾・取引の意味・coverage |
| METI DC | 既存DC schema再利用、開示revision/水の最小モデル | 済 | なし、一次ページ403は回避せず | 未開始 | 未確認、非公開 | 一次本文/利用条件・取得契約、collector/保存実装 |
| OCCTO / メモリ / ラボ / Physical AI | 実査・優先順位・契約候補 | 今回新collector試験なし | なし | 追加なし | source別未承認 | 台帳に記載した権利/費用/仕様 |
| ECB / Models.dev | 既存実装を維持 | 既存unit/runtimeで回帰検証 | 今回live smokeなし | 既存運転を維持、今回最新行は独立再確認せず | 既存承認scopeのみ | 本タスクによる変更なし |
| Price of Compute | 既存実装/本番Private設定を維持 | 既存回帰試験 | 今回live smokeなし | Issueのowner申告と配信commit/configが根拠。直近観測は未監査 | public grantへ昇格せず | mainとのdriftを維持・記録 |
| OpenRouter / CCIR | 調査・参照のみ | 新収集なし | なし | 新規接続なし | 未解決のまま | 利用条件の適用確認 |
| GetDeploying | 公開CC BYファイルの外部参照判断 | collectorなし | file取得なし | 新収集なし | 当該ファイルの条件付き利用根拠あり、project grantなし | collector不要と判断 |

今回liveで確認したのは**公式ドキュメント/利用条件/機械取得仕様の調査とCloudflare Worker metadata**。電力/GPU/企業実績の観測成功ではない。EIA/JEPXを含む新sourceについて「自動収集稼働中」「公開可能」と報告しない。

本番deploy、remote migration、source grant、Secret、Cron、通知、外部問い合わせ、有料契約、main mergeは実行していない。個別承認条件と次の手順は[runbook](private-research-runbook.md)を参照。
