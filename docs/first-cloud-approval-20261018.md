# 初回Cloud実行の準備・所有者承認票

2026-10-21 PR #19統合追記: [新しい候補と承認差分](pr19-integration-20261021.md)。PR #18の修正を取り込み、候補migrationは旧8本に0015を加えた9本となりました。以下の8本/hash/journalは10/18の履歴として不変であり、この新候補をそのまま実行する承認票ではありません。実行前に追加hash・直前journal・最終artifactを含む承認票の確定が必要です。remote migrationは未実施。

2026-10-19レビュー追記: [最新レビュー・残る承認事項](pr19-review-20261019.md)を参照。NASのcontainer再作成に対応するLinux排他、CLI同時起動の修正、[personal専用image/CI](../deploy/personal-nas/README.md)を追加した。以下の「専用image未実装/未検証」は10/18の履歴であり、最新のsynthetic検証結果はレビュー記録とPRを正本とする。実NAS受入・本番操作の承認は未実施。

2026-10-19追記: 所有者はこの準備資料・停止状態の設定ひな形のcommit/push、PR #19更新、CI確認を承認した。本番操作の承認ではない。当該コミットのCI結果は[PR #19](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/pull/19)に記録する。以下の監査時刻・検証記録は2026-10-18時点の事実として維持する。

2026-10-18。PR #19のコード候補は `8cb6b8bd50f25696eaacdb433a062f22b41453b1`。この資料は**非実行のレビュー用**であり、承認・日時・鍵を代入して本番へ自動反映するものではない。承認不要のmetadata照会、契約draft、停止状態の設定案、dry-runを準備した。main、Worker、D1 schema、R2、通常source grant、実鍵、NASには書込みを行っていない。

## 今回完了した準備

- [本番read-only記録](personal-execution-20261018/first-cloud-readonly-audit.json): 13:53〜13:54 UTC（22:53〜22:54 JST）。本番Collectorは `cbf5a90d-9ab9-40b0-8847-eb0149f20e58` / 100%、Git annotationは `0abf2b6`。既存3 Cronとbindingsは従来どおり。NAS_EXPORT / NAS_HEALTH / PERSONAL_*は存在しない。
- private D1 `f9239883-9929-4137-8079-5a03d9a8beb2` のjournalは0001/2/3/5/6のみ。research系テーブルなし。固定SELECT 2本はともにrows_written=0 / changed_db=false。0007〜0014の8本が未適用。
- EVIDENCE `ai-investment-evidence-private` はr2.dev無効・Custom Domainなし。既存prefixのlifecycleは不変。`ai-investment`を含むbucket一覧ではoriginのみを確認した。無関係なbucketの不存在までは証明しない。
- D1 current bookmarkはGET成功。subscription APIは現在のMCP権限では認証エラー。権限を追加していない。GitのPaid/30日と2026-09-30の所有者Dashboard確認refは保持するが、**今回30日分の実復旧窓やrestore成功を確認したわけではない**。
- source設定を変えず、実在するaccount/private DB/originだけを埋めた初回契約draftを2社分作成。実行承認・時刻・fingerprint・実鍵IDはnullのまま。新draftはruntime schemaで拒否されることを確認した。
- NASの5分ポーリング方針に反していた旧systemdひな形のhourlyを修正。TOS向けの非実行Compose案とruntime draftを追加。実機にインストールしていない。
- D0（個人研究4flagが全てfalse）のCollector設定をGit対象外の作業領域でdry-run。現行Wranglerは変更していない。

機械可読の[統合承認票](personal-execution-20261018/first-cloud-owner-review.json)には、8本のmigrationの**全SHA-256**、source draftのファイルhash、現在version、phase別差分、未確定欄を記録した。draftのファイルhashは承認済み実行契約のcanonical hashではない。

## 承認を分ける単位

非公開の個人研究例外とowner_continuing長期保存は**承認済みで再承認不要**。provider permissionはunconfirmedのまま。以下は実際の設定／実行に対する承認で、返信待ちや公開再配布権の確認を私的例外の追加条件にしない。

