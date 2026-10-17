# Highreso / Rebro 個人研究例外の設計案

作成日: 2026-10-18 JST。実装の参照commit: `e60d6d204d05408b22be13421d028dc3f5e4f744`。対象は固定公開HTMLの2 sourceだけ。

**所有者が今回選択した範囲は「例外の設計・準備まで」。例外の実行承認、権利grantの変更、価格の取得・保存、本番変更は含まない。** この文書と[判断票の下書き](public-gpu-personal-research-draft-20261018.json)は実行設定ではなく、現行collectorは受け付けない。既存proposalはdisabled、取得・保存・内部分析は `review_required` のまま。

## 判断の分離

所有者から「問い合わせ済みだが返信が無い」と申告された。問い合わせ日時、宛先、本文、返信状況をこちらで独立確認したものではない。こちらから問い合わせや追送は行っていない。

今後採用する場合の案は、提供者の許諾が未確認である事実を残したまま、所有者が未解決条件を認識して限定的な内部実行を承認する仕組み。無返信、公開ページ、robotsの許容、個人研究目的を提供者の許可に変換しない。所有者の判断によって適用規約や第三者の権利が変更されるわけでもない。

| 記録 | 意味 | 今回の状態 |
|---|---|---|
| `source.policy.rights` | 既存9区分の権利評価 | 全項目を変更しない。Private 3区分は `review_required` |
| 提案する `authority_kind=owner_personal_research_exception` | 未解決事項を含む所有者の内部実行判断。提供者許諾とは別 | 未実装・未承認 |
| `owner_execution_approval_ref` | 具体的なsource、条件、保持、取得窓を承認した記録 | null。今回の準備承認を流用しない |
| 接続・取得・公開の実績 | 実行結果の記録 | 今回はすべて未実行。技術調査やsynthetic成功と区別 |

`policy.rights` を一時的にallowedへ置き換えたcloneで既存gateを通す方法は採用しない。既存の `storage_review_hold` も提供者条件に根拠を持つ保存専用枠なので、この所有者例外の代用品にしない。

## 最初の実行単位の案

次に実装・初回取得を承認する場合でも、各sourceを独立した1回のローカル試行に限定する。日次収集、本番移行、追加GPU世代はこの初回承認に含めない。

| source | 固定データURL / 対象 | 未解決事項と初回前の準備 |
|---|---|---|
| `highreso_public` | `https://soroban.highreso.jp/compute/instances` の明記されたA100/H100。インスタンス・GPU仕様/台数・時給/月額・ストレージ・明記された税/費用条件 | 公開ページへの規約適用、所在地による適用版を確定または具体的な未解決事項として判断票へ記録。適用版と監視URLの一致が未確認のまま実行しない |
| `rebro_public` | `https://gpu-kaitori.com/reason/` の選別掲載買取実績のA100/H100。品名、年月、数量、単価 | 別途参照されるサイト利用規約の所在と第10条の適用が未解決。この未解決点を明示して承認対象にする。`rules/` のhash一致を全規約確認済みと表示しない |

既存[条件調査](public-gpu-rights-review-20261018.md)のHighreso改定日・国外例外は引き続き考慮する。国内旧版を使う場合の取得/readレビュー境界案は `2026-10-31T15:00:00.000Z`。旧版適用をJSTやサーバー所在地から推定しない。国外適用版が必要な場合や、その日以降に旧 `/terms` が残る場合は固定URL契約を別途見直す。現在のproposalの2027-01-15をそのまま承認期限にしない。

取得条件は既存の上限を引き継ぐ: robots → 規約 → データの最大3 GET、データ1ページ、各15秒、各1試行、入力100行/採用48件/HTML 1 MB以内。ログイン、課金、認証回避、redirect追従、任意URL、追加ページ探索は対象外。raw HTMLはメモリ内で解析するだけで、画像・広告・取引相手欄・原文を保存しない。投影証拠は既存上限128 KiB以内。

既存の「1 source / UTC日」は、日をまたげば再実行可能なので初回1回の制限としては不十分。新しい例外の試行予約をsource・承認IDに対して永続化し、最初のHTTPより前にlease付きで消費する設計とする。失敗も1試行を消費し、日付・config hash変更やsource ID別名ではリセットしない。承認IDの自動発行・自動更新は禁止。同じcaptureの6時間以内のDB再処理は追加HTTPなしでのみ許可する。別の新規試行は別承認とする。

