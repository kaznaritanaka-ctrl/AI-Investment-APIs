# Cloudflare → NAS 個人研究履歴：実装と受入

2026-10-18更新: 私的例外・長期保存は所有者承認済みです。NASには既存EVIDENCEを読めるcredentialを渡しません。[専用exportの実装・現行設定案](nas-export-isolation-20261018.md) が以下のshared-bucket案と旧CLI v1案に優先します。実行・deploy・実鍵・NAS実機変更は未承認。以下は段階ごとの履歴です。

2026-10-18。ローカルsynthetic検証用の実装。実データ取得、provider grant変更、本番deploy／migration、実鍵設定、NAS接続・変更は実行していない。旧[設定提案](personal-cloudflare-nas-setup-20261018.md)の後続。価格・規約の現状調査をやり直したものでもない。

## 保存と権限

- `personal-gpu-cloud-v1` は別形式の所有者例外。従来local v1/v2を本番へ流用できない。Highreso/Rebroだけ、source disabled、provider_permission unconfirmed、private3権限 review_requiredを保持する。
- Cloud契約はcanonical SHA-256、account / private D1 / bucket / storeを照合し、deployment・lifecycle・NAS受入・復元の承認参照を必須にする。本番syntheticとローカルlive混在を拒否する。公開DBをpersonal処理へ渡さない。
- 正規化履歴の経過年数による削除はない。レビュー期限切れは取得・通常readを止めるが、承認済み継続保存を削除しない。追加reviewは既存履歴限定で取得権を増やさない。明示の終了・取消し・削除義務は保守と復元へ反映する。
- 初回はsource全体で一試行。R2の独立台帳は契約ID変更、D1復元、日付、review更新でも消えない。最大3 GET（robots / terms / 固定data）、15秒/GET、最大48正規化観測は既存通り。
- 日次の新規取得契約は追加していない。初回Cloud取得は既存scheduled内の別flag `PERSONAL_INITIAL_COLLECTION_ENABLED=true` とpinned Cloud契約の24時間窓を両方満たす場合だけ起動できるよう準備した。保守flagだけではsource GETしない。2つのflagは未設定、実起動は未実施。毎日のバックアップと毎日の新規取得を混同しない。

## Cloudflare側

`src/research/personal-cloud*.ts` が担当する。

| 名前空間 | 内容 | 削除条件 |
|---|---|---|
| `personal-research/evidence/<source>/` | raw HTMLを除く短期投影証拠 | 元の固定証拠期限／明示の終了 |
| `personal-research/backups/<source>/<contract_hash>/<UTC日>/` | source別snapshot、128 KiB以下のpart、完成manifest、lease | 契約のbackup世代期限／明示の終了 |
| `personal-research/control/<source>/` | 現行review、試行、取消し、削除、完成manifestの参照、cleanup checkpoint | 年齢による削除なし。DB snapshotで巻き戻さない |
| `personal-research/control/contracts/<source>.json` | 別承認した実行契約 | owner管理。未配置 |

一日一generation、最大512 KiB／4 part、1呼出しで新規partは1個。R2 conditional putで5分lease、既存partのhash照合、完成manifestを最後に確定する。途中のsnapshotをNASへ渡さない。復元SQLは20行以下で区切る。R2 cleanupは20 objectずつcursor保存する。バックアップは初回runの**保持中の全履歴**で、直近N日だけを切り出さない。

この初回版は各source一run・48観測までである。将来の日次収集・大量履歴用の複数run exportは別実装であり、10年分の取得能力を実証したとはしない。現実データの履歴件数は0。

Collectorの既存scheduled経路に保守hookを追加したが、`PERSONAL_MAINTENANCE_ENABLED` と `PERSONAL_CLOUD_PINS` はWranglerに設定していない。未設定は完全に無効。初回取得の別flagもWrangler未設定。既存Cron／route／公開API設定は無変更。source障害は他source／ECB／Models.devを止めない。新しいHTTP操作口はない。

利用には既存の研究migration候補0007〜0012が必要。今回新しいSQL tableやmigrationの書換えは不要。本番schema／配信版との差分照合とremote migrationは別承認。この古いbase branch全体を現在の本番へdeployしない。

## NAS側

`scripts/personal-nas*.ts` とrunnerを追加した。専用readerは固定account/bucket・2sourceのcurrent manifestとpartだけをS3 SigV4 GETする。復元／確定の直前には、要約とは別に固定のnative review head・review本文・source取消し・run削除記録を再取得する。任意URL、D1 API、R2 PUT/DELETE、Secret値取得はない。HTTPは15秒・応答128 KiB上限・redirect拒否。429 Retry-Afterは秒とHTTP日付を解釈し、次回実行へ持ち越す。

