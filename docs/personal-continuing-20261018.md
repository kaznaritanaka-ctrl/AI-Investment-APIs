# 個人研究v2: 継続保存・契約更新・バックアップ／復元

2026-10-18。所有者が承認した範囲は実装とローカルsynthetic検証。実収集、実契約の承認、権利grant変更、本番deploy、remote migration、実鍵作成、タスク登録は実施しない。

## 保存の意味と実装範囲

目標は10年後にも価値を持つ時系列。正規化履歴に30日・3650日等の年齢による削除期限を設けない。v2は明示承認された `owner_continuing` と保存根拠・目的・所有者判断参照を要求し、提供者許諾は `unconfirmed`、元の3権限は `review_required` のままにする。未承認draftやnullだけでは実行できない。

既存v1の有限期限と取得時snapshotは変更しない。0012は前進migrationで既存行・外部キー・immutable triggerを維持する。通常researchのuntil_revokedへ例外を昇格させず、Collector/Public APIにも組み込まない。

| 対象 | v2の処理 |
|---|---|
| 正規化履歴 | 元の観測時刻、decimal、条件、不明理由、source/method、run/契約版を保存。古さや容量節約を削除理由にしない |
| 短期投影証拠 | 元のcapture時刻から独立した期限。raw HTMLは保存しない。期限後も正規化履歴を残す |
| 取得・分析review | 期限切れは取得/readを停止。保存根拠が有効なら履歴とバックアップ保守は継続 |
| 保存根拠がunknown | 取得/read、新規バックアップ・復元を停止。現存履歴は自動削除せず要レビュー。無期限許可とは表示しない |
| 明示保存終了・取消し | 履歴と証拠を削除対象にし、保守tickで管理対象の暗号化コピーも除去。期限の延期・取消し解除・旧コピーによる復活は拒否 |
| バックアップ世代 | 例は毎日作成、7日で世代交代、最大8個。この7日は正規化履歴の保存期間ではない |

**初回1試行という取得範囲は維持する。** 各社最大48観測、最大3 GET、日次予算リセットなし。更新は既存runだけに適用し、新しい収集を承認しない。日次の新規観測を積み重ねる個人例外の契約・再観測/訂正/欠測は後続の独立実装・承認範囲。今回の継続保存対応を「GPU日次収集中」と表示しない。

## 契約更新

`personal-review-v1` を追記する。元の契約hash、直前review hash、連番、実際の承認時刻、過去観測への適用をレビューした参照、規約版/根拠、分析期限、次回review、保存根拠、`existing_run_only` / `new_collection=false` が必須。

現在のheadをETag条件付きで更新し、競合は拒否する。レビュー本文はhash付きで不変に保存し、D1へ監査記録を追記する。既存DBの監査連番より古いheadも拒否する。復元した空DBは外部の現在headを基準に最新判断を再適用する。レビューの人間判断を自動生成したり、期限だけ延長したりしない。

設定済みの `storage_ends_at` は短縮のみ可能。取消し・削除済みのrunはレビューで復活できない。Highreso国内旧版の初回取得期限は既存通り。後日のレビューは過去履歴の分析・保存判断であり、新版規約による新規取得許可ではない。

## コピーと復元の構成

- primary: ローカルD1と期限付き投影証拠。
- vault/control: 現在の契約レビュー、試行消費、capture hash、停止・取消し・削除、バックアップmanifest。primaryから独立した保存場所。
- vault/copies: AES-256-GCM暗号化snapshot。契約・鍵IDを認証対象に含め、改ざん/誤鍵/別sourceを拒否。
- vault/status.json: 件数、最終backup、最終復元検証、review連番などのmetadataのみ。

snapshotは固定列の正規化観測と出典・取得時契約/runだけ。SQLプログラム、任意テーブル、raw/短期証拠、鍵、過去のcontrolは含まない。最大48行・512 KiB、SQL batchは最大20文。leaseで取得と競合を防ぎ、未完了ファイルは次回掃除する。

復元先は新しい空のstaging DBに限定する。現在control、manifest、暗号認証、hash、出典/契約/取得時刻、現在の取消し・保存期限を検査する。元の観測値・時刻を変更しない。全行検証までpartial、完了時だけcompleteとする。中断したstagingはread不可で、新しい空の場所へ再試行する。現在primaryへの上書きや自動切替はしない。

既定案では毎日、最新コピーを別のメモリ上DBへ実際に復元して行一致を確認する。取得ネットワークは不要。鍵が失われても、現在controlがあれば期限切れコピー・取消し対象コピーの除去は可能。鍵なしで復号・復元ができるという意味ではない。

**保全上の限界:** パスが別でも同一物理ディスクなら媒体障害への耐性はない。vault/controlは復元の現在性を支えるため、古いsnapshotから復元しない。現在controlの消失/巻戻りやvaultとprimaryの同時故障を、この単一vault実装だけで回復できるとは主張しない。独立媒体、current controlの保全、鍵の別管理と回復方法を初回設定で確認する必要がある。DPAPIは同じWindows利用者/端末での自動読出しを助けるが、端末喪失時の鍵エスクローの代わりではない。未レビューの同期/NAS/システムバックアップを勝手に作らない。

