# Highreso / Rebro 初回ローカル実行契約案

2026-10-21: 新日次用は`*.daily-checkpoint-draft.json`と[PR #18 P0/P1資料](../pr18-daily-series-20261020.md)。method v2の同じcohort、128価格枠/256入力行を表す実行不可の案です。旧`daily-cloud-draft`・初回`cloud-method-v2-draft`は変更していません。例外/継続保存の承認は既済、実行窓・実リソース・日次稼働の承認は別です。

最新: 非公開・個人研究の例外と長期保存は承認済みです。実行自体は未承認。初回Cloud向けの新しい `*.cloud-method-v2-draft.json` と `nas-export.setup-proposal.json`、[NAS専用export資料](../nas-export-isolation-20261018.md) を使用してください。旧local/Cloud method-v1案は実行しません。以下は旧段階の履歴です。

最新レビュー: [source別受入条件](../public-gpu-review-acceptance-20261018.md)と[11/1以降の審査票](highreso-post-20261101.review.json)。既存契約draftに埋め込まれたmethod v1は互換確認用の未承認旧案です。新しい開始にはv2の候補config/cohortを別契約としてレビューし、config_sha256とresource pinを再作成する必要があります。旧hashを流用せず、NAS専用exportの実効分離を先に解決してください。

最新の日次拡張は [実装・未有効化設定](../personal-daily-cloud-nas-20261018.md)を参照。`*.daily-cloud-draft.json` はnull/未承認を含む非実行draft。旧初回専用契約を日次契約へ自動昇格しない。

[Cloudflare→NAS実装と検証](../personal-cloud-nas-implementation-20261018.md)が最新。ここにあるlocal契約案は移行・有効化しない。

**後続指示による位置づけ変更:** 初回実データもCloudflareで取得しNASへバックアップする方針になりました。ローカルはsynthetic検証だけです。本ページの2契約は旧ローカル方式の未承認参照資料で、承認して実行する対象ではありません。最新の[Cloudflare→NAS設定・承認案](../personal-cloudflare-nas-setup-20261018.md)を使ってください。新しい設定提案は設計専用であり、現行runtimeの実行契約ではありません。

2026-10-18。目標は10年後に価値を持つ履歴。30日削除案を撤回し、[長期履歴要件](long-term-history.md)に沿ったpersonal-gpu-v2の未承認案へ更新した。[実装・自動保守・復元・検証](../personal-continuing-20261018.md)を参照。

| source | 契約案 | 状態 |
|---|---|---|
| Highreso | [highreso_public.draft.json](highreso_public.draft.json) | draft_pending_owner_approval・実行不可 |
| Rebro | [rebro_public.draft.json](rebro_public.draft.json) | draft_pending_owner_approval・実行不可 |

owner_continuingを提案するが、承認・保存根拠・日時・規約適用・確認済みfingerprint・鍵ID・コピー確認は未設定。statusだけ書き換えて実行しない。normalized_days/storage_untilのnullだけでは保存許可にならない。data_origin=liveは将来の用途で、実取得済みを意味しない。

元のdisabled proposalと権利をそのまま埋め込み、config_sha256は `hash(stable(ResearchConfigSchema.parse(config)))` で照合する。private3権限はreview_required、提供者許諾はunconfirmedを維持する。

| source | 元configのcanonical SHA-256 |
|---|---|
| Highreso | `3da4318b8eed921ebaa702ab9f7b657d072960193d2940c77c1de4976c2e9826` |
| Rebro | `a3e2ea65659358c1dae43521d3683e3b44131d828b81ea5bb1abce2075bdc979` |

元config中の1095日目標・backup30日・2027年の期限は例外の承認値ではない。専用decisionを別に検査する。契約全体のhashは承認後の値で確定する。

## 承認が必要な範囲

- sourceを個別に選び、無回答を許諾にせず、未解決条件を明示した個人研究例外の判断を記録する。
- 初回は各社1試行、失敗も消費。固定ページのA100/H100・最大48観測、robots/terms/dataの最大3 GET、各15秒、内部retryなし。初回24時間窓は履歴の寿命ではない。日次収集の承認を含まない。
- 正規化履歴は明示した保存根拠に基づき継続。30日/10年自動削除なし。取得/readレビューと保存判断を別にし、後日の判断は原契約を変更せず追加reviewで記録する。
- 短期投影証拠7日、暗号化backup毎日/7日世代交代/最大8個/毎日復元ドリルは提案値。backupの7日は履歴の保存期間ではない。保存先、コピー台帳、実行ID、アクセス権、鍵回復、PC停止時の扱いを確認して承認する。
- Public API、公開/再配布、外部LLM、raw HTML保存、未レビューのNAS転送は対象外。価格本文をCodex/Git/診断出力へ渡さない。

## sourceごとの未解決事項

Highreso: 固定データは `https://soroban.highreso.jp/compute/instances`、監視規約は `https://soroban.highreso.jp/terms`。実装した初回適用区分は国内旧版のみ。所有者の所在地や適用範囲を日本語/JSTだけから判断しない。既存調査にある一般適用2026-11-01・国外例外2026-08-27を踏まえ、初回取得と初回reviewの保守的境界は2026-10-31T15:00:00.000Z。発効時刻の法律上の断定ではない。新規取得にこの境界を越える承認を流用しない。

Rebro: データは `https://gpu-kaitori.com/reason/`、監視規約は `https://gpu-kaitori.com/rules/`。別途参照されるサイト利用規約が未特定で、査定/買取以外の制限の適用も未解決。rulesのhash一致を全条件確認にしない。掲載事例の年月は実際の約定日時ではなく、掲載消失も成約ではない。

根拠は[既存の条件確認](../public-gpu-rights-review-20261018.md)と[未承認metadata](../public-gpu-terms-metadata-20261018.json)。今回の実装では提供者サイトを取得していない。既存fingerprintやsynthetic承認を自動転記しない。

## 初期設定と例外運用

未確定の開始T、承認時刻、初回取得終了、分析期限、再review日を実際の確認結果で確定する。収集を急ぐため短期削除契約で取得して後から期限を延ばさない。

primary候補はcheckoutの `work/private-personal-gpu/<source-id>/`。今回未作成。vaultと保護鍵は独立媒体/アクセス範囲/現在controlの保全を確認して選ぶため、実パスを推測しない。Gitのwork除外は同期やバックアップ不存在の証明ではない。

承認後に専用local DBへ0012まで適用する。remote DBは使わない。DPAPI鍵・実契約・automation manifestをGit外に設定し、停止状態のTask XMLをレビューした後、登録/有効化する。日々の保守・backup・復元検証はタスクが実行する。毎日の手動コマンドや鍵入力は要件にしない。

実行前の残件は、実際のsource別例外判断、規約/robotsレビュー、日時、保存場所/コピー/アクセス/鍵回復の確認、初期設定とタスク有効化の承認、初回取得自体の承認。今回これらを承認済みにしたり、日次観測開始済みと扱ったりしない。

## offline診断

両draftはruntimeに拒否されることが正しい。次の診断はHTTPやlive保存先を作成しない。

```sh
node scripts/personal-gpu.mjs check --contract docs/personal-execution-20261018/highreso_public.draft.json
node scripts/personal-gpu.mjs check --contract docs/personal-execution-20261018/rebro_public.draft.json
```

期待値はpersonal_contract_invalid / blocked / exit2。実装のsynthetic検証と、実行契約の承認・実データ取得を区別する。
