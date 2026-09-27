# 実装範囲と後続作業

Phase 0/1: FX・AI API価格、出典/権利、証拠、履歴、private/public分離、API、CIを維持。

Phase 2: GPUレンタルと中古提示価格の縦の実装、bounded pagination、complete/partial、差分・訂正、統計、FX系譜付き比較、bootstrap/preflightを追加。合成検証と実稼働を区別する。実ソースは全停止。

残る接続作業: source別許諾・認証、Runpodの地域別条件を再現するadapter、Highresoと日本中古の正規feed、CCIRの許諾済み機械feed、過去系列の新規backfill、実CloudflareでのCPU/請求計測、通知・外部監視。本番公開とCronは別承認。

DC・電力・供給網はschemaと調査手順のみ。[後続設計](dc-supply-chain-schema.md)を参照。大量企業crawler、AIバブル指数、売買シグナル、根拠のない過剰供給スコアは作らない。

数千件/多数cohortが6時間capture枠とD1予算を超える実測が出た場合は、Queues/Workflowsの必要性、費用、lease、DLQ、公開完了条件をADRで比較する。上限だけ増やしたり、手動CSVへ戻したりしない。
