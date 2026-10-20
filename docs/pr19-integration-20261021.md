# PR #19: PR #18最新修正の統合（2026-10-21 JST）

統合前のPR #19は`0282025b33d6c3b68043882879eb1b62d15895a8`、取り込むPR #18は`3525dc0650b0e848146a2bb006428fcef30a12d2`。本番Collectorの記録`0abf2b6`を基点とする既存の隔離branchへmergeする。mainへのmerge、本番状態の再監査や反映ではない。

## 取り込む変更

- 同条件のcomplete runから日次`not_seen`/再掲載を保存。消失は成約・価格0・在庫0ではない。失敗/partialから消失を確定しない。
- 契約更新と比較系列を分離。最大128 seen + 128 not_seenのbounded checkpoint、20 SQL以下のbatch、immutable planからの復旧を維持する。
- 旧形式の未完了captureも共通系列/消失処理へ再開する。元証拠・正しい既存行・時刻は不変。不整合な旧lineageは書き換えずholdする。
- 最初のR2投影保存は同じ応答から最大3 PUT、各回でauthority/leaseを再確認。応答喪失は読戻しで照合。source HTTPの再試行・日次予算は増やさない。
- v2 snapshotのcoverage/plan hashを既存NAS専用export・暗号化・復元まで渡す。初回Cloud/旧48枠/完了済みv1履歴は変更しない。

実装の根拠と制限は[PR #18の日次系列](pr18-daily-series-20261020.md)・[復旧レビュー](pr18-review-20261021.md)。実行不能な日次案を通常grantや初回契約へ昇格しない。

## 保持した統合側の処理

文書3件の競合は双方の記録を保持して解消。Collectorの本番側continuation/共有処理予算、Models/GPU優先、初回captureの取得OFF復旧、personal preflight、Linux kernel flock、UUID別CLI bundle、NAS専用container/CIを維持する。

統合前に104ファイルのSHA-256を記録し、active source/deployment/Wrangler、既存private/public migration、research以外のsrc、backup/health/resilience、deploy定義が不変であることを照合する。ECB・Models.dev・private PoCの有効状態と権利、3 Cron、AGENT=false、Collector HTTP閉鎖、公開API境界を維持する。個人研究flags/bindingsは未設定のまま。

## migrationと承認資料

新候補はprivate 0007〜0015の**9本**。0001〜0014を変更せず、0015だけを追加する。public migrationの追加はない。

- 追加: `migrations/private/0015_daily_series_events.sql`
- SHA-256: `135144476d2355357b7368a230f2425c74161c045159c9e5b0911b18cf7eaeaa`
- 実適用承認: **未承認**。remote未実行。

`first-cloud-owner-review.json`と監査JSONの旧8本/hash・当時のjournal・契約draft・承認nullはそのまま残す。9本の新releaseを旧8本の承認資料だけで実行しない。実行前には最新version/journal/bookmark/Time Travel保持窓、対象DB、9本のhash、最終artifactを再照合し、追加を含む明示承認が必要。全DB巻戻しやdown migrationを既定のrollbackにしない。

production migration試験は旧0006にECB/Models/PoCの合成履歴を保存し、9本を適用・再実行した後の既存private/public値・journal・FK・追記保護を検証する。旧監査を現在のmigration一覧に書き換えず、旧8本+明示の0015を期待値とする。日次の旧行/hash/期限/v1 export互換は専用の前進migration試験でも確認する。

## 検証の固定と結果

merge解消・準備完了後にcommitし、その最終コードを固定してローカル全件を実行する。テスト中にtracked codeを編集しない。先行した部分テストを全件の代替にしない。最終HEAD・件数・コマンド・CI URLはPR #19本文へ記録する。

対象はcheck、通常全件+Node resilience、test:backup、全runtime、Collector/APIのdry-run build、offline preflight、schema/OpenAPI整合、保護対象hash、diff検査。ローカルWindowsではLinux専用flock2件を区別し、Linux CIでは必ず実行する。Docker/Podmanがないローカルでcontainer成功とは報告せず、既存2種のnetwork-disabled synthetic containerをCIで確認する。

## 維持した承認境界

個人研究例外とowner_continuing保存は承認済み。sourceごとの適用規約/robots fingerprint・取得窓・実行契約、exportの実IAM、実鍵/custody、TOS 7での専用UID/path/排他/復元、migration・deploy・初回/日次の実行承認は別。過去の日時例は予約ではない。Highreso旧国内規約の取得境界`2026-10-31T15:00Z`以後は新版の別評価が必要。

通常grantを変更せず、provider permissionはunconfirmedのまま。今回の実市場観測0件。main merge、実収集、remote migration、本番deploy、実鍵設定、NAS実機変更は行わない。正常運転に日々のCSVや手動解除を要求しない。synthetic成功をCloud CPU・IAM・NAS実機受入の証明にしない。