HighresoでH100が存在しなければ未掲載とし、成功実績に含めない。Rebroの掲載年月を取引日時にしない。価格不変は再観測、消失は同一完全scopeでのnot_seen、HTTP失敗は未観測。中古事例を全実売市場、レンタル提示価格を稼働率として扱わない。

## 承認前に埋める判断票

JSON下書きは `docs/` に置く。実行用source JSONに重ねたり `--approved-config` に渡したりするものではない。sourceごとに次を固定した実行案を作ってから、所有者の実行承認を得る。

1. 取得・private保存・内部分析それぞれの例外範囲、未解決条件、判断理由、承認参照、開始時刻・終了時刻。対象は名前を固定した2 sourceのうち選択した1社だけでもよい。
2. source設定と例外契約の内容hash、field/method版、適用規約の識別、確認したURL・fingerprint・レビュー期限。現在の調査metadataはunreviewedなので自動採用しない。
3. 個別の証拠保持、正規化履歴保持、取得停止後の保存/分析、全コピー期限と取消し時の扱い。実行承認の取得窓と履歴の保存期限を別にする。
4. ローカル保存先、利用者のアクセス範囲、同期/バックアップの有無と復元可能期間、期限処理方法。`.gitignore` はGitへの混入防止であり、アクセス制御・クラウド同期除外の証明ではない。

現在の1095日は研究目標、証拠7日・backup30日は未承認proposalの値。今回の下書きでは承認日数に転記しない。まず有限の `fixed_days` を採用する案とし、具体的日数・全コピー期限は未決定のまま残す。nullを無期限保存やコピー不存在と解釈しない。`until_revoked` や定期収集への拡張は初回案に含めない。

ローカルMiniflareにCloudflare D1の実Time Travelがあると表示しない。現行schemaはTime Travelに7/30日を要求するため、便宜的に7を埋めず、後述のlocalコピー契約を先に実装する。OSバックアップや同期先のコピーがあるなら、それも保持設計に含める。未確認なら実行できない。

## 次の実装差分案（今回は未実装）

| 変更箇所 | 必要な差分と境界 |
|---|---|
| `src/research/schema.ts` / 新しいlocal例外契約 | 提供者権利と所有者の実行判断を別型にする。既存ResearchConfigは従来どおり拒否。例外は専用のstrictな契約でsource/URL/field/期限/保持/承認を検査し、未知キーや他sourceへの適用を拒否する |
| 専用local実行入口 / `scripts/local-env.ts` | CLIの明示opt-inと承認済み判断票の両方を要求。承認検査が済むまで保存領域を作らない。例外の経路へPUBLIC_DBを渡さず、test/development以外は拒否。Worker bundle・Cron・HTTP入口には接続しない |
| `src/research/public-gpu-network.ts` / `pipeline.ts` | 一般の `hasCollectionRights` / `canCollect` は緩めない。例外経路は共通の内部authority判定結果をHTTP前・capture前・各DB書込前・再開時・read時に照合する。booleanの権利無視フラグや人工的なallowed configを渡さない。既存停止/Retry-After/leaseも維持する |
| config/capture/runの証跡と前進migration | `authority_kind`、例外ID/hash、承認参照、元の権利評価、取得窓、保持契約をimmutableに記録。run/capture hashにも判断票を含め、後から差替え不可にする。既存0001〜0010を書き換えず、実装時に未使用番号を確認して追加する |
| `src/research/retention.ts` / read / restore | providerの保存権は未確認のまま、内部の保存判断を `owner_exception` と識別する。既存のallowedやreview_holdへ混ぜない。取得停止、分析停止、保存終了を分離し、過去runを新承認で自動延長しない。localコピー契約ではTime Travelをnot_applicableとして区別し、実バックアップを別検証する |
| local保持処理 | 保存先と全コピー期限を固定し、期限前に実行可能な決定的な自動処理を用意する。PC停止時は起動直後のread/収集より前に期限照合する。オフライン中の物理削除期限を守れない構成を「準拠済み」としない。所有者の日次手作業を要件に戻さない |
| 診断 / テスト | 未承認票はHTTP0・保存0、承認済み例外はsyntheticだけで検証。診断は「個人研究例外・provider許諾未確認」と明示。configuration passをlive/prod稼働へ読み替えない |