1時間ごとの一回実行を想定。source別排他、途中の暗号化コピーの期限記録、hash照合、冪等性、永続backoff、期限切れ世代の20件ずつ削除を実装。通信停止中も既に判明している削除義務と世代期限は処理する。一社失敗でも他社を続ける。容量上限時に履歴や有効な世代を黙って消さず、レビュー待ちにする。

age 1.3.2の実バイナリで暗号化・復号する。公開recipientは暗号化、別のidentityは無人復元検査専用。外部資格情報をage子プロセスへ継承せず、鍵・rawデータ・上流エラー本文をログにしない。synthetic鍵はignored `work/nas-synthetic` 内の試験専用で、運用鍵への転用は禁止。

バックアップ本文は暗号文だけを保存する。通常の自動検査時の平文はメモリ／隔離した一時Miniflareに限定する。毎日、実際に空のローカルDBへ復元し、件数、fingerprint、FK、D1 `PRAGMA quick_check`、immutable triggerを確認する。検査に成功したコピーだけにreceiptを確定する。cipher改ざん、欠けたpart、current control欠落・48時間超の遅延・巻戻し・取消しは成功扱いしない。snapshotは短期証拠を復活させず、current controlを上書きしない。NASの復元成功時には別のcurrent-control.ageも保存するが、R2喪失時にそのコピーを自動的に「最新の権限」と採用しない。現行権限が取得できなければ停止し、災害時のcontrol再建は所有者レビュー対象。

これは別NASプロジェクトのnative coordinator／UID／ACLを実機で置換・検証したものではない。専用root・captureとsealed/controlの分離・別identityのnative受入が本番前提。既存G1〜G4／UID／share／helperは変更しない。現在のCollector CronはUTC 18〜23時台中心で、24時間毎時の保守稼働ではない。Cloud側清掃の遅延・R2 lifecycle・D1 Time Travel残存コピーは本番受入で確認する。NASは毎時実行を準備するが未登録。NAS本体停止を外から検出する監視と通知先は未接続。NAS状態をCloudflareへ返すhealth連携も未接続であり、バックアップ停止中に日次取得を自動継続させる入口は今回作っていない。

## 明示的な復旧

`restoreNasGeneration` とCLIの `restore` は、検証済みの最新NAS世代から、まだ存在しない専用stagingディレクトリへ復元する。既存DB・backup root内への上書きを拒否する。現在のR2権限、選択世代の独立manifest、暗号文hash、復号後hash、契約・保存期限を確認する。終了直前にも権限を再取得し、成功時だけ `restore-complete.json` を書く。Miniflareを終了／再起動した後の4観測の残存もsynthetic試験で確認した。

```sh
node scripts/personal-nas-runner.mjs restore /approved/private/config.json --source highreso_public --destination /approved/new-staging --approval-ref OWNER_RESTORE_APPROVAL --allow-network
```

このコマンドも今回は実NASでは実行しない。stagingには平文DBが残るため、所有者承認済みの暗号化volume／専用ACL内だけを選ぶ。失敗時のstagingは完成receiptを持たず、サービスへ接続しない。remote D1への復元・primary切替は行わず、別レビュー／承認対象。R2の現在権限を取得できない災害時は停止し、バックアップ内の古いcontrolで自動的に再開しない。
## 無効な初期設定と実行方法

source別の実行形式案：[Highreso Cloud draft](personal-execution-20261018/highreso_public.cloud-draft.json)／[Rebro Cloud draft](personal-execution-20261018/rebro_public.cloud-draft.json)。元source設定とhashはそのまま、承認・規約確認・日時・実resource・鍵・保存先は未設定。statusはdraftでruntime schemaに通らない。7日証拠／90日世代／最大96世代は提案値であり、許諾や実稼働を表さない。

[`config/proposals/personal-cloud-nas.runtime-disabled.json`](../config/proposals/personal-cloud-nas.runtime-disabled.json) はenabled=false、対象、鍵、承認欄は未設定。[systemd例](personal-nas-systemd.example.txt)は未登録・未有効化で、実NASの権限確認後にpath/userを決める。通常運転では毎日の人手は不要。初期設定、規約変更／レビュー期限、取消し、故障・復旧のみ所有者対応が必要。

今回実行してよいoffline plan:

```sh
node scripts/personal-nas-runner.mjs plan
```

将来、承認済み設定をNASの保護領域へ置いた後の1回分:

```sh
node scripts/personal-nas-runner.mjs once /approved/private/config.json --allow-network
```

有効な設定でこのコマンドを実行することは今回は承認されていない。ローカルの無効template拒否のみ検査済みで、ネットワーク／NAS処理に到達しない。CLIはnative custody／owner／recovery承認参照、対象account/bucket、source契約hash、専用root、age、別保護領域のidentity／S3 credentialsを検査する。S3の最小権限は対象bucketのObject Read。アプリのprefix制限はCloudflare tokenのprefix権限ではなく、bucket全体のread権が残る点を承認する必要がある。

