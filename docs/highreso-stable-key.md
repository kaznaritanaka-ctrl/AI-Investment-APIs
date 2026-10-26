# Highreso 識別キー安定化（配備前レビュー用）

2026-10-27。ブランチ `codex/highreso-stable-key`。本変更ではpush、デプロイ、本番D1への接続・書込み、実サイト取得を行わない。元の観測、適用済みmigration、権利、公開範囲、Secrets、Cron、NASは変更しない。

## 問題と変更

型番の表示名をキーにすると、表示名だけの変更でfirst_seen/not_seenが増える。Highreso限定の `domestic-gpu-html-v3` は、`hr:v2:` + SHA-256(stable({reported_product,gpu_count,vram,storage_gb,os_family,unit})) + `:` + 出現順位を使う。stableは既存のキー順整列JSON、vramは既存のGPU識別結果の `vram_gb`。OSは型番内の単独の `ubsNN` を抽出する。未認識・複数OSの行だけは `hr:fallback:v1:` の別名前空間で、型番そのものと製品・GPU数・VRAM・ストレージ・単位を含むハッシュキーへフォールバックする。OSを推測せず、型番変更時の同一性も推定しない。他の行は通常どおり処理する。新しいOS表記は別途parserレビューする。

通常キーには価格・型番・規約版・取得日時を含めない（OS不明時のフォールバックだけは型番を含む）。型番を昇順（ASCII/BINARY）で並べ、同条件の行に1から順位を付ける。物理マシンの同一性や、末尾文字の対応規則を推定するものではない。同条件の重複数が変わる場合は順位が入れ替わり得る。この制約を隠さず、履歴は観測された掲載内容の系列として扱う。

v2→v3初回は直前の同source・同query・同synthetic区分のcomplete snapshotだけを内容キーで照合する。直前のv2行は10/27 first_seenも含めて新キーを計算できる。価格変更はrevised、同一内容はreobserved。型番のみの変更はrevisedとし `domain_json.instance_id_changed_from` を残す。次の日の同一内容はreobservedに戻る。照合した旧行をnot_seenにしない。実際の消失・再登場は従来のnot_seen/reappeared。外部削除マーカー、現行の権利、旧configの承認、元の保持期限をすべて維持する。

## review-scope

稼働中の `config/proposals/research/highreso_public.json` はv2のまま。配備候補は `config/proposals/highreso-stable-key.json`。同じ既存権利・scope・保持条件のまま、method_version、技術更新を識別するpolicy版、wireレビュー参照、旧config hashのhistory_accessだけを変更した候補で、自動的に有効化しない。Claude Codeによる相互レビュー前の候補であり、レビュー承認済みとの意味ではない。

`adoptReviewedResearchConfig` は、対象がHighresoのv2→v3で、同source/scopeの旧hashを明示したhistory_accessがある場合だけ、このmethod境界の履歴利用を認める。既存のconfig_versionsはsource/policy版が一意なので、候補では同じ許諾内容に技術更新用のpolicy版末尾を付ける。許諾内容・対象・保持は広げない。他adapter・他method境界は従来どおり拒否する。別scopeの取得や新grantを許可しない。配備直前に本番の現行config hashと候補の旧hashを再確認し、不一致なら候補とレビューを更新する。

## 10/26と10/27の対応表

新規private migrationは `0018_research_identity_links.sql`。source、観測IDの組、basis、method、記録日時だけの追記表で、UPDATE/DELETE禁止。対応先の一意性と、同source・同synthetic区分・complete・時刻順・旧reobserved→新first_seenをtriggerで検査する。観測へのFKは置かない。保存期限による観測削除を妨げず、価格や本文を残さない監査用IDだけを保持する。元の48件・not_seen行は書き換えない。

生成器 `scripts/highreso-identity-links.mjs` はネットワーク機能もD1クライアントも持たず、SQLファイルを新規作成するだけ。入力は10/26の**完全な**run ID、`5afcf3ba`から始まる10/27の**完全な**run ID、固定ISO記録日時、出力先の4項目。runの日付はscheduled_forをJSTに換算した10/26・10/27の窓で検査する。価格だけでなく製品、GPU数、VRAM、ストレージ、OS、単位を同値グループ化し、旧新の型番昇順順位で組む。グループ件数が不一致、OS不明、価格不一致等は全件unmatchedとして報告する。旧/新選択件数も出し、対象runがない場合も0件として分かる。

