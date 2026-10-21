# 日次個人研究履歴・Cloudflare → NAS（未有効化）

2026-10-21追記: 1run/回の容量不足は[最大4runのdurable export/転送と期限索引](daily-export-capacity-20261021.md)で修正。旧本文の153日下限は修正前の記録。最大24日次枠は維持し、private0016と数千run syntheticを追加。旧世代期限・長期履歴・実行承認を変更しない。

2026-10-18更新: 私的例外・長期保存は所有者承認済みです。NASには既存EVIDENCEを読めるcredentialを渡しません。[専用exportの実装・現行設定案](nas-export-isolation-20261018.md) が以下のshared-bucket案と旧CLI v1案に優先します。実行・deploy・実鍵・NAS実機変更は未承認。以下は段階ごとの履歴です。

レビュー追補: [parser/cohort・規約切替・NAS専用export分離案](public-gpu-review-acceptance-20261018.md)が最新の受入条件。既存EVIDENCE全体の読取credentialをNASへ渡す案はrelease blocker。0012には後続レビューで台帳DELETE保護を復元するtriggerを追加し、0014と両順序で検証する。以下の「0001〜0012は変更せず」は日次拡張時点の記録。

2026-10-18、Highreso/Rebro専用。所有者が今回承認した範囲は実装とローカルsynthetic検証まで。実収集、権利grant変更、remote migration、deploy、実鍵設定、NAS変更は行わない。本資料は先行の[初回一run実装](personal-cloud-nas-implementation-20261018.md)にあった「日次・複数run・NAS監視は未実装」を更新する。先行の初回専用契約は互換維持し、日次契約へ自動変換しない。

## 長期保存と実行契約

- 新しい専用契約は `personal-gpu-cloud-daily-v1`。通常source grantとは独立し、provider_permission=unconfirmed、元sourceはdisabled、取得・保存・分析権はreview_requiredのまま。公開・再配布・外部LLM・raw HTML保存は許可しない。
- 正規化観測の保存モードはowner_continuing、normalized_days/storage_untilはnull。30日や10年を削除期限にしない。取得期限・分析期限・規約review期限は別。期限切れは新規取得を停止するが、継続保存が有効な既存履歴は保持・再exportする。
- 契約を更新する場合、再確認した期間・terms hash・owner判断を持つ新しい契約全体のhashをpinし、旧契約とそのrunを残す。旧履歴の保存authorityを新契約で上書きしない。source/UTC日slotは契約IDを変えても再取得できない。
- 明示された保存終了・取消しは継続保存より優先。R2の現在control、取消し、run削除markerはDB復元に含めず巻き戻さない。NASでも受信済みの取消しを永続化する。control欠落はfail closed。
- 日次判断と初回判断は別承認。Highresoの現行国内条件を使う契約は2026-10-31 15:00 UTC（11/1 00:00 JST）を越えられない。Rebroの未確認条件も解消済みとは扱わない。再確認は例外時・契約期限時の所有者判断であり、毎日の転記作業ではない。

## 実装経路

`daily-scheduled.ts → personal-daily.ts → private D1 / private R2 → daily-nas.ts → 暗号化NASコピー → 固定health receipt → dailyMonitor`

private forward migration `0013_personal_daily.sql` が契約、run、immutable観測、NAS監視状態を追加する。0001〜0012は変更せず、公開DB/APIには追加しない。旧0012の観測入りDBからの前進migrationを検証する。

