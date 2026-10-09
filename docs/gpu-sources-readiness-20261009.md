# Highreso / Runpod / CCIR 接続準備 — 2026-10-09

## 確認範囲と現在地

基準: `codex/operations-ready-20261008` / `23d803d4e4906e04a50884b11c73519cdd202ef9`。
default branchのmainだけでは後続の運用作業を含まないため、今回の資料はこのbranchに対する独立提案です。

今回確認したのはリポジトリの設定・既存実装と公式仕様・利用条件です。Cloudflareの実効設定、Adminの認証済み画面、実データの取得は照会していません。専用adapterの実装、synthetic実行、live成功、本番反映を完了したとは扱いません。

| source | この基準SHAの設定 | 先に解決すること |
| --- | --- | --- |
| gpusoroban | disabled / candidate / endpoint未設定、9権利review_required | 公式取得経路、日次取得・非公開履歴の許諾 |
| runpod | disabled / candidate / GraphQL候補、9権利review_required | REST v2へ仕様更新、APIの本用途への許諾、読み取り用認証 |
| ccir | disabled / candidate / Hardware向けgpu_secondary候補、9権利review_required | 書面許諾、HardwareとCRIの分離、配信schema確認 |

既存ECB / Models.dev / Price of Computeの設定、grant、Cron、Binding、Secret、migration、配信は変更しません。今回の文書は新しい権利grantや実取得の許可ではありません。configの90日も、第三者が許諾した保持期限と読み替えません。

## 進め方

取得・非公開保存・内部分析の可否を先に個別確認し、公開表示・正規化再配布・派生再配布・商用再配布は別に確認します。キーの所持やAPIの存在だけで権利をallowedにしません。継続取得前に必要な回答を記録し、返答待ちのsourceと他sourceの実装を分離します。

保存期間の照会案は、最小投影証拠7日、archive30日、正規化履歴5年、backup30日です。これは希望条件であり未承認です。先方の条件と所有者レビューに合わせて4区分を確定します。本文やアカウント情報を残す必要がない場合は投影数値・識別子・条件・hashのみを保存します。

初期は1日1回・小さい承認scopeとします。変更検知のための正常応答と、価格が変わらなかったことを区別します。権利・取得仕様・保持のレビュー後に単発live読み取り、その後にprivate継続収集、最後に公開scopeの別レビューを行います。

## Highreso / GPUそろばん