生成SQLはSELECTのみで、`proposed_sql`列にINSERT文を**文字列**で出す。実行しても書込みはしない。担当AIが、既存の承認された非公開環境でdry-run結果を確認し、旧新48件ずつ・pair48件・unmatched0件・対応条件をレビューする。今回の作業では本番に接続しない。適用するINSERTだけを別途ファイルにまとめ、別承認後に適用する。同じlink_idの再適用は何もしない。異なる対応との衝突はunique制約で停止する。

## Private読取とAdminの互換性

`readPublicGpuHistory` / `comparePublicGpuRuns` とCollectorの `highresoLatestPrices` は、同じ現在権利・期限・削除ゲートを通った両端の観測についてだけ対応表を参照する。対応表で繋がる旧新のキー、v3移行時のprevious_observation_idを使って系列を繋ぎ、同run内の誤った旧not_seenを読取投影から除く。raw観測は不変。投影がキーやchange_kindを変える場合は `original_record_key` / `stored_change_kind` を保持する。履歴窓の外の対応先を権利検査なしで読むことはない。

v2/v3で解析する価格・scope・原単位は同じなので、この境界だけdaily seriesを互換とする。他のmethod/scope境界は従来どおり分離する。改名だけの比較は `state='instance_id_changed'`、`identity_change_label='型番変更'` を返し、価格変化率は出さない。改名と価格変更が同時の場合は価格変更のstateに同じ改名情報を併記する。

型番変更があるprice要素にだけ、AdminRead v1のoptionalな `instance_id`、`instance_id_changed_from`、`identity_change_label`（「型番変更」）を追加する。変更のない要素には3項目を一切出力せず、従来の応答形状を完全に維持する。旧strict validatorを使うAdminクライアントには同梱contractの更新が必要。Admin更新までは型番変更エントリがまだ出なければ従来どおり表示できるが、変更エントリが1件でも出ると旧strict validatorは応答全体を拒否する。このためAdmin更新をCollectorより先に配備し、3項目あり・なしの両方とラベル表示を確認するまでCollectorの配備を止める。別リポジトリのAdmin/#highresoはこのラベルを表示する更新と**協調配備**が必要で、このリポジトリ内にはその画面実装はない。過去30complete runで系列を繋ぎ、リンク先のfirst_seenを改名として読むので、first_seenが10/27に巻き戻らない。窓外・期限切れ・削除済みの履歴を復活させない。3回のbounded D1 query（現行policy、snapshot、対応表）を使う。

公開API、PUBLIC_DB、公開OpenAPIは追加しない。「private API」は既存private関数／AdminRead RPCを指し、新しいHTTP経路は作らない。

## 本番手順（今回実行禁止）

1. Claude Sonnetとの相互レビューと全テスト・CIを完了する。その後Admin側のcontract/表示更新を先行配備し、変更エントリあり・なしの応答の受理を確認する。異論はOpus判断。未完了なら停止。
2. 適用直前の本番設定・版・既存の復旧手順を確認。既存データ相当のローカル検証とmigrationの相互レビューを確認し、private 0018だけを適用する。**migration → Collector deploy** の順序を厳守し、journalと表の適用確認前に新Collectorを配備しない。新Collectorは0018のjournalも確認し、不足時は研究処理を停止する。既存migrationは変更しない。
3. 対応表SQLを生成し、別途承認された本番read-only dry-runで旧新48/48件・pair48件・unmatched0件を確認。条件が合わなければ適用せず報告。
4. 対応表の本番書込みはKazの別承認後、レビュー済みINSERTのみ適用。元観測は削除・更新しない。
5. 候補configについてレビュー済みadoptReviewedResearchConfigを明示実行する。更新が稼働Collectorと競合しない保守窓を取り、同じ候補を正式設定へ反映して先行更新済みAdminに対してCollectorを配備する。単に候補JSONを置くだけでは有効にならない。権利grantや公開範囲を増やさない。
6. 次の通常の日次収集で48件がreobserved（実際の改定はrevised）、型番由来のfirst_seen/not_seenが0、既存の公開APIと他sourceが正常であることを確認する。追加のHighreso取得はしない。

## ロールバック

失敗時は承認済み直前のCollector/Admin版とconfigに戻す。research_sourcesの現行hashをv2へ戻す操作が必要なら、停止した保守窓でレビュー済みの明示操作を行う。v3設定のまま旧Collectorを動かさない。新しい本番設定の上に古いmain設定を上書き配備しない。

0018と対応表、追加済みのv3観測は削除・変更しない。旧Collectorは追加表を参照しない。保持処理・R2 control markers・既存の削除期限は維持する。誤ったリンクが見つかった場合は該当投影を利用停止して報告し、リンクの上書き/削除で修復せず、別途レビュー済みforward migrationで扱う。

## ローカル検証