| ID    | 承認対象の具体案                                                                                                              | 承認前に埋める値・受入条件                                                        | 影響範囲                                                           |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| C1    | 初回はHighresoのみを推奨。Rebroは独立した契約で後続開始可。method v2、sourceごと1試行・固定3 GET以下・15秒/GET・内部retryなし | source選択、固定規約/robotsのレビュー根拠、analysis/review期限、source別契約hash  | まだflagをONにしない。通常grant・公開APIは不変                     |
| S1    | 新しい非公開export候補名 `ai-investment-personal-export-private`。Standard、Object Read専用credentialを当該bucketだけへ限定   | bucket名の最終確定、実作成後の非公開設定、IAM拒否試験、lifecycle/copy台帳         | 専用bucketとNAS用読取credential。元EVIDENCEへNAS権限を付与しない   |
| N1    | TerraMaster F6-424 / TOS 7。内蔵Terminalで初期設定、SSH無効を維持。専用非root identityで5分ごとの自動保守                     | 実UID/GID・保存/鍵/復元パス、実行方式、暗号化と回復鍵、TOS ACL、synthetic復元受入 | 専用領域・ジョブ・鍵だけ。既存NAS backupや共有領域を置換しない     |
| M1    | private DBに0007〜0014の8本を順序適用。0013の日次schemaを含めるが日次取得はOFF                                                | 承認票の8hash、直前journal一致、最新bookmark、実保持窓、作業時間、前進修正方針    | private research系schema。public DB、0004、既存履歴は変更対象外    |
| D0    | `8cb6b8b` のCollectorコードを個人研究4flag全OFFで反映                                                                         | 採用commit、最終artifact hash、metadata-onlyの動作受入、戻すversion               | Collectorだけ。API/Admin・既存source・Cron・DNS/Accessは不変       |
| D1    | 専用NAS_EXPORTと初回contract/transport pinを追加し、初回maintenanceだけON                                                     | S1/N1/M1/D0受入、source別契約、実resource pin、実IAM証跡                          | 保守/保持/exportは動作するが価格ページは取得しない。新しいCronなし |
| E1/E2 | 選択sourceの初回flag ON→受入後OFF。初回maintenanceはONを維持                                                                  | 正確なUTC/JST窓、最終契約hash、NAS受入、CPU/容量確認方法                          | sourceごと最大1試行。日次化・別sourceへの拡大は含まない            |

S1/N1を先に準備・受入し、M1→D0→D1→E1の順を推奨する。S1/N1の実物確認に失敗したら実行日時を確定しない。M1は8本全体で原子的に戻るとは限らず、途中まで適用された場合はjournalを読んで停止する。D0だけ先に行う場合でも、未適用schemaを使うflagを有効にしない。

## 実行契約と取得窓

新しい [Highreso draft](personal-execution-20261018/highreso_public.cloud-first-run-draft.json) と [Rebro draft](personal-execution-20261018/rebro_public.cloud-first-run-draft.json) が今回の準備対象。旧local/method v1 draftは使用しない。embedded source configとそのcanonical SHA-256、通常3権利review_required、enabled=falseを保持する。

- Highreso: 国内個人・奈良県は所有者申告済み。A100/H100の明記1GPU cohort、時間/月額48観測上限。前回のDOM確認ではA100 24 instance/48枠、H100該当0。これは構造確認であり今回の実取得件数ではない。追加行・DOM変化で48を超えると全件停止し、切捨てない。
- Rebro: A100/H100の選別された公開買取事例。月は約定日時ではなく、件数は市場全体の在庫ではない。別サイト規約の未特定と第10条の適用未確定を残す。会員登録・個別契約の有無を推測しない。
- 規約/robotsの候補hashは既存metadataを**参照だけ**にする。ownerの例外承認をprovider許諾やrobots許可に変換しない。実行前の限定した規約/robots再確認を別途明示し、価格ページの先行取得はしない。今回提供者へのHTTPは0回。
- 保存は正規化履歴owner_continuing・年齢TTLなし、投影証拠7日、raw HTML archiveなし、暗号化backup世代90日。初回backupは1日ごと・復元確認24時間・最大96世代。90日も10年も履歴の削除期限ではない。review期限切れは取得/read停止で、保持終了と分ける。
- 初回のanalysis/review期限案はHighresoの旧国内版境界まで、Rebroは開始から30日以内。後日の歴史利用reviewはappend-onlyで更新し、通常の日次作業を要求しない。規約改定・失敗・鍵回復等は例外レビュー。

取得窓は**NAS受入後の指定日 JST 02:50〜翌02:50（24時間）**を提案する。既存の継続処理03:00〜08:55を1回含む。例は **2026-10-22 02:50〜10-23 02:50 JST / 2026-10-21 17:50〜10-22 17:50 UTC**。日付例は未承認で、実際のstart/endはnull。承認が遅れたら自動延長・遡及実行しない。

初回保守は既存Models/GPU処理のない枠に限るため、03:00開始を保証しない。枠を得られなければ未実行と報告し、既存ソースを停止して空けない。**Highreso旧国内版の最終終了境界は2026-10-31 15:00 UTC（11/1 00:00 JST）**。越える場合は新版の適用評価・別hash・別契約が必要で、旧契約の期限を伸ばさない。

contractの`approved_at`、execution/risk ref、store/destination/keyのmetadata ID、Cloud/NAS受入ref、canonical contract hashは実際の確認・承認後に確定する。承認済み個人例外の根拠は再利用し、承認していない本番操作のrefを創作しない。D1用30日は既存Git上の値に過ぎず、実保持窓の再確認前に新contractへ代入しない。