| 機能 | 実装 |
|---|---|
| 日次新規取得 | source/UTC日ごと1試行、robots・terms・固定データページの最大3 GET、各15秒、最大48観測。変更がなくても新しいobserved_atを保持 |
| 中断・再実行 | R2 immutable予約、D1 lease、保存済みprojectionからの再開。過去日へのHTTP backfillなし。Retry-Afterは日を越えて尊重 |
| 欠測 | API失敗はfailed/partialと理由。0件や成約に変換しない。予約後中断・証拠期限切れのpartialは自動保守でfailedへ確定 |
| 履歴 | first_seen/reobserved/revised、previous_observation_id。掲載消失を売却成立としない。旧価格・取得時刻を更新しない |
| export | 1呼出しで1run、最大48観測・512KiB、128KiB×最大4part。lease/CAS・hash確認後にmanifestとrun pointerを確定 |
| 複数run | 32run単位のcatalog pageと明示page一覧。日次世代をローテーションし、古い観測も新世代へ含め続ける。ordinal欠番を欠落pageと混同しない |
| NAS同期 | 最新runを優先し、1周期で履歴最大19runを追加確認。走査cursor/ceiling・失敗状態を永続化し自動継続。欠落pageを完全取得としない |
| 暗号化・検査 | age暗号化、暗号文・平文hash、現在authority、scope/expiry検証。少なくとも24時間ごとに1runを空のローカルD1へ実復元検査 |
| 全履歴復元 | 別stagingでcatalog固定 → index → 最大20runずつimport → 最大20runずつverify → 完成receipt。CLIは一度の指示で各checkpointを自動継続 |
| 保守 | R2 list20件、D1 run20件、NAS削除20件/周期で進捗保存。証拠/backup世代のみ期限削除。明示的な保存取消しは観測も削除 |

NASの全履歴復元は完全runの正規化履歴を対象とする。failed/purged runは取得データに復元しない。partial/purgingを含むscopeは未完了として拒否する。R2に残る予約・失敗scope・現在controlは別の運用状態であり、この復元物で全運用状態を置き換えない。復元先を本番へ自動昇格しない。

## 監視連携と自動回復

NASはsourceごとに署名付きreceiptを固定key `daily/receipts/<source>.json` に送る。項目は時刻、状態、未完了件数、固定理由codeのみ。価格、契約本文、鍵、raw responseは送らない。

データbucketのNAS権限は引き続きObject Readのみ。receiptは**別health bucket・別credential**のObject Read/Writeで固定PUTする。データreaderにはwriteを追加しない。コードのkey制限に加え、実際のcredentialもbucketを分離する必要がある。Collectorは将来の `NAS_HEALTH` bindingと `NAS_RECEIPT_SECRET` で読み取り・HMAC検証する。今回はどちらも未設定。

- 未設定・欠落・署名不正・時刻巻戻しはunknown。古いheartbeatはstale。backup/復元検査/inventory未完了はwarning。いずれも新規取得を止め、保守とexportは継続する。
- 最新の保存済み観測をNASが検証済みかを確認する。観測日が古いこととNAS backupの古さを混同しない。障害後に最新の保存済みrunを再検証できれば、契約が有効な限り取得を自動再開できる。
- 初回は所有者が承認した最大24時間のbootstrap内だけ、freshなempty receiptを許容する。complete runが既にあればbootstrapでは通さない。
- 通常のNAS cycleは1時間ごとのtimerで起動する提案。通信障害・429は次の周期で自動再試行し、source単位で失敗を隔離する。日々の手動取得・CSV転送は不要。
- Collectorは既存Cronのfinallyで判定する。現設定の主なcontinuationはUTC18〜23時（JST翌03〜08時）であり、その時間外に即時警報が出る仕組みではない。NAS自身も停止した場合は次のCollector起動でstaleになる。外部deadman通知やAdmin専用表示は今回未実装、通知は送っていない。
- Collector全体のCOLLECTION_ENABLED停止時は既存入口も止まる。長期停止前は保守を継続できる運用を別途承認すること。停止したまま期限削除が動くとは主張しない。

## 初期設定案（未反映）

[Cloud契約draft](personal-execution-20261018/rebro_public.daily-cloud-draft.json)と[Highreso draft](personal-execution-20261018/highreso_public.daily-cloud-draft.json)、[NAS disabled設定](../config/proposals/daily-nas.runtime-disabled.json)、[timer例](personal-daily-nas-systemd.example.txt)を用意した。実resource ID、NASパス、鍵、承認refはnullのまま。draftはschema上も実行不能である。