合成fixtureだけを使う。`tests/highreso-stable-key.test.ts` が新キー、重複順位、v2移行、改名、価格変更、消失・再登場、旧履歴不変、削除マーカー、private読取投影を検査する。`scripts/highreso-identity-links.test.mjs` はNode SQLiteでdry-runの無書込み、順位対応、未対応群、再適用、不変triggerを検査する。実ページや本番データをfixtureへ追加しない。

2026-10-27ローカル検証結果：Node 24.22.0 / pnpm 11.19.0、frozen-lockfileのオフラインinstall成功。安定キー・候補config・対応表・既存データ入りmigrationのNodeテスト8件が成功。既存GPU/Admin回帰94件と新規Highreso移行7件は、通常のlocalEnvを一時的なNode SQLite＋メモリR2互換環境へ差し替えて成功（101件）。差替えはwork/と/tmpだけに置き、通常テスト実装を変更していない。Cloudflareの実行環境そのものの合格とは扱わない。

check（整形・型・境界）、build（dry-run）、offline preflight、生成schema検査は成功。通常のworkerd runtimeはサンドボックスの `listen EPERM 127.0.0.1` により実行不可。通常localEnvの統合テストも起動待ちで中止した。ネットワーク／ローカル待受けが許可されたCIでのcheck/test/test:runtime/build完走が引き続き必要。Claude SonnetのCLIレビューは未ログインで実行不可だったため、相互レビュー承認は未取得。push禁止に従いCI/PRの起動・作成はしていない。

通常環境のparser/contract/DOMテスト3ファイル35件も成功。旧型番が過去に異なるストレージ条件で再利用されていた場合も、観測ごとに内容キーを解決して別条件の系列を誤って併合しない。共有のstable/hash/hashBytesは処理を変えずにsrc/canonical.tsへ分離し、安定キーの単体検証で同じ実装を使用する。

### localhost許可後の追検証（2026-10-27）

通常のD1実行で0018の複数行SQLが `incomplete input` となったため、0016/0017と同様に各SQL文を1行に揃えた。SQLの内容・制約・不変triggerは変更していない。migrationローダーや通常localEnvの差替えは行わない。

Collectorのテスト用migration journalにも0018を追加した。既存の未適用migration検査には0018欠落の場合も加え、R2読取・HTTP・取得処理より前に停止することを確認する。本番のschema gateは変更しない。

Node 24.22.0 / pnpm 11.19.0で `pnpm run check`、`pnpm test`、`pnpm run test:runtime`、`pnpm run build` がすべて成功。通常localEnvでVitest 55ファイル・599件、Nodeテスト13件（合計612件）が成功し、失敗・skipは0。初回全件実行で発生したD1起動hookのtimeoutは単独5件と全件の再実行で解消し、timeout設定は変更していない。

workerdではGPU 1,051件・22ページ・23回の継続処理、Models 50/250/1,000件、private PoC 50行と優先Models 500件、障害復旧・保存期限処理を合成データで確認。buildはCollector/APIともdry-runだけを実行し、Wranglerの更新確認バナーとmetrics送信は無効化した。offline preflight（`network_performed=false`）、生成schema/OpenAPIの差分なし、`git diff --check` も成功。Cloudflare接続・実サイト取得・push・デプロイ・本番書込みは行っていない。相互レビューとCIは引き続き未実施。

### review-1 指摘修正後の検証（2026-10-27）

変更のないAdminエントリを旧strict契約で受理でき、追加3項目が一切ないことを合成データで確認した。OS未認識・複数OSと通常行が混在してもページを処理でき、通常キーが変わらず、フォールバックの型番変更を同一系列へ誤結合しないことを検査した。Highreso旧版とRebroのcompleteページでは、前回runの削除ゲートが従来どおり働くことも確認した。前回runの検索・読取条件はHighreso v3またはcompleteページに限定する。

Node 24.22.0 / pnpm 11.19.0で `pnpm check`、`pnpm test`、`pnpm test:runtime`、`pnpm build` がすべて成功。Vitest 55ファイル・602件、Nodeテスト13件（合計615件）が成功し、失敗・skipは0。通常のlocalEnv/workerdを使用し、互換環境への差替えはしていない。runtimeではGPU 1,051件とModels 50/250/1,000件を含む合成データの検査が成功した。

offline preflightは `network_performed=false`。生成schema/OpenAPIの差分なし、`git diff --check` 成功。buildは更新確認・metrics送信を無効にしたローカルdry-runのみ。外部ネットワーク・Cloudflare操作・push・deploy・本番書込みは行っていない。PR本文はローカルの `docs/highreso-stable-key-pr.md` のみ更新した。今回の修正後の相互レビューとCIは未実施。
