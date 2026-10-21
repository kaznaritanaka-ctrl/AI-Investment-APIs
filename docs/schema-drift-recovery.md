# Schema drift recovery — 初版の受け入れ記録

## Adminから夜間調査へ渡す追加候補（2026-10-06）

Runsの読み取り投影に任意の `recovery` を追加する。分類・段階・診断コード・Evidence保存状態と絶対期限・欠測・次の対応を返す。本文、R2 key、任意の例外文は返さず、D1の既存run metadataから計算する。閲覧でDB/R2更新、Evidence読取り、収集、通知を起動しない。指定時点より後の診断は伏せ、旧版の診断なしをschema正常に置き換えない。収集/公開が実際に完了したことと、agentのpatch/test/reparseは別の証拠として扱う。

`pnpm operations:handoff --report <private-admin-runs.json> --slot <overview-logical-slot>` は保存したAdmin応答を、外部エージェント用の最小metadataへ投影するオフラインCLI。15分を超える応答、部分取得、確認不能は更新を要求する。sourceと分単位の予定枠からincident keyを作り、旧秒付きrunの優先記録・対象枠を照合する。本文・実fixture・Secretは出力しない。現行の機械的修復候補はModels.devのwrapper変更だけであり、Evidence hash/期限・記録済み診断を確認する。保存Evidenceの再解析には、別途許可済みのprivate実行環境が必要。

`coverage=provided_runs_only` は全ソース監視の完了ではない。`more_pages=true` なら次ページも確認し、Overviewの予定数・未確認sourceも照合する。runが存在しない、またはこのページにないsourceを正常にしてはいけない。引き渡しの生成自体はagentを起動せず、本番deploy・公開・通知の権限を与えない。

AdminではOverviewのschema drift注意事項からRunsへ移動できる。Dotsの結果取込みはまだ未接続なので、修正候補/回帰/再解析は `not_reported` と表示する。外部agentの認証済み報告・検証receiptの受入口は別の変更として審査し、Adminに汎用write APIやDB credentialを加えない。現在の `SCHEMA_RECOVERY_ENABLED`、source rights、Cron、通知設定は変更しない。

互換性：新Adminは旧Collectorの応答を読める。旧Adminは新しいrun fieldを厳格validationで拒否するため、反映は **Admin → Collector**、両方戻す場合は **Collector → Admin** の順。今回の投影追加にmigrationは不要。実際の本番切替と夜間接続は別途、対象差分を固定して承認する。

以下は前回候補の受け入れ記録であり、この追加差分の検証結果ではない。

2026-10-05 JST。基準はAPI `cf726bd52db57f90ffb6299402982e8b6bb77d03`。作業先は独立した `codex/schema-drift-recovery-20261005`。既存のoperations作業、Admin、GPU/電力作業のcheckoutは編集しない。本番の調査結果ではなく、基準コードの調査とローカル合成データによる実装・検証である。実際の本番schema drift発生を確認したとの主張ではない。