公式参照:
- [インスタンス一覧](https://soroban.highreso.jp/compute/instances)
- [高速コンピューティング](https://soroban.highreso.jp/compute)
- [計算クラスター](https://soroban.highreso.jp/multinode-cluster)
- [利用規約](https://soroban.highreso.jp/terms)

初期対象案はA100 80GB standardの公開提示料金です。offer ID、OS、storage、JPY、税込区分、台・時と台・月を分けて保持します。月額を仮定なしで時間単価に換算しません。提供region、form factor、空き容量を補完せず、掲載を作成可能性の証拠にしません。

匿名閲覧できる価格HTMLは確認しましたが、公式の機械feedと容量feedは未確認です。推奨API/CSV/feedの有無を照会し、HTMLの利用が認められる場合だけ固定URL・専用投影parserを設計します。現在のJSON/XML制限を全sourceについて緩めません。

B200クラスターのGPU・分、storage・日、先払いポイントと最低購入条件は独立の次段階です。現行の時間/月のschemaへ押し込みません。問い合わせ価格はnullとし、0円へ変換しません。

規約2025-12-01適用版から、本プロジェクトの継続取得・価格履歴の保存・再配布を許す明示条件は確認できませんでした。禁止の断定も行わず、用途別review_requiredを維持します。

### 許諾照会案（未送信）

件名：GPUそろばんの公開料金情報の取得・保存について

GPUそろばんの公開料金を、個人的な投資リサーチに利用したくご連絡しました。まずA100の一部プランについて、料金・GPU構成・課金単位を1日1回取得し、非公開の時系列として長期保存・分析することを考えています。利用可能な公式API・CSV等と、この用途での取得・保存条件を教えていただけますでしょうか。

将来は出典付きの加工データをAPI提供する可能性がありますが、商用化は未定です。公開・再配布に必要な追加条件、元情報・履歴・バックアップの保持期限も併せて伺えますと幸いです。

## Runpod

公式参照:
- [REST v2 GPU catalogue](https://docs.runpod.io/api-reference-v2/catalog/list-gpu-types)
- [GPU詳細・field semantics](https://docs.runpod.io/api-reference-v2/catalog/get-a-gpu-type)
- [GraphQLの現行案内](https://docs.runpod.io/sdks/graphql/configurations)
- [利用条件](https://www.runpod.io/legal/terms-of-service)

新規取得案は `GET https://api.runpod.io/v2/catalog/gpus` とします。Bearer認証が必要です。GraphQLは2027年前半に退役予定のため、古いcandidateのURLをそのまま実装しません。Secret候補名は `RUNPOD_API_KEY`、必要scopeはcatalogue読み取りです。最小権限の具体設定は別確認とし、キー値は文書・Git・CIへ出しません。

初期scope案はPOD / SECURE / count=1、承認したGPU type ID 2〜3種類です。availabilityを要求する場合のquery案は `include=AVAILABILITY&product=POD&count=1&cloud=SECURE`。国等の追加filterは確認して固定します。カタログ価格と条件付きavailabilityを別に保持します。

`price.secure` は単GPUのUSD/hour list priceとして保存し、実請求のpod costやDC固有quoteへ読み替えません。Secure/Community、POD/CLUSTER/SERVERLESSは異なる比較条件です。初回はServerlessやspot/reservedを混在させません。

`maxCount` は1machineの構成上限で、空きGPU台数ではありません。`NONE/LOW/MEDIUM/HIGH` は要求条件に対するavailabilityです。国filterによるlist除外を型廃止としません。API失敗、filter除外、未知ID、容量なしを別状態にします。

体系的DB作成・自動取得に関するTermsと、公式APIの本用途への適用範囲は未解消です。APIの全面禁止も、本用途の許可済みも断定しません。

### Permission inquiry draft (not sent)

Subject: Permission for daily GPU catalogue observations

I would like to use Runpod's official REST v2 GPU catalogue for personal investment research. My proposed scope is two or three GPU types, queried once daily for listed prices and POD / SECURE availability with count=1, then retained privately as a time series.

Could you confirm whether this use is permitted, how the automated-retrieval provisions apply to the official API, and the applicable retention and attribution conditions? I may later offer normalized or derived data through an API, but commercialization is undecided. Please distinguish permission for private research from any additional license needed for public or commercial redistribution.

## CCIR

公式参照:
- [Hardware](https://ccir.io/hardware)
- [Data Terms](https://ccir.io/documents/data-terms)
- [Methodology](https://ccir.io/documents/methodology)
- [How We Publish](https://ccir.io/documents/how-we-publish)
- [Daily Rates](https://ccir.io/rates)

2026-10-06版Data Termsは、継続・大量取得、系列や履歴の再配布、商用再包装・商用派生利用を書面許諾の対象にしています。内部引用の許可を、日次取得・長期履歴への許可として使用しません。公開downloadの現行print＋30日履歴より長い利用やmachine delivery等も照会対象です。

HardwareのDCF推計、実売集計、posted ask集計と、Rental CRIを別系列にします。CCIRは二次集計ソースとして明示し、個別売買・出品に偽装したGPUSecondary行を作りません。他の直接取得providerの独立サンプルに重ねて加算しません。

公式Rates CSVへの導線は確認しましたが、実headerやHardwareの機械配信は未確認です。CSVの存在を取得許可にしません。配信schemaとmethodsの回答を得てからparserを固定します。

保持候補: series ID、系列日付、観測日時、revision、methodology版、statistic、地域/契約/割込みscope、原単位、標本数・期間・欠測状態。Hardwareはvaluation assumptions・bundle scope・report periodを加えます。各値の基準日と観測日時を分離します。

公開ページと方法文書にはheadline statistic、地域範囲、carry-forward条件の不一致があります。推測統一せず、許諾時に採用schema・methodology版を確認します。集計系列の型・migrationが必要なら既存migrationを変更せず独立案にします。0004等の予約番号を勝手に流用しません。

### Permission inquiry draft (not sent)

Subject: Permission for daily private research observations

I would like to use a limited selection of CCIR Hardware metrics and, separately, Rental CRI series for personal investment research. I propose one daily retrieval and private long-term storage of selected values, dates, units and methodology metadata, with attribution.

Under your Data Terms, could you advise the required permission or license, available machine-readable delivery, retention limits and cost? Future normalized or derived API provision is possible, but commercialization is undecided. Please separate private research rights from redistribution rights, including any restrictions inherited from upstream sources. I would also appreciate confirmation of the applicable statistic and methodology version.

## 実装と検証の受入条件

既存のrights/retention gate、immutable evidence/history、decimal、hash/provenance、snapshot/checkpoint、private/public分離を再利用します。Public Workerへ取得Secretやprivate bindingを追加しません。

- 専用adapter・固定request plan・認証はsource別に追加し、unknown権利でHTTP・保存を行わないことを検証する。
- 実レスポンスをGit/CI fixtureにせず、契約schemaに合わせたsynthetic fixtureを使う。今回まだfixture試験は実行していない。
- 価格の単位/課金条件、nullと0、未知構成、partial/overflow、pagination、schema変化、401/403/429/timeout、retryの冪等性を確認する。
- 完全応答が確かめられない取得をcompleteにしない。選択範囲やページの欠落を掲載消失・市場在庫減少と扱わない。
- 日付/観測時刻/公表時刻、改定の追記、比較条件の違い、権利失効と保持削除を確認する。
- 型チェック、offline preflight、全テスト、runtime、dry-run build、生成物差分を現行手順で確認し、baselineと回帰を分ける。
- 初回liveは承認された読み取りのみ。GPU作成・予約・注文、アカウント作成、有料契約、問い合わせ送信はこの文書では実行しない。

## この変更の検証

ドキュメント1ファイルのみ。基準branchの3source設定、AGENTS、architecture、rights policy、既存GPU型/adapter/network/pipelineを照合し、公式リンクの到達と仕様・条件を確認しました。コード・設定・grant・migrationは変更せず、コードテストを今回実行したとは報告しません。
