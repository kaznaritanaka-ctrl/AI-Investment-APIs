# NAS専用export ローカル検証
2026-10-18。base HEAD `ee988588ec2b90ae0af9bd24ff322b7402ff4dc4`、branch `codex/public-gpu-private-research-20261018`。対象は [実装・初回Cloud準備](nas-export-isolation-20261018.md)。

| 検査 | 結果 |
|---|---|
| pnpm check | format、TypeScript、公開/private境界の検査成功 |
| pnpm test 全件 | 46ファイル・414件成功、失敗0件、約20分39秒 |
| 最終差分の重点再実行 | 専用export protocol 4件成功、3つの独立bucketを使うdaily NAS 3件成功。先行の暗号化・復元を含む重点12件も成功 |
| pnpm test:runtime | FX/AI/operations、GPU1051件、Models50/250/1000、個人研究初回/継続/Cloud、40日/40run/80観測/120 mock GET成功。初回Cloud harnessは専用NAS_EXPORT内のmanifestを検証 |
| pnpm build | Collector/APIのWrangler dry-run成功。deployなし |
| offline preflight | 既存設定に対しerrors/blockersなし、network=false。Highreso/Rebroの実行ready判定ではない |
| generated/diff | source/research schema・OpenAPIの生成差分なし、diff check成功 |
| NAS CLI plan/daily-plan | enabled=false、network=false、NAS/timer変更なし。専用transport pinと専用bucket-only credentialを必須項目に表示 |

全件検証に加え、最終コードの重点7件を再実行した。記録はignored `work/nas-export-full.json`、`work/nas-export-final-protocol.json`、`work/nas-export-final-daily.json`。GitHub CIは公開したcommitのchecksを別に確認する。

全件コマンドは `pnpm test --pool=threads --maxWorkers=2 --fileParallelism=true --testTimeout=120000 --hookTimeout=120000 --reporter=json --outputFile=work/nas-export-full.json`。pnpmの事前自動installをprocess限定で抑制し、Git safe.directoryも当該checkoutだけをテスト子processへ指定した。依存版/lockfile、global設定は変更なし。今回のWindows全件検証は約20分39秒で終了した。JSON reporterは終了まで結果を出力しないため、無出力だけで停止とは判断できない。個別runtime検証も成功しており、全件が完了しない状態は再現していない。

今回、途中の検証でcheckpointのoptional cursorをstable()へundefinedのまま渡す不正JSONと、分離後のsynthetic health fixtureの参照先不一致を検出し修正した。取消し時にmanifestが既に削除されていてもNASがmarkerを先に記録するようにした。source HTTPの追加retryやgrantの緩和で回避していない。

検証済み: origin/export/health分離、同名/同一binding拒否、元の契約hash維持、20件cursor、失われた制御、missing part、途中write失敗、再実行、古いpin、48時間以上古いgate、取消し、10分の読取窓、専用export経由のage暗号化と空D1への初回/複数run復元、長期履歴の保持。

live IAMの拒否試験は実施していない。stubの403は本番bucket isolationの証明ではない。稼働中のWrangler、source grants、Cron、deployment、migrationsは差分なし。今回の追加migrationは不要。

実収集0、Cloud/NAS実機の変更0、実鍵設定0。実環境のCPU/費用/容量、IAM、NAS native custody/復元、独立監視、初回Cloud実行窓とdeploy承認は未確認・未実施。個人研究の例外と長期保存の所有者承認は記録済みであり、これらの実行承認と混同しない。