初版は **Evidenceの確保 → 機械的診断 → ローカル修復候補 → 回帰検証 → 保存Evidence再解析 → briefing用JSON**。`SCHEMA_RECOVERY_ENABLED` は未設定のまま、Wrangler設定を変更していない。自動production deploy・自動公開・外部LLM呼出し・新scheduleは実装上も無効。2026-10-05に所有者がNetlifyを問題なしと確認し、対象repoのGitHub push/PR保留を解除した。[Draft PR #7](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/pull/7)と現在の残件は[受け入れ記録](operations-acceptance.md)を参照。

## 1. 基準コードでどこまで復旧できるか

`src/network.ts` は固定endpoint、権利、認証準備を確認し、redirectを追わず、HTTP/content-type/最大bytes/本文timeoutを検査する。429/5xx/timeout/networkは最大3回、長いRetry-Afterは延期する。collector全体の復旧予算・leaseとは別のHTTP試行上限である。

次表は**今回の変更前**。○は保存済み通常Evidenceから同じobserved_atで再解析できることを指し、公開許可・parser修正・保持期限・版の承認を省略できる意味ではない。

| 障害段階 | ECB | Models.dev v3 | Lambda / Sakura DOK / eBay Browse / Price of Computeの既存GPU adapter |
|---|---|---|---|
| HTTP前 | 本文なし。権利/endpoint/auth停止 | 同左 | 実sourceはdisabled・権利未承認で取得前停止 |
| HTTP status / content-type検証 | 本文を保存しない。attempt metadataのみ | 同左 | 許可後の実装も同様 |
| body取得後 | success attemptのD1記録が失敗すると本文を失う | 同左 | 同左。OAuth token responseは市場Evidenceではない |
| Evidence生成前 | XML全文は取得済みだがR2成功前は復旧不能 | JSON構文/外形の解釈が必要。失敗すると未保存 | page projection前なので同様 |
| projection | 原XMLをEvidenceにする。まだR2未保存 | **正規化projectionをR2より先に生成**。wrapper/JSON shape失敗でその時点の値を失う。partial projectionでも落としたrecord/fieldは復元できない | **正規化/ページ契約検査がR2より先**。失敗したpageの本文は失う |
| parser | ○ 原XMLを保存済み | ○ 保存済みprojectionの許可項目だけ。失われた値は作れない | ○ 保存済みpage projectionだけ |
| private保存 | R2が成功していれば○。D1 indexだけ失敗した場合は既知keyから照合 | 同左。checkpoint単位のresume | 同左。page/checkpoint単位 |
| public publication | ○ immutable private履歴/通常Evidenceから冪等再開。publication完了は別判定 | complete snapshotとpublication batchを照合して再開 | complete snapshotとpage coverageを照合 |

Models.dev v2も小さい選定projectionをR2前に作る旧経路で、今回のv3向けcaptureを遡及適用しない。旧Evidenceは通常replayで読めるが、当時失われた未保存値は復元しない。

OpenRouterはparserだけ存在し実収集は停止。Runpod / GPU index / GPU Soroban / memory / rates-credit / capex-utilization / CCIR / electricityはこの基準では候補・disabled。EIA実装はこの基準に存在せず、独立GPU/電力作業を取り込まない。未取得sourceには「Evidenceなし/対象外」と表示し、復旧実績を作らない。

watchdogは03:47 JSTに既存日次slotを照合する。continuationはModelsのcheckpointを5分単位で進め、03:17から6時間のcapture windowと共有復旧予算3回を守る。watchdog/continuationは新しい市場観測として数えず、秒付き旧run ID・artifact keyを維持する。保存証拠限定のresumeは証拠欠落時にHTTPへ切り替えない。通常の再取得をする経路でも、後で取得した値のobserved_atを03:17へ偽装しない。

notificationは収集・公開・監視・品質を分ける既存0006候補を継承する。activation/Secret未設定のため実送信は無効。`operations:check` は固定GET/SELECTでmetadataを読む独立したCLIで、認証/HTTP到達性をcollection/publication成功へ読み替えない。外部runnerが実際に動いているとは記録しない。

## 2. Sourceごとの保存・権利境界

次表は新しい許諾ではなく、`config/sources/*.json` と既存の[権限ルール](rights-policy.md)を適用した実効範囲。未知権利は拒否する。external LLM許可は内部解析許可と別である。

| Source | raw全文 | 最小projection / field whitelist | quarantine保持 | external LLM | public redistribution |
|---|---|---|---|---|---|
| ECB | 固定ECB reference XMLのみ既存許可内 | EUR reference rates、source date/metadata。選定USD/JPYと明示的派生crossは既存範囲 | 365日、原observed_at起算 | review_required → 送信しない | 元policyはraw/normalized/derived許可。ただしquarantine用入口は公開しない |
| Models.dev v3 | **保存しない** | 下記5 provider / 17 fieldだけ。説明文・ロゴ・provider request body/header・未知field値を落とす | 90日。通常Evidenceと同じ、archive/normalizedへ昇格しない | denied | 既存条件内のnormalized/derivedのみ。raw/quarantineは公開しない |
| Lambda | 未承認、不可 | gpu_projection_v1等の個別許可が未成立。実効whitelistなし | 未承認/null、保存不可 | review_required、不可 | 未承認、不可 |
| Sakura DOK | 未承認、不可 | 同上 | 未承認/null、保存不可 | review_required、不可 | 未承認、不可 |
| eBay Browse | 未承認、不可 | 同上。IDをhash化しても許諾の代わりにしない | 未承認/null、保存不可 | review_required、不可 | 未承認、不可 |
| Price of Compute | 未承認、不可 | 同上 | 未承認/null、保存不可 | review_required、不可 | 未承認、不可 |
| OpenRouter | 未承認、不可 | 実効whitelistなし | 設定値90日は許諾ではない。保存不可 | review_required、不可 | 未承認、不可 |
| Runpod / GPU index / GPU Soroban | 未承認、不可 | source別候補設定のみ、実効whitelistなし | 同左、保存不可 | review_required、不可 | 未承認、不可 |
| electricity / EIA | 未承認、不可 | electricityはendpoint未選定。EIAは独立作業で、この候補へ許可/adapterを追加しない | 保存不可 | 不明/未承認、不可 | 不明/未承認、不可 |
| memory / rates-credit / capex-utilization / CCIR | 未承認、不可 | source別候補設定のみ、実効whitelistなし | 設定値は許諾ではない。保存不可 | review_required、不可 | 未承認、不可 |

Models対象providerは `openai, anthropic, google, xai, mistral`。fieldは `id`, `canonical_model_id`, `limit.context/input/output`, `modalities.input/output`, `reasoning`, `tool_call`, `structured_output`, `attachment`, `temperature`, `release_date`, `last_updated`, `status`, `cost`, `experimental.modes.cost`。価格component・context tier・modeの既存構造だけを残し、未承認条件値は保存しない。未知enumの値そのものではなく、固定pathと型/enum不一致のcodeを残す。新field名への移転は勝手に同義とみなさない。

全quarantineはprivate R2のみ。Public API/Adminに本文取得経路を追加しない。既存private bindingを使い、public bucket/domainを作らない。R2の保存時暗号化とTLSを利用し、追加の暗号鍵/Secretsは登録しない。[CloudflareのR2暗号化仕様](https://developers.cloudflare.com/r2/reference/data-security/)ではobjectとmetadataが自動暗号化対象である。外部runnerへ本文を持ち出すにはprivate保管・アクセス範囲・削除期限を別途確認する。

## 3. 今回のcaptureと診断

`src/schema-drift.ts` / `src/recovery-evidence.ts` を追加。HTTPの成功・content-type・最大bytes・UTF-8・body取得を終えた直後、**success attemptのD1記録より前**にonBody hookを呼ぶ。最初の許可済みresponseを `evidence/<source>/<run>.quarantine.json` に保存し、通常Evidenceの `.json` と区別する。original response hash、保存body hash、元observed_at、policy hash、expiry、diagnosticsを持つ。

R2 conditional putで既存objectを置換しない（[公式API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)のonlyIf）。同じrunで値が後から変わっても最初のcaptureを保持し、期限を現在時刻から延長しない。既存 `raw_artifacts` に同じexpiryを登録し、`expireEvidence` の削除対象に含める。R2保存後にD1 index登録だけ失敗した場合は、既知keyから再登録できる。新migrationや保持期間の変更はない。

Modelsはprojectionの前に**許可fieldを選別した復旧用の形**を保存する。通常の正規化済みEvidenceではない。既知wrapper `data/catalog/result` はwrapperを残してcaptureできるが、その時点ではdriftとして公開停止する。malformed JSON、未認識wrapper、型変更で許可fieldを識別できない部分は、metadataのみ/不完全captureとなる。原本文全文で穴を埋めない。

機械診断は `code / path / expected / actual / severity`。pathは固定fieldか`*`、actualは型や固定ラベル。任意のraw値/未知field名/例外本文/URL/header/Secretをログへ出さない。主な分類は次のとおり。

| 分類 | 扱い |
|---|---|
| 401/403、認証未設定 | authentication。schema driftと断定しない |
| 429 / Retry-After | rate_limit。既存の有限retry/延期 |
| 5xx / timeout / network | transport。本文未取得なら復元不可 |
| content-type / body空 / byte上限 | response_contract。未許可本文を保存しない |
| JSON外形、必須provider/model ID、array/object、enum、pagination | schema_drift。保存できる許可fieldだけ保持し公開停止 |
| currency / unit / basis / contract / region / SKU、未知price条件 | 意味論の人間確認。値を推測して補完しない |
| record count < 前回80% または > 前回200%、0件/承認上限超過 | scope確認のblock。価格不変は異常にしない |
| R2 / attempt記録 / private / publication障害 | storage_or_publication。保存失敗をHTTP retryとして再取得しない |

ECBは原XMLを保持し、既存parserのXML/date/currency検査を使う。新しいbase/unit/basis/scale等の明示metadataは意味論変更として停止する。ソースが同一shapeのまま意味を無告知で変えた場合を完全検知できるとは主張しない。

失敗metadataは既存 `collection_runs.metrics_json.recovery` に、run/leaseでCASして保存する。最初のdrift検知時刻を後続失敗で上書きせず、成功時のmetrics更新でも診断を消さない。正常Evidenceがなくquarantineだけ残ったslotは、自動で本文を差し替えたり昇格させたりせず、保存済み再解析の審査対象になる。現在の上限を超えてcontinuationを増やさない。

残る復旧不能経路は、HTTP前/途中の断絶、error statusや不正content-type、byte/UTF-8上限、R2保存自体の失敗、D1停止等で現行保存権限を確認できない場合、最小選別の前にCPU/メモリ上限へ達した場合、許可外/未知shapeの部分、保持期限切れ、実装前に失われたresponse。R2とD1は単一transactionではない。D1登録が復旧しない孤立objectについて、既存source prefixのR2 lifecycleが同じ保持上限を強制していることを本番有効化前の必須確認とする。[lifecycleはprefix単位](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)であり、今回設定を変更していない。適合しなければ有効化せず別レビューする。

## 4. 修復候補とgate

`pnpm repair:prepare --demo --verify` は合成responseだけでローカルbranch/worktree、parser patch、parser_version、合成contract fixture/test、全検証ログ、patch/Evidence hashを結びつけたreceipt、再解析比較JSONを生成する。生成先はignored `work/repairs/<id>`。既存candidateを上書きせず、同じ入力の重複生成を防ぐ。親checkoutはcleanなcommitに固定し、検証前後でcandidate patchが同一であることを確認する。

保存済みの実Evidenceを用いる場合は、承認されたprivate取得手段で期限内のファイルを用意し、`pnpm repair:prepare --evidence <private-file> --baseline <normal-evidence-file> --verify` を実行する。CLIは取得・Secret読出し・追加HTTP・DB更新・公開をしない。既存policy/hash/期限/field whitelistを再検査し、baselineの期限切れ・synthetic混在を拒否する。元Evidenceの追加コピーを成果物へ残さず、patch/fixtureは合成データだけ。実データをGit/CI artifactへ入れない。

初版の実装済みpatch generatorは **Models.devの既知wrapper移動**。旧形も処理し、wrapperと別のrootが混在する曖昧入力を拒否する。field rename、pagination contract、ECB/GPU parserの任意修正は診断/最小AI入力と人間レビューへ止める。未対応なのに修復成功と記録しない。保存Evidenceが不完全なら再解析できた部分だけを完全snapshotとして公開しない。

AI向け `ai-input.json` はsource/policy ID、Evidence hash、時刻、固定diagnostic code、adapter file、許可作業のみ。source値・本文・認証情報を含めない。外部LLM呼出しはない。人間または将来の別承認されたrunnerはadapterコードと合成contractを分析できるが、sourceの指示/URLを実行してはいけない。権利の許可がないsource本文をLLMへ渡す能力は付けない。

機械可読規則は `config/recovery-policy.json`。falseだけでなく**unknown/nullもblock**。将来の自動復旧候補には、回帰test、新contract test、accepted/quarantinedとbaselineの整合、entity identity、currency/unit/basis/条件、public rights、現行source許可の別途検証、Evidence再解析、immutable履歴、parser版更新、rollback、提供元の意味の確認をすべて要求する。値段の変化だけでは止めず、accepted/quarantinedの変化は比較結果として審査する。

実データではCLIだけで現行D1の許可状態や上流の意味を証明できないため、`current_source_authorization_verified` と `upstream_semantics_confirmed` はnullのまま。合成demoだけは作者がfixtureの意味・許可条件を管理していると明示する。gate全PASSでも `production_deploy_allowed=false` / `publication_allowed=false`。生成patchはquarantine→通常Evidenceへの本番昇格経路を追加しない。修正版での再解析・訂正履歴・公開の本番適用手順も、対象run/hash/parser版を固定した別レビューが必要である。

## 5. 夜間の設計とMorning Briefing

既存03:17収集・5分continuation・03:47 watchdogは変更しない。提案する独立runnerは03:20から09:20まで5分間隔で固定metadataを確認し、09:25に最終briefingを作る。**JSON上の提案のみ、enabled=false**。09:17以降に新たな市場取得を始める意味ではない。保存済みEvidenceの期限内再解析はcapture windowとは区別する。

runnerはmetadataの読取権限、承認済みEvidenceのprivate read、local branch/test権限だけに分割する。市場API鍵/Worker管理/Secret読出し/公開DB書込み権限をrepair子processに渡さない。GitHub Actionsを使うなら、push/PR保留とNetlify公開経路を解決した後にworkflow/token/非公開artifact/runnerの保管期限を別承認する。現CLIの子processはcredentialsを除外したenvironmentで動く。ログは合成testと固定codeだけ。

処理順は `operations:check → slot/source/run照合 → incident分類 → private captureの有無/期限確認 → candidate生成 → check/test/runtime/build/preflight → patched parserで再解析 → gate再評価 → overnight:brief`。candidateの重複防止キーはbase commit・Evidence body hash・候補parser版であり、既存成果物を上書きしない。別日の同一本文も同じキーになるため、現CLIはそこで停止する。runごとの再利用・receipt再検証を行うrunnerは未実装であり、別runの成功結果をそのまま転用しない。意味論/権利/未知欠測は即停止する。runner自体のheartbeat/期限逸脱を**Cloudflareと別の失敗経路**で監視し、Cloudflare到達不能を収集失敗と混同しない。新schedule/runner/認証/実通知は別承認のため、今は所有者へ自動送達される状態ではない。

`operations:check` の `overnight` はsource別collection/publication、schema drift、detected_at、evidence状態/期限、recovery回数、patch/test/reparse、missing observation、human action、severityを返す。disabledは対象外。過去版で診断のないrunは `not_reported`、確認不能はunknown/null。collection完了・publication失敗を分け、再解析PASSだけでは欠測0や公開完了にしない。

`recovery_attempts` はcollection runの復旧試行数であり、個々のHTTP retry回数ではない。HTTP試行は既存fetch_attemptsの記録で別に確認する。欠測判定の範囲は `current_run_only` で、過去日すべての欠測が解消したことを意味しない。公開停止は該当する新runの公開を止める意味で、既存の公開履歴は元のobserved_atのまま保持する。前日の値を当日値として表示しない。

`pnpm overnight:brief --status <operations.json> --repair <repair-result.json>` でローカル修復receiptを結合する。同じsource/run/Evidence hash/期限、5種類の検証、patch hashを確認し、DB由来のcollection/publicationを上書きしない。合成結果は `--synthetic` を明示しないと結合しない。未実施のtestはnot_run、意味論判断はhuman action、本文を復元できない場合は欠測未確認とする。成功時は短い要約、異常時は「何が起きたか・自動対処の到達点・欠測の有無/不明・残る判断」を出す。実通知機能をこのCLIへ追加していない。

## 6. 本番運用を始めるための承認

1. GitHub: 所有者確認によるpush/PR保留解除と作業branchの公開、Draft PR #7作成は2026-10-05に完了。main mergeは別承認。合成repair例のbranchは公開しておらず、実障害のpatchはその都度内容と公開範囲を確認する。
2. Collector: 最終commit/artifact、既存Cron/bindings/rights/retentionの不変、追加R2容量・CPU、private bucket/lifecycle適合、rollbackをレビューしてupload/切替を直前承認する。`SCHEMA_RECOVERY_ENABLED=true` は別途その設定差分も承認する。初回は通知無効のまま。
3. migration: このschema recovery自体に追加migrationはない。ただし基準cf726bdは未適用0006候補を含む。[operations-acceptance.md](operations-acceptance.md)のprivate-only 0006手順を別承認するか、0006依存を除く別候補を再レビューする。通常設定で未適用SQLを一括applyしない。0004 GPU/電力は混在させない。
4. 外部運用: runner、5分確認schedule/独立heartbeat、最小read権限、Evidenceのprivate取得/一時保存/削除、briefingの宛先、Secrets登録、初回実通知はそれぞれ具体的差分を提示して別承認する。現時点では未設定。
5. 個別repair: 実schema変更の根拠、baseline、保存Evidence、patch/test/再解析/gateを確認し、parser配信と元runの訂正/公開を別承認する。未知の意味/権利をAIが決めない。自動production deployを有効にする承認は今回の範囲に含めない。

旧Collectorへ戻す場合は、旧pending誤送信を防ぐため、**戻し先のWebhook Secret不存在確認または別承認済み無効化の完了が必須**。新codeのnotification activation未設定だけでは旧codeの送信を止められない。履歴/既存Evidenceを削除してrollbackする案は採らない。

本番API/Admin、source grants、保存期間、0004、Lambda/Sakura/EIAの本番有効化を変更していない。今回新たな自然実行実績の取得・待機・手動Collector起動をしていない。既存7日受入記録を今回の候補実績へ合算しない。

## 検証結果

最終コードは **`148774babd9d1ad476ab9d4b5f64a95ba589bfbb`**、branchは `codex/schema-drift-recovery-20261005`。本体の最終検証は2026-10-05 **02:22:23–02:40:45 JST**（2026-10-04 17:22:23–17:40:45 UTC）。コード・テストを編集せずに実行し、開始前/終了後ともtracked差分なし、HEAD一致を記録した。この受け入れ記録の追記だけを検証後の文書commitとする。

環境はWindows x64、Node v24.19.0、pnpm 11.19.0、固定lockfileの既存依存。ネットワーク取得・本番操作をしない検証であり、**GitHub CIは未実行**。Windowsの既存ローカル検証条件に合わせ、全体testの各ケース上限を60秒で起動した。assertion・対象test・公開/権利/品質の期待値は弱めていない。別checkoutの本体と候補を固定して検証し、検証中の並行編集はない。

| 検証 | 本体148774b | 生成した修復候補 |
|---|---|---|
| 型・形式・境界検査 `node scripts/run.mjs check` | PASS | PASS |
| 全体test `node scripts/run.mjs test --testTimeout 60000 --reporter verbose` | **22 files / 194 tests PASS** | **23 files / 195 tests PASS** |
| workerd runtime `node scripts/run.mjs runtime` | PASS | PASS |
| API/Collector build `node scripts/run.mjs build` | PASS、Wrangler **dry-runのみ** | PASS、同左 |
| offline preflight `node scripts/preflight.mjs` | PASS | PASS |
| `operations-check.mjs` offline / `generate.mjs` | PASS / 生成物差分なし | 候補用5検証の対象外 |

本体の各コマンドのexit code・時刻・前後status・artifact hashは `work/final-validation-148774b/result.json`、詳細ログは同じディレクトリに保存した。Collector buildのSHA256は `f6235154a7c0c83028458dc8bf985c9a9c28916b54515296ce8b3d3f0dd8dc52`、APIは `d7577cdcfb983bbda02942254c53a2026457358b16dc041bb3936228d8196023`。uploadはしていない。

修復候補は `pnpm repair:prepare --demo --verify` 相当のCLIを実行して生成した、**合成Models wrapper事例**である。検証期間は02:21:56–02:40:19 JST。基準148774bに対する検証済みpatchを、そのままローカルbranch **`codex/repair-73ff2b6be12645c0` / commit `3490e2083b2fbf7b716dc03d192432e4b6839d80`** に固定した。commit前後のpatch全文一致、src/models.ts hash、clean statusを確認した。本体branchにはこの合成修復patchをmergeしていない。

- parser版: `models-catalog-20260930.1.repair-1137253ccb804750`
- patch SHA256: `578e130e66a51da66ab0c3bb9ae18da2069aa785c07ad4283028a5a2b27b863c`
- 合成Evidence body hash: `3cd013a34da2b2b572052e46bcba6f999032fdb53ab200997bba195492885bd0`
- 出力: `work/repairs/73ff2b6be12645c0/` の `candidate.patch`、`ai-input.json`、`test-receipts.json`、`repair-result.json`、各検証ログ

実際に生成patchをbuildして、保存した合成Evidenceをそのparserで再解析した。5 entity / accepted 5 / quarantined 0でbaselineと一致、identity・decimal・currency・unit・basis・元observed_atを維持した。demoの提供元・権利の意味は合成fixtureとして管理されるので、候補gateは全PASS。ただし `production_deploy_allowed=false`、`publication_allowed=false` のまま。実データでは現行source許可・上流の意味が未確認ならnullとなり、このdemoの結果は転用しない。fixtureの観測時刻 `2026-10-05T18:18:00.000Z` は試験用の時計で、実際にその日に収集した記録ではない。

runtimeでは8,391,612 bytesの合成responseから許可fieldのbody 2,272 bytesを保存できた（envelopeのmetadataは別）。ローカル経過144msであり、**Cloudflareの課金CPU計測ではない**。HTTPはmock 1回、外部HTTPは0回。schema driftでrunは停止し、private観測0・public行0のままEvidenceを保存、その保存値から5件を再解析できた。結果は `work/runtime-recovery-report.json`。通常のECB/Models収集、通知dry-run、1051件/22pageの既存GPU処理、50/250/1000 Modelsの継続・履歴・replayも今回のruntimeで成功した。実sourceの有効化や実通知の試験ではない。

朝向け出力もCLI経由で照合した。`work/repairs/73ff2b6be12645c0/overnight-brief.synthetic.json` は `repair_patch=generated`、`regression_result=passed`、`reparse_result=passed_with_patched_parser` を返す。同時に、元の合成状態 `collection_status=failed` / `publication_status=awaiting_collection` / `missing_observation_count=null` を保持し、human actionを `review_gate_and_approve_deploy` とする。通知は `not_attempted`。試験結果から本番の欠測0や公開完了を作っていない。

予備検証では旧候補 `a6f181c8e84a1b37` の195件中1件が、修復checkoutの `work/` を既存testより先に作っていなかったためENOENTで失敗した。gateは不合格となり、朝向けJSONも `failed_or_unverified` を保持した。148774bで作業フォルダーの準備を直し、既存test本文を変えずに**上表の両方の全体検証を最初から再実行**した。旧候補の194件成功、旧本体9db86ffの成功、途中の部分検証を最終件数へ足していない。失敗記録は消していない。

本候補を凍結した時点ではGitHub CIも未実行だったが、2026-10-05にcommit 32f85f3の[CI 37246616324](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/actions/runs/37246616324)が194 tests・型・preflight・runtime・dry-run build・生成物確認に成功した。未検証なのは実sourceの未知変更、本番Cloudflare CPU/容量、private R2 lifecycleとの適合、現行本番に対するremote checker到達性、独立runner・heartbeat、実通知送達、実Evidenceの本番再解析/公開である。capture flagの有効化・新規runner/schedule/Secrets登録・production deployは実施していない。7日間の自然実行実績を今回追加取得したり、候補の実績へ合算したりしていない。

元operations checkoutはcf726bdのままで、既存未コミット文書のSHA256 `3f83d39af6eed049a38eba0800e7b56220d52ab8d2fa211e27a420ec46854932` も不変。Adminは `ff46be8ecf20f9df8df52374e3991c5a217e21fe`、独立GPU作業は `a0196dc24348cb7185a37e6762ecd9a7c136c288` で、ともにcleanなまま。source権利・保持設定・既存migration・Wrangler設定・GitHub Actionsに本体候補の差分はない。
