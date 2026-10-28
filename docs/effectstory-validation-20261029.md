# EffectStory 実装・検証記録（2026-10-29）

対象: `codex/effectstory`、基点 `9361a65510edfce1da6abf64b4d54ff2f483b570`。ネットワーク取得・push・デプロイ・remote migration は実施していない。テスト入力はすべて合成。提供済みの権利確認記録だけを使った。

## 結果と未完了

| 確認 | 結果 |
| --- | --- |
| `npm run check` | 成功。書式・TypeScript・境界検査 |
| オフラインで実行可能なテスト | 29ファイル・360件成功。補助 Node test 3件も成功 |
| EffectStory テスト | parser / 実 SQLite / 公開 API 25件とカタログ1件成功 |
| `npm run build` | Collector/API 両方の Wrangler dry-run 成功 |
| generated schema / OpenAPI | `node scripts/generate.mjs` 再生成で3ファイルのハッシュ不変 |
| offline preflight | `ready:true`、errors/blockers なし。network_performed:false |
| 全体 `npm test` | 未成功。既存 Miniflare の起動が `listen EPERM 127.0.0.1`。最初の既存 PoC テストの setup で停止 |
| `npm run test:runtime` | 未成功。同じローカル接続制限で workerd 起動前に停止 |
| subprocess を使う preflight-plan 試験 | 未実行。`spawnSync node EPERM` により起動不可 |
| Claude Code 相互レビュー・CI | 未実施。ネットワーク禁止のため保留 |
| この worktree の commit | Git 管理領域が `/workspace/aiapi/.git/worktrees/wt-effectstory` の読み取り専用領域にあり、`index.lock` 作成拒否。ブランチを更新できない |

全件成功・配備可能とは扱わない。`tests/effectstory-offline-env.ts` は実 SQLite と条件付き作成付き R2 メモリ実装で保存と公開の SQL を検証するための補助であり、workerd/D1 の実行検証を代替しない。オフライン試験の選択は `localEnv|Miniflare|spawnSync|execFile` を直接参照しない test ファイルで、thread pool を使った。

## 設計上の確認

- 新しい migration は **なし**。private `gpu_rental` / `gpu_snapshots` / `raw_artifacts` / `fetch_attempts`、public `published_observations` / `published_coverage` を再利用し、既存 migration は変更していない。
- 既存日次 Cron（03:17 JST）で EffectStory だけ直接取得。HTTP 前の原子的な予約は通信・解析・R2 保存の失敗時も残り、1 UTC日・1論理runそれぞれ最大1回。continuation/watchdog は保存済み証拠のみ再処理。
- 2 MB・50行の上限。50行は既存 GPU のSQL上限を維持するためで、超過時は全体を拒否する。50行の完全置換も追加2 continuation 枠以内で完了することを合成データで確認。
- 取得日ごとに不変 snapshot を作る既存規約を採用。上流の確認日を `source_date` に残し、取得時刻を価格の更新とみなさない。
- 保存済みの非公開 PoC 観測と Highreso 研究観測が共存しても、GPU の公開観測・coverage・metrics へ EffectStory 以外が入らないことを確認。既存の公開 FX・Models・e-Stat は対象外。
- 全観測行に指定 attribution と `reuse.license_url`。EffectStory の coverage・価格差分・not_seen イベントにもライセンスを付ける。未知モデルは raw label を残して model=null。ラックを1枚のGPUと推測しない。

## 配備後の確認とリスク

[配備手順と API](effectstory.md#人による配備と確認) に従い、全体テスト・CI・Claude Code 相互レビュー後に、人が Collector と API を配備する。DB migration は不要。R2 の EffectStory evidence/archive は各7日。既存 Cron・有効フラグ・ドメイン等を維持する。

初回の日次処理後、`/v1/latest?dataset=gpu_rental&source=effectstory` と `/v1/gpu/coverage?source=effectstory` を確認する。価格は十進文字列、単位はUSD/GPU-hour、確認日・ラベル・basis・正確な出典・CC BY 4.0 URL が各観測に必要。他の非公開情報源のデータを出さない。

実 HTML は再取得しておらず、Next.js のマークアップが厳格な対応範囲にない場合は停止する。51行以上、価格・ヘッダー・日付の変更も停止する。上流プロバイダーのライセンス未確認、月次掲載による鮮度、地域・契約などの比較不能性は残る。policy の再確認期限は2027-01-27。共有処理枠は通常運転の見積もりであり、障害時の完了保証ではない。

## 変更ファイル

- `config/deployment.json`
- `config/gpu-catalog.json`
- `config/proposals/research.schema.json`
- `config/source.schema.json`
- `config/sources/effectstory.json`
- `docs/architecture.md`
- `docs/effectstory-validation-20261029.md`
- `docs/effectstory.md`
- `docs/gpu-methodology.md`
- `docs/license-review-effectstory-20261029.md`
- `docs/source-register.md`
- `docs/third-party-notices.md`
- `openapi.json`
- `scripts/preflight-core.ts`
- `scripts/runtime-smoke.mjs`
- `src/collector-handlers.ts`
- `src/effectstory-config.ts`
- `src/effectstory.ts`
- `src/gpu-adapters.ts`
- `src/gpu-metrics.ts`
- `src/gpu-pipeline.ts`
- `src/gpu-store.ts`
- `src/gpu.ts`
- `src/network.ts`
- `src/policy.ts`
- `src/publication.ts`
- `src/request-plan.ts`
- `src/schema.ts`
- `src/sources.ts`
- `src/telemetry.ts`
- `tests/effectstory-catalog.test.ts`
- `tests/effectstory-helpers.ts`
- `tests/effectstory-offline-env.ts`
- `tests/effectstory-runtime-harness.ts`
- `tests/effectstory.test.ts`
- `tests/license-metadata.test.ts`