短期証拠とraw HTMLを復元しないため、将来元ページ全体を再解析できるとは主張しない。ファイル/行DELETEも媒体上の完全消去の証明ではない。

## 日々の手作業を要求しない運用

`personal-automation.mjs once` はsourceごとに保守、期限付きコピー整理、必要時のbackup、復元ドリルを行う。片方の鍵欠落・破損・契約停止で他方を止めない。戻り値は状態と件数のみ、blockedはexit 2。`watch` は定期tickで状態変化のみ表示する。いずれも取得HTTPや自動承認を行わない。

Windows用の `plan` は5分間隔（設定可）・ログオン時・StartWhenAvailable・重複起動拒否・非表示・最小権限の**disabled Task XML**を返す。登録しない。`personal-task.ps1` は承認済みmanifestだけを読み、`personal-key.ps1` でDPAPI CurrentUser暗号化鍵をprocess環境へ読み込む。終了後は環境変数を消す。鍵を引数・出力・Gitへ含めず、ユーザー環境へ永続平文設定しない。保護鍵ファイルの作成自体はこのコードを読んだだけでは実行されない。

タスクはInteractiveTokenのためログアウト/PC停止中は動かない。次回ログオン後に再開し、期限超過を報告する。停止中の削除・backup SLAは保証しない。常時稼働が必要なら承認済みのホスト/実行ID設計が必要。強制終了で残ったmaintenance.lockは自動破棄しない。実プロセス不在を確認して例外復旧する。通常終了・再起動後の継続と多重起動排他をsynthetic検証する。

毎日の価格転記、CSV移動、backupコマンドや鍵入力は不要。初期設定、規約/契約の判断、障害対応は例外作業として残す。通知先設定や外部通知は今回追加しない。Task Schedulerの終了コードとstatusを監視対象にする設計であり、無人の外部アラートまで稼働済みではない。

## 初回設定で確定するもの（未承認・未実施）

1. sourceごとの実行/継続保存判断、適用規約とrobotsレビュー、初回取得窓、分析/再review期限。提供者許諾未確認を明記する。
2. primary/vault/保護鍵ファイルの実パスとアクセス権、独立媒体、同期/コピー台帳、停止中の扱い、鍵の災害復旧手段。
3. source別の実鍵を安全に生成し、DPAPI CurrentUserで保護して対象利用者のみのACLで保存する。平文はGit/ログ/チャットへ出さない。回復用鍵の保管先は別途レビューし、vault自身へ平文で置かない。
4. 承認済み実契約とautomation manifestをGit外へ保存。Nodeの実行パス/PATH、依存関係、タスクの実行ID、復号と復元ドリルを同じIDで確認する。
5. task XMLをレビューして登録・有効化する。今回はXMLの生成コードまでで、実タスクは存在しない。

manifestの必須項目は `version=personal-automation-v1`、`status=approved_for_local_operation`、実際の `owner_setup_approval_ref`、`enabled=true`、`interval_seconds`、source別 `source_id/contract_path/primary_path/vault_path/backup_key_env/protected_key_path`。すべてローカル絶対パス。公開draftはnull/未承認を維持する。

承認後の実行例（以下は説明だけで実行していない）:

```powershell
node scripts/personal-automation.mjs plan --config <approved-automation.json>
node scripts/personal-automation.mjs init --config <approved-automation.json> --source highreso_public
node scripts/personal-automation.mjs once --config <approved-automation.json>
node scripts/personal-automation.mjs renew --config <approved-automation.json> --source highreso_public --review <approved-historical-review.json>
node scripts/personal-automation.mjs stop --config <approved-automation.json> --source highreso_public --reason-ref <owner-decision-reference>
node scripts/personal-automation.mjs revoke --config <approved-automation.json> --source highreso_public --reason-ref <revocation-reference>
node scripts/personal-automation.mjs restore --config <approved-automation.json> --source highreso_public --snapshot <snapshot-sha256> --destination <new-empty-local-directory>
```

init/backup/restoreでは当該processへ保護鍵を読み込む。定期実行はwrapperが行う。初回取得は別の `collect ... --allow-network` を明示承認後に1回だけ実行する。例の記載や保守設定の承認を取得承認に流用しない。

## 検証と到達点

syntheticのみ。11年後へ時計を進めても両sourceの履歴を維持し、追加reviewで元の観測をreadできること、v1期限維持、0011から0012への旧DB移行、暗号化/改ざん/鍵違い、世代整理、取消し後復元拒否、空DB復元、partial中断、control巻戻り検出、source障害分離、再起動、disabledタスク、Windows DPAPIを検証対象にした。

workerdで2source / 6 mocked GET / 6観測のv2保存・snapshot・11年後レビュー更新に成功。既存のv1 runtimeとGPU 1,051件・Models.dev 50/250/1,000モデルのsynthetic runtimeも成功。最終のcheck/test/CI結果は納品時に追記する。時計進行は10年間の実稼働・媒体耐久性・実規約確認の証明ではない。

live検証0、新sourceの実観測0、本番反映0。権利grant、disabled、Wrangler、Cron、Adminは変更しない。このbranchは古いmainに基づくstacked Draft PRなので、そのまま本番へdeployしない。