## export／TOS 7の具体案

TOS内蔵TerminalのTANAKAはUID 0と申告された。sudoやSSHは不要。自動保守プロセスをUID 0で常駐させず、**新しい専用identity（名前案ai-research-backup、実UID/GIDは未確定）**を用意する。1000/10001等を実UIDと仮定しない。所有者管理者が初期設定を行う権限と、日常ジョブの権限を分ける。

[TOS Container Manager](https://help.terra-master.com/docs/TOS7/application/container-manager)と[Task Scheduler](https://help.terra-master.com/docs/TOS7/controlpanel/general-settings/scheduled-tasks/)は公式に提供される。**このNASでのインストール・Docker Compose・選択ユーザー・5分指定の可用性はまだ実機未確認**。systemdがあると仮定せず、まずTOS標準機能を候補とする。次の読取コマンドは将来の内蔵Terminalでの能力確認用で、今回は実行していない。

```sh
id
uname -m
command -v docker
docker version --format '{{.Server.Version}}'
docker compose version
command -v node
node --version
```

commandが無ければ未導入と記録し、その場でinstallを始めない。共有の実パス・空き容量・snapshot/sync対象・TOS ACLは所有者の確認対象。LAN IP、管理URL、管理者の認証情報を実行設定やGitへ転記する必要はない。

| 対象                 | 配置・権限案                                                                      | 未確定                                      |
| -------------------- | --------------------------------------------------------------------------------- | ------------------------------------------- |
| code/runtime         | 固定した候補コード・依存lock・Node 24・検証済みage。書込み不可                    | 実配置／personal専用image digest            |
| backup root          | personal初回専用、他プロジェクトと別領域。ciphertext/control/indexのみ永続化      | 実共有path、専用UID/GID、暗号化volume、容量 |
| R2 credential        | 専用export bucketだけのObject Read。専用identityが読める別ファイル、backup root外 | 実file path、TOS ACL、bucket名、IAM拒否試験 |
| age restore identity | credential/rootと役割を分け、0600相当の別file。無人復元確認に必要                 | 実path、回復コピーの暗号化保管と紛失時手順  |
| 一時復元先           | 空stagingまたはtmpfs、原本DBを上書きしない                                        | 実path/容量、終了後清掃と再起動試験         |
| コピー台帳           | NAS snapshot/recycle/sync/クラウド複製の有無も含め、取消し時の削除先を列挙        | 実際の設定と回復用コピーの所在              |

[非実行runtime draft](personal-execution-20261018/nas-initial-runtime.draft.json)はenabled=false、鍵とpathはnull。[Composeひな形](personal-execution-20261018/tos7-personal.compose.example.txt)は入口port/host network/Docker socketなし、read-only rootfs、非root、cap_drop、再起動loopなしのone-shot案。**個人研究clientを含む専用imageのbuild/コンテナ検証は未完了**。既存CIで成功した`deploy/nas-backup`は別のbackup処理で、personal runtimeのコンテナ受入証拠にはしない。Docker/Nodeの実機可用性が確定してから最終パッケージとdigestを固定する。

初回pollは5分、世代の生成と復元検査は24時間。TOS schedulerから固定one-shotを実行する。ジョブのsource leaseで重複を防ぐが、ジョブが5分以上かかる場合の重複・タイムアウト・再起動後追従も受入対象。毎日Terminalを開く手順は設けない。初回の定期保守はデータ取得を行わず、Cloudの現在制御が古い／取得不能なら採用・復元を停止する。日次用NAS_HEALTH・署名Secret・外部通知は別承認で、今回設定しない。

R2のbucket限定Object Readは[公式権限](https://developers.cloudflare.com/r2/api/tokens/)に基づく。最終bucketを作成した後、専用synthetic objectに限ってexport GET成功、origin GET拒否、export PUT/DELETE拒否を確認する。PUT/DELETEの拒否試験も実環境のwrite要求なのでS1で明示承認後にのみ行う。NASのアプリprefix検査をIAMと同一視しない。元EVIDENCEやD1の資格情報は配らない。

## migration／deployの差分と手順

対象accountは `0f9bb71bb987011462a91596f7cc9e6f`、DBは `ai-investment-private / f9239883-9929-4137-8079-5a03d9a8beb2`。8ファイルは承認JSONの`migration.files`を正本として照合する。0009/0012にはresearchテーブルのDROP/再構成があり、単純CREATEだけと説明しない。0004を追加・改名して空番を埋めない。0013を含めても日次flagは全OFF。

作業時間案はJST 10:00〜17:00。既存Cron窓の外でも、実行中処理・production version・journal・対象hashを直前に確認する。[D1 migration](https://developers.cloudflare.com/d1/reference/migrations/)は未適用ファイルを適用するため、**差分が承認8本と一致しなければ中止**。次は将来の承認後に用いるコマンドであり、今回実行したのはhelpとdry-runだけ。

```powershell
# 読取確認（固定した候補checkoutで、適用直前に再実行）
pnpm exec wrangler d1 migrations list ai-investment-private --remote --config wrangler.collector.jsonc
pnpm exec wrangler d1 time-travel info ai-investment-private --config wrangler.collector.jsonc

# M1の明示承認後だけ。0007〜0014/hash/journal一致が前提
pnpm exec wrangler d1 migrations apply ai-investment-private --remote --config wrangler.collector.jsonc
```

Wrangler 4.140.0のhelpで構文を確認済み。非対話環境ではCLI確認を省略し得るため、CLI promptを承認境界にしない。public DBのapplyやDB本文exportはこの作業に含めない。

D0は追加varsが次の4つ（すべてfalse）だけ。既存COLLECTION_ENABLED=true、AGENT_ENABLED=false、CPU 5000、互換日付、3 Cron、private/public D1、EVIDENCE、HTTP入口なしを維持する。元Wranglerへの反映は未実施。

```json
{
  "PERSONAL_MAINTENANCE_ENABLED": "false",
  "PERSONAL_INITIAL_COLLECTION_ENABLED": "false",
  "PERSONAL_DAILY_MAINTENANCE_ENABLED": "false",
  "PERSONAL_DAILY_COLLECTION_ENABLED": "false"
}
```

D1はNAS_EXPORTを追加し、PERSONAL_CLOUD_PINS（account/private DB/originと**選択sourceだけ**の最終contract hash）とPERSONAL_EXPORT_PINS（origin/export/health=nullと実IAM review ref）を設定して初回maintenanceだけtrueへ。2社をpinに入れたまま初回flagをONにすると両方が対象になるので、初回Highreso案ではHighresoのみを選ぶ。dailyはOFF。runtime contract/controlをR2へ登録する操作も、本番writeとしてD1/E1の承認範囲に明記する。

その後E1の確定窓で初回flagをtrue、受入後falseへ戻す。新規取得は窓終了後も停止するため、OFFへ戻す遅れが試行回数を増やすことはない。設定変更のための各deployも承認対象で、CLI一括スクリプトやCI自動deployは作らない。

受入は既存ECB/Models/PoCのsource状態・新version・run/attempt/coverage・manifest/gate・NAS ciphertext/空staging復元のmetadataで確認する。成功件数だけでraw/公開漏れなしやCPU余裕を証明したことにしない。実CPUが5秒制限内か、Cloud/R2操作量、異常時延期を確認し、超過なら初回取得を停止して調査する。

## rollbackと停止

取得前のD0不具合は、直前再確認と別承認のうえ `cbf5a90d-9ab9-40b0-8847-eb0149f20e58` へ戻す候補を用意する。[Workers rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)はD1/R2データを巻き戻さない。

```powershell
# rollback自体も承認後のみ。初回データがまだ無い場合の候補
pnpm exec wrangler rollback cbf5a90d-9ab9-40b0-8847-eb0149f20e58 --config wrangler.collector.jsonc --message "Owner-approved rollback before personal acquisition"
```

初回データ取得後は初回flagだけをOFFにして統合版maintenanceを継続する。旧versionはpersonal保守を持たないため、単に戻して放置しない。保存済みpartialは今回のレビュー修正で取得OFF／窓終了後も現行権限と証拠期限内で復旧でき、source HTTPを再発行しない。

schemaは原則維持して前進修正を検討する。D1全体restoreはECB/Models/PoCの最新履歴も巻き戻すので既定rollbackではない。[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)の実保持窓と復旧可否を直前確認し、取消しcontrolを旧backupで上書きしない。EVIDENCE/export/control・NASコピーを便宜的に削除しない。

## 検証と次の確認

[ローカル準備検証](personal-execution-20261018/first-cloud-local-validation.json): 新draft2件の実行拒否、embedded source不変、8migration hash、承認欄null、NAS停止、5分例、D0 offline preflightを確認。D0 Collector dry-run成功、`pnpm check`成功。既存コードの482件/Node 6件、runtime、backupと両CI成功は`8cb6b8b`に対する前回の結果であり、今回新たに全件を実行したとは記載しない。今回production runtime／active設定／migrationは無変更。

実行前に必要な所有者情報は、NASの実共有path・専用identity、Docker/Nodeの可用性、暗号化/回復鍵とコピー範囲、最終export名、source選択、実施日。秘密値の提出は不要。実機設定・最終コンテナ受入・現行規約fingerprintの確定が残るため、**現時点ではE1の実収集を承認可能な完成状態とは判定しない**。S1/N1の対象案を確認し、実値と受入証跡が揃った時点で具体的な操作だけを承認する。通常運転の手作業は0回/日を維持する。
