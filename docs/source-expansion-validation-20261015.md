# Issue #15 検証・納品記録

対象: main `1d42d981cb93c5185ecba8cf53b108c496d91cf7` を基にした `codex/source-expansion-private-research-20261015`。Windows / Node 24.19.0 / pnpm 11.19.0 / Wrangler 4.140.0。通常のtest/buildに実ソースHTTPは含めない。

## 検証

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