| 対象 | 承認後に設定する内容 |
|---|---|
| Cloud契約 | source別の所有者判断・利用条件適用・取得期間・継続保存根拠・backup/復元範囲・個人/日本/奈良県の確認結果 |
| Cloud resource pin | 確認済みaccount/private D1/data bucket・D1 Time Travel日数・contract hash。推測しない |
| Private migration | 本番履歴保全と現行schema差分確認後、0013を含む必要な前進migrationを別承認 |
| 二重flag | PERSONAL_DAILY_MAINTENANCE_ENABLED、PERSONAL_DAILY_COLLECTION_ENABLEDを別々に承認。現状どちらも未設定=OFF |
| 契約配置 | private R2のpersonal-daily/contracts/<source>.json。PERSONAL_DAILY_PINSはhashとresourceの固定値。初回専用flagと同一sourceで併用しない |
| 監視接続 | 新health専用bucket、NAS_HEALTH binding、NAS_RECEIPT_SECRET、health専用credential。resource作成・Secret登録はすべて別承認 |
| NAS | 専用非管理者、実パス/ACL、code読取専用、暗号化identity・復旧鍵の別保管、data読取専用credential、別health credential、HMAC鍵、hourly timer |
| 復元 | 所有者の一度の復元承認ref、新規の空staging先。既存先上書き・remote書込み・本番昇格はしない |

候補値はbootstrap=24h、heartbeat=3h、backup/restore freshness=48h、全体inventory=14日、backup世代=90日。実承認済み値ではない。正規化履歴は無期限の継続保存、証拠は7日を候補とし別に扱う。backup schemaのinterval/restore_checkは24h、max_copiesは**runごとの世代**として最低retention_days+1。NASは各runの最新検証済み暗号化世代を保持し、R2は期限内世代を保持する。全履歴を90日で捨てる設定ではない。

2026-10-21 PR #19再レビューで訂正: 統合後は既存72 continuation枠のうち日次保守用は最大24枠/日であり、Models/GPUが使った枠はさらに延期される。1run/callのexportでは、10年分3650run/sourceの再世代化は障害も新規runもない理論上限で約153日かかり、候補の90日世代期限に収まらない。旧「72回/日・約51日」は統合前の仮定で、現行候補の容量根拠には使わない。D1の継続保存を90日で削除する意味ではなく、全履歴の有効なbackup/export範囲を維持できない問題である。日次有効化は容量設計と大規模synthetic検証の見直し待ち。初回1runの受入とは分離し、Cron/TTL/既存sourceの枠を無断変更したり、日々の手動exportで補ったりしない。詳しくは[最新レビュー](pr19-review-followup-20261021.md)。

実行形は以下。現在はdaily-planのみ利用可能な状態で、他はdraft/disabledにより拒否される。以下をNASに登録していない。

```sh
node scripts/personal-nas-runner.mjs daily-plan
node scripts/personal-nas-runner.mjs daily-once /approved/config.json --allow-network
node scripts/personal-nas-runner.mjs daily-restore /approved/config.json --source rebro_public --destination /new/staging --approval-ref OWNER_RESTORE_REF --allow-network
```

通信/復号障害でrestoreが止まった場合、同一承認・同一stagingで再実行するとcheckpointから続く。完了先は上書きしない。全期間にわたるrestore中に最新controlが変わる可能性があるため、完成receiptは自動公開の承認ではない。本番昇格前にはその時点の取消し・削除をもう一度適用する。

## 有効化前に残るもの

所有者による日次例外契約承認、提供者許諾とは区別した未確認条件の判断、実Cloud/NASのresource・権限・鍵保管・lifecycle確認、復旧鍵からのNAS実機復元、処理容量/CPU測定、本番設定drift解消とdeploy承認。旧本番より古いこのbranchを丸ごとdeployしない。

今回の検証は[検証記録](personal-daily-validation-20261018.md)にまとめる。実観測0件、本番日次稼働0日。既存FX/Modelsの稼働を本作業で再確認したものでもない。
