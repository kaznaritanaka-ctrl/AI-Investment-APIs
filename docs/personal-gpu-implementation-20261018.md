# Highreso / Rebro 個人研究例外のローカル実装

2026-10-18 JST。所有者の追加指示により、例外経路の実装とローカル検証まで進めた。**実収集、実行用判断票の承認、source有効化、権利grant変更、本番deployは行っていない。** [以前の設計書](public-gpu-personal-research-exception-20261018.md)は判断の経緯として残す。

## 実装と通常経路の分離

- `src/research/personal-contract.ts`: strictな専用契約。元のdisabled ResearchConfigとその内容hash、所有者の例外判断、取得/分析/保存の別期限、規約・robotsレビュー、コピー/保持方法を固定する。Private 3権限は `review_required` だけを受け付け、denied/expired/allowedへの偽装は受け付けない。元設定や9権限は書き換えない。
- `src/research/personal.ts`: Highreso/Rebroのlocal専用取得・read・維持・停止/取消し。既存の固定URL transport、parse5正規化、GPU観測table、取消し/削除記録を使う。通常collectorの `hasCollectionRights` / `canCollect` / `assertResearchAllowed` に例外フラグを追加していない。
- `0011_personal_research_authority.sql`: 同じprivate DBにimmutableな例外契約とrun対応を追加。価格は既存0010の `research_gpu_observations`、run/pageは既存research tableへ格納する。旧migration・旧履歴/期限を変更しない。公開用tableへの書込なし。
- `scripts/personal-local-env.ts`: ローカルMiniflareのprivate D1/R2だけを作る。PUBLIC_DB、remote bindings、Cloudflare認証は使わない。production環境はコードで拒否する。
- CLIとoffline診断: `scripts/personal-gpu.mjs`。Worker/Cron/HTTP入口からは呼ばない。両production bundleに例外実装が混入していないこともテストする。

設計段階の共有pipelineへのauthority分岐案は、通常経路への影響を小さくするため専用経路に分離した。通常のresearch read/purge/reconcileは個人研究runを拒否し、通常の証拠掃除も専用prefixを処理済みと誤記録しない。旧pipelineの既存権限条件は変わらない。

## 取得・再実行・証拠

1 sourceにつき初回1試行だけ。固定robots → terms → dataの最大3 GET、各15秒/1試行、データ1ページ/48観測まで。テスト環境ではfetcherを必須にして実HTTPへのfallbackを拒否し、developmentでは合成契約や差替えfetcher/時計を拒否する。liveの場合には実行承認済み契約と `--allow-network` が別々に必要。

承認ID/sourceごとの試行記録を、HTTP前に `research-control/personal-attempts/` へ条件付き作成する。日付を変えても回数は戻らない。DB leaseにより同時実行を抑止し、HTTP回数もDBで最大3に制限する。初回の失敗も予算を消費する。別ID/設定への変更を自動登録して再取得せず、登録済み契約不一致で停止する。v1は初回受入専用で、2回目の新規収集や承認更新機能は未実装。

raw HTMLは保存しない。最小投影（最大128 KiB）を `research/personal/` に保存し、元policy版・契約hash・`authority_kind`・`provider_permission=unconfirmed`・synthetic/live・観測時刻・元body hashを記録する。投影のhash manifestは復元対象外の `research-control/personal-captures/` に固定する。DB中断後は同じ投影だけを6時間以内かつ取得承認窓内で再処理する。投影が失われた場合は再ダウンロードせず停止する。

SQLは最大20文ずつ。完全保存前はreadに出さず、HTTP直前、投影保存直前、各DB batch前に現行契約・停止記録・leaseを再確認する。1回受入なので例外間や既存許諾経路の履歴を自動結合せず、初回観測として記録する。日次再観測/価格改定/not_seenは既存許諾経路の機能であり、この初回例外の実績として表示しない。

403、challenge、redirect、規約/robots hash変更、schema破損はsource停止。429/通信障害も初回予算を消費して停止し、Retry-Afterをmetadataに残す。再実行で解除しない。HTTP失敗を在庫0や出品消失に変換しない。source別の実行結果を返し、片方の失敗で他方を止めない。

## 保持・停止・復元

v1が対応するのは、有限のfixed_days、archiveなし、同期/バックアップコピーなしとレビューされたlocal storeだけ。`time_travel=not_applicable_local` / `backup_recoverability_days=0` を明示する。7/30日をダミーで埋めない。実際に同期/バックアップがある環境はこの契約で実行できず、対応設計が必要。Git除外や欄の入力だけでOS環境を独立確認できたとは主張しない。

- 取得窓終了・手動collection stopは新規取得だけを止める。分析期限、規約レビュー期限、保存期限は別判定。
- 規約レビュー期限では取得/readを止めるが、別に有効な例外保存枠の期限まで履歴を保持する。定期レビューだけで削除マーカーを作らない。
- 保存期限は初回runの記録時刻から固定し、契約のstorage_untilとの早い方を使う。再実行・復元・新設定で延長しない。
- 保存期限/取消し/明示削除は、本文なし削除記録を先に残し、投影と最大48行を20行ずつ削除する。旧証拠が復元されても期限を再適用する。証拠の短期削除は正規化履歴と別。
- read/collectの開始前に保持処理を実行する。`maintain` は1回の掃除、`watch` は60秒ごとのローカル維持処理。今回はwatchプロセス・OSタスク・本番schedulerを開始/登録していない。

