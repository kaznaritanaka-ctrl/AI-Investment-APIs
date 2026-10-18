# PR #16: 削除済み証拠の再削除と保持評価台帳

対象: owner追加指示 [6246256228](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/pull/16#issuecomment-6246256228)、基準 `5c12d0bb92252d0893a3776a5f100763fec56181`。ローカルsynthetic検証のみ。実収集・grant・本番設定・deploy・remote migrationなし。

## 修正

`reconcileResearchRun` はpurged行も現在の登録config、取得時の期限、source revocation、run deletion markerに照合する。削除義務があるrunは `purgeResearchRun` に進み、`research/<source>/<run>/0.json`〜`3.json`だけを再削除する。未checkpointの証拠も含む。全bucket走査、証拠本文の読取り、再取得、公開はしない。

purged再処理の前に `research_evidence_cleanup_pending` をD1へ保存し、R2 DELETEの失敗は例外として返す。成功後のみこの状態を解除する。元の `deleted_at`、`normalized_expires_at`、`backup_residual_until` は変えない。同処理は繰り返せる。外部controlの削除/取消し記録は消さない。正規化履歴の初回削除は従来の20行ずつの処理を維持する。

R2だけを復元した場合も、D1に残るsource/runと**復元対象外の現行control**を用いて再reconcileする。失敗・対象未照合の間は復元領域を隔離する。D1 runも失われた孤立objectの自動探索/復元は本修正の対象外であり、対応するrun/controlを特定せず削除成功・復元受入とはしない。R2復元元やD1 Time Travelからの全コピー消去を保証するものではない。

## 前進migrationと台帳の境界

`0014_research_assessments_append_only.sql` は0009のUPDATE禁止にDELETE禁止を加える。0009は書き換えない。0010〜0013はstacked PR #18で予約されているため、この番号を使う。新規DBと既存0009 DBのどちらにも同じmigrationを適用する。

PR #18の0012は台帳を再作成するため、そこでDELETE禁止triggerも再作成する必要がある。順序は①新規DB: 0009→0012→0014、②本PRを先に適用済み: 0009→0014→後続0010〜0013の両方を試験する。0014の適用記録がある環境では、0012が保護を復元しなければ0014を再実行してもらえるとは限らない。既存期限・FK・観測・assessmentをコピーの前後で照合する。

assessmentは本文価格を含まない判断metadataで、通常retention purgeの削除対象にしない。監査metadata自体への法的削除義務が確定した場合は、対象・根拠・期限・backup/Time Travelとcontrolの取扱いを個別承認し、専用migration/管理手順で扱う。通常runtimeにtrigger解除や削除bypassは追加しない。metadataを無条件に永久保存できるとの主張ではない。

## 検証

R2単独再出現、再試行、DELETE障害、未checkpoint page、別run/sourceの維持、control維持、元の削除日時/期限維持、0009の既存行からの前進migration、UPDATE/DELETE拒否、FKをsyntheticで検証。

- Windows `pnpm test`: 29ファイル / 299 passed / failed 0 / skipped 0。threads・4ファイル並列・test/hook timeout 120秒の既存Windows用実行オプションを指定。CI設定は変更しない。
- `pnpm check`、`pnpm test:runtime`（FX/AI、operations、GPU1051件、Models50/250/1000）、`pnpm build`（両Worker dry-run）、offline preflight、生成schema/OpenAPI差分なし、diff check成功。
- branch切替でpnpmの自動installがsandboxのsymlink制約に失敗したため、この実行だけ `pnpm_config_verify_deps_before_run=false` とし、既存node_modulesを使用。lockfileや依存版を変更していない。CIは通常のfrozen installで独立検証する。最新HEADのCI結果はPR本文へ記録する。

本番反映は未承認。現在配信中のCollector/PoC設定とmainとの差分を確認し、後続の本番統合で選択的に取り込む。旧mainをそのままdeployしない。