## 全テスト未完了の調査

verbose出力で、Models.devの複数日シナリオが進行しながら既定30秒でtimeoutすることを再現した。単独でも発生し、pool変更では改善しない。ローカルD1への30回連続SELECTは約1.4秒。Nodeからworkerdへの多数の逐次RPCを含む試験で、2件は約40〜42秒必要だった。停止ではなく、結合試験の時間予算不足が確認できた原因である。

`tests/models-integration.test.ts` のdescribeと、同じModels.devを2日分扱う `recovery-integration.test.ts` の1シナリオだけを120秒にした。後者は既定30秒で失敗、単独でも約35秒必要で、120秒枠でassertionを維持したまま通過した。unit/runtime、hook、他のtest、本番CPU／network timeoutは変更しない。12件すべて約287秒で通過。assertionや収集ロジックを削らず、通常reporterのファイル完了待ちによる無出力を避けるため、今回の全件実行は `--reporter=verbose` を使用する。

Windows上で `node --input-type=module -e` から起動した診断用Miniflareがready待ちのままになる現象もあった。同じ内容を通常の `.mjs` ファイルにすると完了。通常のtest/runtime runnerはファイル実行のため、その診断コマンドの現象をアプリ不具合や全テスト停止と取り違えない。

追加runtime再実行の際にはpnpm 11の `verify-deps-before-run=install` が自動installを挟む待ち時間も観測した。未検証の依存更新は行わず、既に固定lockfileの依存が揃っている場合に限り `pnpm --config.verify-deps-before-run=false test:runtime` または同じpackage scriptの `node scripts/run.mjs runtime` で分離できる。グローバル設定は変更していない。

checkout所有者（CodexSandboxOnline）と実行ユーザー（Tanaka）の相違により、raw `git rev-parse` がdubious ownershipで拒否されることも確認した。全件再実行ではGIT_CONFIG_COUNT/KEY/VALUEで**この絶対パスだけ**をテスト子プロセスのsafe.directoryへ追加する。ユーザーのグローバルGit設定や権限は変更しない。試験のDB／一時ファイルが分離されていることを確認し、再実行はCLIだけ `--fileParallelism --maxWorkers=2` とした。既定のserial設定は変更しない。

Cloud実装前のpersonal-boundary試験は「両Workerにpersonalコードが存在しない」を前提としていたため、今回のhook追加で失敗した。公開APIにはpersonal authorityが含まれないこと、両WorkerにはローカルNASコードが含まれないこと、Collectorの2つの実行flagとpinsが未設定であることへ更新した。無効時の無通信・無書込みはruntime試験でも確認する。

## 検証区分・承認待ち

[最終検証記録](personal-cloud-nas-validation-20261018.md)：全件39ファイル・380件成功。最終NAS変更後の関連5件再実行、check、runtime、dry-run build、offline preflightも成功。live／実NASの結果ではない。

- 実装済み：Cloud契約・別途有効化が必要な初回scheduled dispatch・private projection・保守hook・分割export／再開・最新control・NAS固定read・暗号化・自動保守・復元検査。すべて未有効化。
- synthetic：2sourceの初回、export中断／再開、再実行、11年後の保持／review更新、現行取消し、バックアップ期限、age実暗号化／復号、ローカルD1復元、改ざん、429、source分離を検証。全体check/test/runtime/build結果は最終報告に記載。
- live／本番／NAS実機：本タスクでは未実施。実鍵未設定。既存FX/Models.dev稼働の実地監査も今回行っていない。
- 所有者確認：source別例外・適用規約／未解決条件／24時間初回窓、継続保存根拠、7日証拠／90日世代案とD1残存コピー、契約hash、コピー台帳、専用NAS隔離、S3 read権、鍵の独立回復と無人検査identity、外部死活監視、現行本番との統合・migration・deploy・初回起動。
- 日次新規取得、複数run／大規模履歴export、実NASのnative確定と外部通知・Cloudへのhealth伝達は後続。本実装の48観測上限を巨大化して代用しない。

参考： [R2 Workers conditional操作](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[D1対応PRAGMA](https://developers.cloudflare.com/d1/sql-api/sql-statements/)、[age公式release](https://github.com/FiloSottile/age/releases/tag/v1.3.2)。テストtoolの取得はSHA-256固定の `node scripts/setup-test-age.mjs --allow-download` のみ。通常test/buildでは外部tool downloadや本番API呼出しをしない。CIは依存tool準備stepで明示取得してからsynthetic試験を行う。