PCや維持プロセスの停止中に物理削除を保証するものではない。再開時にはread/取得より先に照合し、遅延した期限処理は `deadline_missed` として報告する。SQL/R2の論理削除を媒体の安全消去や未知のコピーの消去と報告しない。厳密な時刻の全コピー消去を必要とする保持条件は、この方式だけでは受け入れない。日次の手動CSVやユーザーによる毎日の掃除を代替策にしない。

復元は収集/分析を閉じて行う。`research-control/` の試行・manifest・停止・取消し・削除記録を復元対象から除外し、最新のものを保持する。DBや `research/personal/` だけを戻してから現行契約でmaintainを実行する。削除済み履歴は再削除され、試行だけ残って投影がない場合は追加HTTPが拒否される。control記録の消失/巻き戻しまで安全とみなさない。

## 操作方法と承認待ち

今すぐ実行可能なoffline確認（現状の下書きは意図どおりexit 2）:

```sh
node scripts/personal-gpu.mjs check --contract docs/public-gpu-personal-research-draft-20261018.json
```

下書きは実行契約ではない。次の承認時にsourceごとに保持日数、local storeのコピー状況、取得窓、所在地/適用規約、未解決条件の引受範囲を確定し、`PersonalContractSchema` に沿う契約を作成する。所有者にコードや価格の手入力は要求しない。実行参照をこちらで捏造したり、testsのsynthetic契約をliveへ昇格したりしない。

Highresoの実装済み固定監視は国内旧版の `/terms` のみで、レビュー境界は遅くとも2026-10-31T15:00:00.000Z。国外適用版や新規約URLの採用は未実装。Rebroの別サイト規約未特定と第10条の適用問題は、判断票へ明記する。最新条件の内容確認を単なるhash転記で代用しない。

以下は**契約と初回取得の承認後だけ**に使う操作。今回は実行していない。

```sh
node scripts/personal-gpu.mjs collect --contract <承認済み契約> --allow-network
node scripts/personal-gpu.mjs read --contract <承認済み契約>
node scripts/personal-gpu.mjs maintain --contract <承認済み契約>
node scripts/personal-gpu.mjs watch --contract <承認済み契約>
node scripts/personal-gpu.mjs stop --contract <承認済み契約> --basis-ref <取得停止の根拠>
node scripts/personal-gpu.mjs revoke --contract <承認済み契約> --basis-ref <全利用取消しの根拠>
```

保存先は `work/private-personal-gpu/<store_id>/`。copy/accessレビューはこの具体的場所を対象にする。CLIのreadは件数とauthority metadataだけを出力し、価格本文や契約全文をログに出さない。内部の `readPersonalGpu` は現在の利用条件を検査した上で分析用投影を返す。Public API、外部LLM、通知、raw exportへの接続はない。

## 検証の区別

前回の設計commit `ec8ee318452fe8e82e1a81ac0ce98346b4912db4` は [GitHub CI](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/actions/runs/39057400867) の全ステップ成功を確認した。標準testは32 files / 336 tests。これは今回の新実装の試験結果ではない。

新しい `tests/personal-*.test.ts` はsynthetic契約/HTMLだけを使い、未承認拒否、元権利不変、固定範囲、期限、production/public境界、両source、失敗分離、429、途中取消し、lease、DB中断再処理、復元後の予算/削除維持、48観測のbounded batch、旧DBへの0011を検証する。workerd用の追加harnessは既存 `pnpm test:runtime` に組み込んだ。

ローカルの重点試験は3 files / 21 tests成功（Windowsではthreads / maxWorkers=2 / 120秒timeout）。`pnpm check`、既存と追加の `pnpm test:runtime`、2 Workerの `pnpm build`（dry-run）、offline preflightが成功し、schema/OpenAPI再生成の差分なし。追加workerd試験は2合成source / 6模擬GET / 6観測の保存・再実行・期限削除を確認した。direct nodeでのruntime起動はWindowsの長い一時パスで一度失敗したため、短いTEMPを設定する既存 `pnpm test:runtime` runner経由で再実行して成功した。

未承認draftでのcheckはexit 2、collectへの誤入力は契約不備として通信/保存領域作成前に拒否され、`work/private-personal-gpu/` が存在しないことも確認した。これは拒否動作の検証であり、上記の承認済み契約によるlive実行ではない。全体テストと最新commit CIの最終結果はPRの検証欄に記録する。

実データ取得・保存0件、本番稼働0日。現行source/proposal・権利grant・Wrangler/Cron・Admin・Public API・既存migrationに変更なし。0011のremote適用もない。この古いmain由来のbranchを本番Collectorへ上書きdeployしない。