共有関数の変更が必要なので、型だけ追加して完成とは扱わない。後続実装の受入ではnetwork・evidence・ingest・read・retention・restoreを通す。古いcaptureは例外なしとして従来gateで評価し、同一sourceでも権限根拠の異なる履歴を自動結合/再利用しない。例外由来のデータにはPublic/derived export・外部LLM経路を用意しない。

## 例外実装の停止条件とテスト項目

以下は将来実装時の受入条件。今回の実装済み/検証済み機能ではない。

| 入力・事象 | 期待する動作 |
|---|---|
| draft、承認参照なし、対象外source、期間外、保持/コピー契約未確定 | HTTP/永続化前に拒否 |
| 3 private権限がreview_requiredだが、具体的範囲の有効な例外あり | 指定local入口だけ実行可能。元の権利値は変更せず観測へ記録 |
| denied/expired、明示的な取得禁止・停止要求、取消し | 例外で上書きしない。取得/read停止。保存は独立して評価し、明示保存終了・適用削除期限に従う |
| robots不許容、403/認証要求/challenge/redirect、terms hash変更、schema異常 | sourceを停止。追加取得や迂回なし。もう一社は独立して評価 |
| 429/Retry-After、再起動、並行実行、日付/config変更 | 初回試行予算を復活させない。capture再処理にもHTTPを追加しない |
| 取得窓終了、定期レビュー期限、分析停止 | 新規取得/readの対象だけ止める。別に有効な例外保存枠があればその期限まで保持。レビュー期限だけで永久削除しない |
| 許諾未確認は変わらないが例外保存期限到来 | 取得時に承認した有限保持を適用。コピーを含む期限処理と本文なし削除記録を残す。新判断票で過去期限を自動延長しない |
| DB/R2の古いコピーを復元 | 復元対象外の最新取消し/削除記録と現行例外を先に適用。失効した実行・readを復活させない |
| 後日回答を受領 | 新しい根拠として再審査。回答があるだけで許可扱いにせず、過去データの利用条件も別確認 |
| production、Public API、外部LLM、raw exportへ流用 | 有効な例外でも拒否。既存FX/Models/GPU/電力の権利gateは不変 |

後続の実装時はこのsynthetic試験に加え、既存check/test/test:runtime/build（dry-run）、offline preflight、schema再生成を実施する。liveは実装・保持方法・sourceごとの判断票の承認後に別途1回のみ実行する。

## 現在の納品と次の境界

今回用意したものは設計、未承認の判断票、既存資料からの案内だけ。runtime・policy・proposal・migration・Wranglerに変更なし。価格のlive取得、ローカルDB/R2への実データ保存、問い合わせ送信、Secret変更、本番deployは0件。

次は判断票の未決定項目を確定したうえで、例外経路を実装しsynthetic検証する段階。その後の初回収集承認は提供者許諾の取得とは別に記録する。初回ローカル受入に成功しても日次稼働とは報告しない。日次自動化と本番統合は、最新productionとの差分・自動保持を含む別の実装/承認単位とする。

## この準備差分のローカル検証

- `pnpm check`: format / TypeScript / boundary成功。
- `pnpm test -- tests/public-gpu-preparation.test.ts tests/public-gpu-contract.test.ts tests/research-contract.test.ts --pool=threads --maxWorkers=2`: 3 files / 33 tests成功。既存gate・parser等のsynthetic回帰試験であり、未実装の例外経路の合格実績ではない。
- `node scripts/public-gpu-check.mjs`: 両sourceが `policy_blocked`、exit 2、HTTP/保存なし。
- `node scripts/public-gpu-check.mjs --config docs/public-gpu-personal-research-draft-20261018.json`: `invalid_public_gpu_config`、exit 2、HTTP/保存なし。判断票を取得設定として誤用しても実行できない。
- 判断票JSONの構文と設計書の相対リンクを確認。変更対象は文書/判断票だけで、runtime・既存設定は不変。
