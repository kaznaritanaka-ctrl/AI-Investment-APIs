# PR #19 最新統合差分の再レビュー（2026-10-21 JST）

対象は`57430b1e68737a1d33839270bfab70e479bbefaf`。統合直前`0282025`との差分、Collector dispatch、日次の取得/証拠/plan/complete/export、NAS import/復元、migration、契約/approval資料と既存試験を確認した。今回の本番再監査・提供者ページ取得はない。旧監査を現在のCloud実状態とは扱わない。

## 修正した問題

### P1: 完全な保存投影があっても、欠落partから復旧できない

日次の分割manifestと`projection.json`が残り、partだけが欠けるR2の部分復元を再現。修正前の`loadDailyCapture`は保存済みの完全投影を使わず例外となり、partialが継続した。

欠落時だけ、保存投影のschema・canonical全体hash/bytes・各part hashとmanifestのsource別keyを照合する。一致すれば既存の`saveDailyCapture`のauthority/lease/条件付き作成で欠落partを再作成し、既存plan/checkpointから続ける。manifest・投影・既存行/時刻・期限は不変。破損した既存partを上書きせず、投影の欠落/改変、別source参照は引き続きhold。source HTTPは増やさない。

新規6ケースは、正しい投影からの復旧、改変投影、投影も欠落、既存part破損、別sourceのpart参照、偽造part hash。最初の5ケースで修正前に正しい投影の1件だけ失敗することを再現し、修正後は既存9件を含む14件が成功。その後、偽造part hashのケースを追加した。15件すべてを最終全件で検証し、部分成功を全件の代替にはしない。

### P2: 日次の再export容量見積りが統合後の枠数と不整合

`collector-handlers.ts`は72 continuation枠/日を三分し、日次は最大24枠。Models/GPUの優先処理・失敗でさらに減る。`dailyScheduled`は各sourceで`exportDailyHistory`を1回呼び、1回に1runを再世代化する。

| 項目 | 現行候補からの算出 |
| --- | --- |
| Cloudの最大日次export | 24 run/source/day、全枠idleの場合のみ |
| 10年の比較規模 | 3650 daily run/source。実取得件数ではない |
| 再世代化の最短下限 | ceil(3650/24) = 153日 |
| 現在の非実行daily draft | backup世代90日 |
| 必要な理論最小throughput | ceil(3650/90) = 41 run/day。新規run・障害・保守余裕はさらに必要 |

旧「72回/日なら51日」の文書を訂正した。90日でD1履歴を削除する問題ではなく、有効な世代期限内に全履歴のbackup/exportを更新できない問題である。NAS側の走査/暗号化/復元量も別に検証が必要。

**日次の10年規模対応は実装・容量検証の残件で、有効化不可。所有者が承認するだけでこの不足が解消するわけではない。** boundedなexport設計、既存sourceへの負荷、CPU/R2/SQL/費用、停止・catch-up・復元を見直し、数千runのsynthetic検証を先に完成させる。ここでは新しいNAS機能、Cron/TTL/既存sourceの枠変更を行わない。初回の1run取得・backup受入とは分離し、毎日の手動exportへ戻さない。

## 既存3sourceへの影響

ECB・Models.dev・private PoC、通常grant、稼働用Wrangler、3 Cron、AGENT=false、API/Collector HTTP境界、共有処理予算は変更しない。runtime修正は未有効化の日次証拠の読取りだけ。初回Cloud専用契約・旧48枠・完了済みv1証拠を変更しない。旧migration 0001〜0015も今回変更しない。公開API bundle・保護対象hash・移行後の旧履歴/権利/公開境界を再検証する。

## 初回Cloud実行前の残件と承認

私的研究例外とowner_continuing継続保存は承認済みで、再承認を要求しない。provider permissionはunconfirmed、通常grantは不変。

1. **C1:** HighresoだけかRebroも含むか、適用文書/robots fingerprint、最終実行契約hash、review/analysis期限、正確な24時間窓を確定。既存draftや日時例は実行承認ではない。旧Highreso国内版の境界`2026-10-31T15:00Z`以後は新版の別評価が必要。
2. **S1/N1:** 専用export/IAMと元EVIDENCEの隔離、実鍵/回復コピー、TOS 7の非root UID/path・採用runtime・別container間排他/再起動・暗号化/空staging復元・監視を実受入。実resource/鍵/NAS変更には別承認。SSHは無効を維持。
3. **M1:** private 0007〜0015の9本を、新しい[非実行migrationレビュー資料](personal-execution-20261018/pr19-migration-review-20261021.json)と最終release artifact・直前journal/bookmark/実保持窓で照合し承認。旧8本のpacket/hash/監査は不変。追加0015を旧承認の範囲と扱わない。public migrationは追加しない。
4. **D0/D1:** Collectorだけを個人研究4flag OFFで反映し、既存3sourceの受入後に選択sourceの保守のみを別承認。API/Admin、DNS/Access、既存source/Cronを変更しない。切戻し先versionは実行直前に再確認する。
5. **E1/E2:** NAS等の受入後、source別の窓で初回ON→受入後OFFを承認。保存済みpartialの復旧・長期保守は取得OFFで継続する。
6. **日次:** 上記の容量実装・数千run検証を完了した後に別承認。初回承認に含めない。契約更新時は旧partialを処理できる契約/control/pinを確認し、旧partialの証拠期限切れを正常な空観測として扱わない。

## 検証結果と境界

最終commitを固定し、check、ローカル全件+Node、backup、runtime、Wrangler dry-run、offline preflight、生成物/保護対象/旧packet hashと同一HEADのCIを確認する。確定HEAD・件数・CI URLはPR #19本文へ記録する。ローカルのplatform skipとCIでの実行を区別する。synthetic成功は実CPU・実IAM・TOS実機の証明ではない。

今回もHighreso/Rebroの実市場観測0件。main merge、実収集、remote migration、本番deploy、権利grant、実鍵設定、NAS実機変更は行わない。

照合した一次資料: [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)、[R2 conditional writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)。最新Workers types 5.20261021.1は確認用作業領域だけへ取得し、依存lockfileは変更していない。
