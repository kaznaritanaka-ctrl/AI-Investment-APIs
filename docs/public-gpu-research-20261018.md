# Issue #17: 公開GPUページのPrivate研究用観測

対象は [ownerの実装指示](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/issues/17#issuecomment-6236971209)。PR #16 HEAD `5c12d0bb92252d0893a3776a5f100763fec56181` をbaseに、別branch `codex/public-gpu-private-research-20261018` で実装する。#16未マージのためstacked Draft PR。既存mainと本番PoC Privateには差があり、このbranch全体のdeployは禁止する。

**実観測履歴0件、継続収集0日、新規grant0件、本番変更0件。** 以下のHTTP確認は低負荷の接続・構造調査であり、許諾済みcollectorによるlive smokeや観測履歴ではない。ページ本文・価格をGit/fixture/DBへ転記していない。HTMLはメモリ上だけで調べ、metadataだけ記録した。

同日追補: [公開条件の追加調査・source別初回準備](public-gpu-rights-review-20261018.md)で、Highresoの改定告知/新旧対照表/新版を特定した。一般適用は2026-11-01、国外ユーザー例外は2026-08-27。Rebroのサイトマップを確認した範囲でも別サイト利用規約は未特定。両社のgrantは変更せず、`node scripts/public-gpu-check.mjs` で通信/保存なしに不足gateを確認できる。

## ソース別評価（2026-10-18 JST）

| 項目 | Highreso / GPUSOROBAN | Rebro / GPU買取センター |
|---|---|---|
| 固定データURL | [インスタンス一覧](https://soroban.highreso.jp/compute/instances) | [選別掲載の買取実績](https://gpu-kaitori.com/reason/) |
| source suitability | 公開インスタンス料金の時系列候補。成立価格・稼働率には不適 | 選別公開事例の改定・再観測候補。全取引feed・市場指数には不適 |
| basis | `rental_quote` / `provider_public_quote` | 明示された「買取実績」節だけ `buy_execution_report` / `selected_public_case`。提示価格へ見出しが変わったら停止 |
| 初期scope | 明記されたA100/H100、時給と月額。構造確認時はA100の掲載を確認、H100の実収集成功とはしない | 明記されたA100/H100、品名・年月・数量・単価だけ。取引相手欄は廃棄 |
| 認証・公開性 | ログインなし、HTTP 200 / text/html | ログインなし、HTTP 200 / text/html |
| robots | [robots.txt](https://soroban.highreso.jp/robots.txt): `User-agent: *`、sitemap、禁止指示なし | [robots.txt](https://gpu-kaitori.com/robots.txt): `User-agent: *`、`Allow: /`、sitemap |
| 条件確認先 | [terms](https://soroban.highreso.jp/terms)、[改定告知がある公式トップ](https://soroban.highreso.jp/) | [通信買取規約](https://gpu-kaitori.com/rules/)、[プライバシー](https://gpu-kaitori.com/privacy/) |
| 未解決 | 9/25告知は11/1一般適用の予告と判明（国外は8/27適用）。収集主体への適用版、自動抽出・Private履歴保存・内部分析の根拠が必要。現行terms監視だけで別URLの改定を検知できるとはしない | rulesは通信買取サービス向けで、別途「サイト利用規約」への言及がある。サイトマップ確認後も公開価格収集に適用される全文・追加条件は未特定。宅配買取条件を自動適用/自動除外しない |
| 自動取得 / 保存 / 内部分析 | 各 `review_required`、disabled | 各 `review_required`、disabled |
| public / normalized / derived / commercial | 各 `review_required` | 各 `review_required` |
| raw / 外部LLM | `denied` | `denied` |
| 実装・合成検証 | 固定HTML adapter / synthetic fixture / Private D1・R2・workerd | 固定HTML adapter / synthetic fixture / Private D1・R2・workerd |
| collector live smoke / 実観測 / 日次運転 | 未実施 / 0件 / 未開始 | 未実施 / 0件 / 未開始 |
| キー | この公開経路は不要 | この公開経路は不要 |

robotsは両社とも `2026-10-17T16:50:41Z` に200 text/plainで直接確認。価格ページの技術確認は同日16:51、17:06、17:18 UTCの3回だけ（HTTP形式、要素種別、table列幅/closing tagの確認）。最後の確認でHighreso各tableは8/8/12列、Rebroは5列、結合セルなし。価格値は出力・保存していない。以下は最初の応答の同一性metadataであり、収集許可・恒久的アクセス保証ではない。

| URLのsource | 技術確認時刻（UTC） | bytes | HTML SHA-256 |
|---|---|---:|---|
| Highreso | 2026-10-17T16:51:34.769Z | 445655 | `59e1dc2331c0775343d5cb56396e4854593c1255f1d332f98ff9b2e9bdd1ad86` |
| Rebro | 2026-10-17T16:51:35.001Z | 86993 | `ccf63edcb8882095e36c153beff46735928c10a1a1823bfbf4876e273494ccc4` |

Highreso規約にはサービス/サイトの知的財産と過度な負荷等の禁止があるが、公開数値の継続データベース化を積極的に許可する根拠は確認できなかった。Rebro規約にはサービス用途の制限があるが、公開ページ閲覧者への適用範囲は未確定。robots・HTTP200・一般的な事実の著作権論・問い合わせへの無返信のどれも3権限のallowed根拠にしていない。公式未公開feedへの返答を必須条件にはせず、まず**この公開URL・項目・頻度・用途に対する根拠**をsource別にレビューする。

確認できない間は当該sourceを停止。代替は、同じ公開範囲への具体的な許可/適用条件をownerが確認するか、別の許諾済みsourceを別審査して自動接続すること。毎日の価格転記・CSV運搬へ戻さない。外部問い合わせは本作業で実施しない。

## 実装と既存基盤との関係

- `src/research/public-gpu-html.ts`: parse5のHTML5 parserで対象tableを抽出。固定header・行幅・明示closing tag・数値形式・重複・上限を検証する。途中切断をHTMLの自動補正で完全取得へ昇格しない。未知のHTML形式は停止し、公開本文やリンクから任意コード/URLを実行しない。
- `domestic-gpu.ts` の観測区分/欠測契約と `gpu.ts` の識別辞書を再利用。インスタンス時給に `node_hour`、販売単位に `instance` を追加。ノード料金をGPU1台へ割らず、月額を時給へ換算しない。SKU/VRAM/PCIe・SXMは記載だけから判定し、地域・専有・割込み・最低契約・税など未確認条件はunknown/null。
- Highreso: 税/インスタンス/ストレージ/転送料を含むというページ注記が一致した場合だけincludedと記録。ストレージ容量、SKU、GPU枚数、インスタンスID、課金単位を保持する。CPU/RAMやソフトウェア本文は今回のfield scope外。Rebro: 単価は1GPU単位、`reported_quantity` は別欄。年月は `source_period` + month精度、`transaction_at` / `source_published_at` はnull。product/monthは観測可能な公開事例キーであり約定IDではない。同月同製品の重複は推測で統合せず停止する。
- `hasCollectionRights` に既存の有効期間/enabled/Private3権限判定を抽出。既存 `canCollect` は従来のPhase2 GPU / Models追加gateも引き続き要求する。研究経路はResearchConfigのfield/scope/owner/terms/wire/retention/access gateを全て適用する。9権限を緩める共通例外は追加しない。
- shared `research_sources/runs/pages/config_versions` はsource別policy hash、1 UTC日1run、5分lease、immutable capture、checkpoint、権利/保持/復元防護に再利用。**GPUの値は新規private `0010_private_gpu_research.sql` の `research_gpu_observations` だけ**。電力 `research_observations` とpublic DBへは書かない。0001〜0009は変更しない。
- phase2 `gpu-pipeline` への直接接続は見送った。既存の公開snapshot lifecycleと取引listing契約を持ち、Rebroの選別実績・月精度をそのまま表せないため。識別/比較契約を再利用し、private研究の既存保持機構へ接続する方が小さく、公開への誤流入を防げる。
- D1はimmutable観測、前観測ID、hash、source URL、observed_at/recorded_at、methodを保存。R2は最大128KiBの型付きprojectionとconfig/query/payload hash、source/policy/terms/method版、取得時刻、synthetic、complete範囲だけ。raw HTML、広告、匿名取引者欄は保存しない。normalized履歴と短期evidenceの権利・保持は別。
- 同じ価格の翌日取得も `reobserved` として追加。価格/条件変更は `revised`。同一scope/configの直前completeページにあり今回は無いものだけ `not_seen`。消失に価格や成立区分を引き継がない。403・429・schema破損から消失や在庫0は生成しない。completeはこのURL/選定GPUの範囲だけで、市場全体の網羅性ではない。
- 既知の大幅価格変化だけでは隔離しない。比較には既存 `compareDomesticGPU` の条件一致判定を使い、未確認条件を埋めて騰落率/市場指数を作らない。

## 負荷・停止・復旧と機械可読状態

1 sourceあたり1 UTC日1run / data HTML **1ページ**。robots（最大16KiB）→terms HTML（最大1MB）→data HTML（最大1MB）の固定3 GETだけ。HTMLとしては1日2ページ。リンクを巡回しない。UAは `AIInvestmentResearch/0.1` とリポジトリの連絡先URL。各要求は最大15秒、内部retryなし、永続HTTP予算は3回/run。data入力最大100行、選定結果最大48価格（時給/月額は別行）。超過は上限を増やさずscopeを再レビューする。

robots hashとtermsの可視本文hashは別途ownerレビューした値と一致を要求する。**内容の一致は許可の代わりではない**。動的footer等の変化でも保守的に停止する可能性がある。hashが変わったら原文差分・適用条件を再審査し、新policy版で採用する。401/403、redirect、challenge、構造/数値破損は同じconfigで翌日も停止する。新しいsource IDで停止や日次予算を回避しない。

429/timeout/5xx等はその場で終了し、最低翌日またはRetry-Afterの遅い方までsource全体をdeferする。停止したまま裏で再試行しない。受信済みprojection後のDB障害は元captureで再開でき、追加HTTPは不要。復旧可能なcapture窓は既存の6時間。SQLは20文ずつ、最大48新規+48消失でも単一巨大transactionにしない。partialはPrivate読取にも出さない。

`collectPublicGpuDay` はsource別state/run_id/coverage/reasonと最小run metadataを返し、片方の失敗後も次を実行する。未完了ならpartial/unknown、failed acquisitionをcomplete 0件と表現しない。D1 runにはlast_error/retry_at/http_page_attemptsも残る。朝の監視へ渡せるが、通知送信・Admin UI・Cronは追加していない。schema停止は新規取得だけを止め、既存の許可が有効な履歴のreadを理由なく削除/禁止しない。

## source別有効化の残件と初回検証

両候補は `config/proposals/research/{highreso_public,rebro_public}.json` のdisabled案。技術調査hashを承認済みfingerprintに自動昇格させていない。順序はsourceごとに独立する。

1. **Highreso**: [特定済みの現行/改定版](public-gpu-rights-review-20261018.md)の所在地による適用、自動取得・短期投影保存・Private履歴/内部分析の具体的根拠を確定。11/1改定前の再審査と監視URLを確認する。**Rebro**: 公開ページへのサイト利用条件の全文/適用、選別事例の同じ3用途の根拠を確定。両方ともpublic/商用/遡及再利用は別審査のまま。
2. ownerが1sourceのscope（A100/H100、1ページ、必要項目だけ）、取得頻度/UA/3要求、根拠URLと確認日、wire contract、policy版/有効期限/terms review期限を承認。`public_access` のrobots/terms fingerprint、robots_decision/reviewed_refを記録。独立した3権限だけを新policyで判断する。現在のproposalの日時はレビュー案でありサイト権利の有効期限ではない。
3. evidence 7日/原文archive 0日/normalized目標1095日/backup上限30日は案。normalizedは **unapproved / 日数null**。明示根拠に従いfixed_daysまたはuntil_revokedを選び、実Time Travel、cleanup、restore、lifecycle、owner承認を確定する。holdは任意、レビュー期限だけで正当な保存を削除しない。過去データのPublic/商用化を自動承認しない。
4. 別途承認した最小live smokeだけ実施する。ローカル用コマンドは以下。通常test/buildには接続しない。現在のproposalを渡すとHTTP/DB作成より前に `policy_blocked` になる。source別の承認済みconfigを指定し、キーは不要。実値はignored `work/private-public-gpu/<source>/` のローカルD1/R2だけに置き、stdoutは状態metadataだけ。これは初期受入用で日次手作業ではない。

```sh
node scripts/public-gpu-smoke.mjs --allow-network --approved-config <承認済みsource別configのパス>
```

5. smokeでは実observed_at、選定件数とschema、原単位、null、期間精度、source単位停止/再開、最小証拠/保持を確認。H100が未掲載でも収集したと数えない。実値をfixtureやCIへ持ち込まない。seed JSONや検索cacheをlive系列へ投入しない。

## 本番への安全な差分とrollback（未実行）

本番接続にはまだ実装・明示承認が必要。現行productionのversion/配信commit/設定/適用migrationをread-onlyで再取得し、PoC Private・ECB・Modelsが動く配信版から統合branchを作る。ここで参照する[10/15の本番差分](source-expansion-20261015.md#作業開始時点と本番との差)は過去記録であり、今回最新本番を再監査したとはしない。

許可後の差分候補は、PR #16共通research基盤（0007〜0009）と本PRの0010、private研究モジュール、review済みsource登録だけ。既存適用migrationを照合して必要な分だけremote適用を別承認する。番号予約の0004やpublic migrationを流さない。0010は追加table/index/triggerのみ。Public/API/Admin/NASのコード・bindings・DNS・Secrets・現行Cronは差分に含めない。

production拒否gateの解除、既存日次slotからsource別1回だけ呼ぶdispatch、既存continuationでのbounded retention/reconciliation、control prefix保護、停止理由/期限/backlog監視を**別の統合変更**でレビューする。新Cronで二重実行せず、ソースの収集停止中も削除義務の自動処理は続ける。現状のままenable=trueに変えただけでは本番稼働しない。

初回は承認済みsource1社だけ有効化し、翌日再観測までrun/evidence/immutable履歴、source isolation、public 0行、既存3source継続を確認する。その後もう1社を独立に判断する。ownerの承認なしにこの手順を実行しない。

rollbackは追加sourceのdispatch/取得を単独停止し、直前の**実際の配信version**へ戻す。IDはその時に確認し推測しない。旧main/PR16のCollectorを上書きしない。保持gate/cleanupは残し、0007〜0010をdown migrationで破壊しない。停止だけなら保存権内の履歴は保持。権利取消しならR2 control記録→read停止→20行単位の期限削除、Time Travel残存期限を監視する。バックアップ復元で取消し済み履歴を復活させない。

## 検証の範囲

- `tests/public-gpu-contract.test.ts`: 2つのdisabled proposal、3権限/retention/access、固定URL、UA、HTTP停止、terms/robots変化、HTML破損/重複、単位/期間/null/取引相手除外。
- `tests/public-gpu-storage.test.ts`: 電力DB分離、Public 0行、immutable、翌日再観測/改定/消失、大幅変化、partial停止、source isolation、lease、capture replay、96行でもbatch≤20、Retry-After日跨ぎ、retention/取消し/復元防護、実データ入り0009→0010の合成migration。
- `test:runtime`: 実際のworkerd内でparse5 + 固定URL模擬HTTP + Private D1/R2まで両社を検証。Highreso4件/Rebro2件は**全て合成値**。既存1051GPU listing、50/250/1000 Models、FX/AI/Public/operations回帰も継続する。
- `check`, 全`test`, `test:runtime`, `build`（2 WorkersのWrangler dry-run）、offline preflight、生成schemaとCIを実行し、結果はPR/Issueの完了報告に記録する。prod deploy/remote migrationは行わない。

未実装: 本番dispatch/保持scheduler/朝の通知接続、実ページの許諾済みparser受入、別GPU/clusterページ・複数月同製品のケース識別拡張。これらを完了済み/live稼働中とは報告しない。
