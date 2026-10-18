# PR #18 レビュー受入: parser・cohort・規約版・資格情報境界

2026-10-18追記: 私的例外と長期保存は所有者承認済み。NAS専用exportの分離・未有効化のCloud準備・現在の残件は [最新資料](nas-export-isolation-20261018.md) を参照。提供者許諾と通常grantは変更せず、実行／本番反映／実鍵／NAS変更は未承認。以下の以前の承認状態・shared-bucket案は当時の記録です。

後続の所有者依頼により[2026-10-18 06:47 UTCの現行DOM構造調査と開始承認票](public-gpu-private-start-review-20261018.md)を追加した。以下の「今回の価格ページGETなし」は4df13cfまでのレビュー記録。後続調査では各1 GETの構造metadataのみを確認し、実価格・観測履歴は保存していない。

対象は[追記6246268133](https://github.com/kaznaritanaka-ctrl/AI-Investment-APIs/pull/18#issuecomment-6246268133)、旧HEAD `4eb9b62`。PR #16修正 `abd676633a0e591e1f65996a8d4860192f992292` をmergeで取り込んだ。両PRともDraft・未マージ。**実市場観測0件、Highreso/Rebro日次本番稼働0日、新grant0件、本番変更0件。** NAS機能の増築はしない。

## source別の受入状態

| 確認点 | Highreso | Rebro |
|---|---|---|
| parser | GPU製品見出し→仕様段落→下位の仕様/ストレージ/料金見出し→複数table。別GPU・peer・未知の下位節ではSKUをクリアし、仕様なし料金表は拒否 | 明示された買取実績節の固定5列。年月/商品/数量/単価だけ。相手方欄は破棄 |
| 新method | domestic-gpu-html-v2。旧v1も読めるが旧cohort/キーを暗黙変更しない | v2は公開内容のhash＋同一内容の出現番号で全掲載行を保持。v1は従来どおり重複を拒否 |
| 未承認の追跡cohort | A100/H100かつ**明記されたGPU枚数=1**。選定ページ内の該当インスタンスをすべて対象。地域/VRAM/税/専有等の不明値を補わない | A100/H100の選別公開事例すべて。全市場の約定集合ではない |
| 完全性/上限 | 全入力最大100行を検査。選定最大24 instance×時間/月額2枠=48観測。対象外はexcluded_rowsへ計上。25 instance以上なら全runを停止。先頭48件への切捨てなし | 全入力最大100行、選定最大48掲載行。超過時停止、重複事例も観測数へ含めるがGPU台数/取引数と同一視しない |
| 予定件数 | 日次0〜48という技術上限のみ。実ページのcohort適合件数は未受入・未確定。A100/H100各々の実収集実績は0 | 日次0〜48という技術上限のみ。実掲載件数は未受入・未確定 |
| 構造照合の根拠 | [先行記録](public-gpu-research-20261018.md): 2026-10-17 UTC / 10-18 JST、8/8/12列・結合なし・明示closing tag。今回のowner指摘の見出し階層を合成fixture化 | 先行記録: 同日の5列と買取実績h2。公開安定IDの存在は確認できていない |
| 今回の現行DOM確認 | **価格ページGETなし**。先行の限定metadataとowner指摘だけでは最新DOM全体への適合を証明できない。新fixtureは独自の合成HTML/値 | **価格ページGETなし**。重複を捨てない設計はsynthetic検証。実掲載単位のlive受入は未了 |
| 初回live smoke | 現時点blocked。取得/Private保存/内部分析の適用根拠、旧版/改定後版の個別審査、実cohort件数・DOM確認、初回Cloud実行承認が必要 | 現時点blocked。別サイト利用規約の所在と公開事例への適用、3用途の根拠、実掲載単位確認、初回Cloud実行承認が必要 |

`selection` はinput_rows/cohort_rows/excluded_rows/price_slots_per_row/method_versionを返す。completeは**承認された選定範囲**の検査完了だけを表し、ページ全商品や市場全体を意味しない。初回受入で対象が0なら、選定の妥当性を再審査し、観測開始と報告しない。最新の固定DOM・選定件数を確認できるまで、synthetic成功をparser live受入へ昇格しない。価格ページの低負荷構造確認も、取得・保存範囲の審査と別の実行承認後に行う。

時間料金と月額は別unitで同一instanceを対応付ける。空欄はnull/not_reported。1run48観測、Private SQL20文batch、dailyの48観測/512KiB/最大4part、NAS snapshotの既存上限は変更しない。cohort外の大量行を先に置いた試験でも末尾の対象行を含め、超過・truncated・結合セル・header改変をcompleteにしない。

Rebro v2のキーは `public-case:<hash(period, product, quantity, amount)>:<occurrence>`。行順を変えても内容のmultisetは同じキー集合になる。同一内容の別事例は別occurrenceとして残すが、現物の取引を識別できるとはしない。価格/数量が修正されれば内容キーが変わり、同一取引の訂正との自動突合はしない。取得間で同内容を再観測すればreobserved、消失はnot_seen。年月はmonth精度でtransaction_at=null。長期比較でこの識別限界を除外理由として扱い、約定IDや市場成約数に変換しない。

旧v1の記録・契約hash・履歴は書き換えない。新cohort/methodは別のレビュー済みconfig/契約hashで開始する。scope/methodが違う履歴を同一条件のnot_seen/revised比較へ混ぜない。今回変えたのはdisabled proposalのmethod/cohort/提案版であり、9 rightsや有効化状態は不変。

## 11月1日以降の規約と内部観測の判断

一次資料: [旧/現行monitor](https://soroban.highreso.jp/terms)、[改定告知](https://soroban.highreso.jp/5402206)、[改定後全文](https://soroban.highreso.jp/5401872)。2026-10-18 06:09:44 UTCにこれら3文書だけを取得し、固定リンク・日付表記・hash等のmetadataを確認。本文は保存せず、価格ページは呼ばない。新版には一般適用2026-11-01と国外例外2026-08-27の表記がある。取得成功は内容の許諾ではない。

- 旧 `highreso_domestic_pre_20261101` は2026-10-31T15:00:00Zを越えるreview_afterを拒否し、その時刻から新規取得が停止する。このUTC時刻はJST日付境界を採る運用上の停止で、サイトが発効時刻を指定したという主張ではない。
- 新 `highreso_domestic_post_20261101` は監視先を**固定の `/5401872`** に限定。別の契約承認・新文書のhash・前版hashとの相違・新文書審査・公開ページへの適用審査・Private取得/保存/分析根拠・境界以降の取得開始日を要求する。旧hashを自動コピーしない。旧契約の時刻だけ延ばしても拒否する。
- [未承認の新契約審査票](personal-execution-20261018/highreso-post-20261101.review.json)は実行不可。審査結果のref/hash、取得/分析期限、owner承認はnullのまま。実行時もrobots→選択した固定規約URL→固定データURLの3 GETを維持し、新規約のhashが違えばデータGET前に停止する。任意URL/redirectは追加しない。
- 提供者許諾は引き続きunconfirmed。個人研究・無返信・robots許容を3用途の根拠にしない。事実の内部記録を商用再配布許諾と混同せず、license_url=nullだけで一律に商用ライセンス待ちとも判断しない。公開ページの条件適用と、具体的に許容される取得/保管/分析の根拠をsourceごとに所有者が審査する。
- Rebroの[通信買取規約](https://gpu-kaitori.com/rules/)は別サイト利用規約に言及する。2026-10-18にWebツールで参照したが、全文の所在と公開事例取得への適用は未解決。未確認を明示禁止とも許可とも断定しない。明示禁止・403/429/CAPTCHAを回避して取得を有効にしない。

継続保存owner_continuingを維持する。10年後も価値を持つ履歴が目標で、90日はbackup世代の寿命にすぎない。承認した保存根拠の有効範囲、明示終了/取消し、コピー削除義務は別に守る。規約再レビュー期限だけで履歴を削除しない。

## NAS資格情報: release blockerと分離案（設計のみ）

現行 `personal-nas-transport.ts` のprefix制限はアプリの誤操作防止であり、漏洩したS3 credentialの権限ではない。[R2公式の権限仕様](https://developers.cloudflare.com/r2/api/tokens/)ではObject Readは指定bucketのobject read/listを許す。既存EVIDENCE bucketへの資格情報を渡せば、NASコードを迂回してPoC/他sourceの証拠を読める危険がある。**既存private evidence全体に届くtokenをNASへ渡す構成でのreleaseは禁止**。

採用候補は、既存private evidenceとは別の**NAS配信専用export bucket**。現行data/health分離とhealth HMACは維持し、既存private evidence・専用export・専用healthの3領域にする。resource名/ID、token、Secret、bindingは未設定、今回は作成しない。

| 境界 | 設計案と残件 |
|---|---|
| NASデータcredential | export bucketだけのObject Read。既存EVIDENCE/healthへのread・すべてのdata writeは不許可。アプリ外S3 clientでも既存bucketを拒否する実効scope試験が必要 |
| Collector出力 | 将来の専用export bindingへ許可済み正規化part・manifest・catalog・必要最小control投影のみ書く。raw/PoC/他source証拠は複製しない。現在はEVIDENCE内に出力する実装なのでbinding追加だけで完了とはしない |
| hash/pin | 元の取得authority/原bucketを示す既存契約hashは書き換えない。輸送先export bucketを別pinにする将来protocol/contract差分が必要。part hash/manifest/現在controlが一致してからcatalogを確定し、両bucket間transactionを仮定しない |
| 取消し・削除 | 元controlが権威。exportの取消し/削除とNASへの伝播をcheckpoint付きで完了させる。control投影が欠落/古い/複製失敗ならNAS受入/復元を停止。snapshot復元で現在controlを巻き戻さない |
| health | 別health bucket・別credential・固定PUT・HMAC。Object Write credential自体は固定prefix/PUTだけの権限を保証しないので、このbucketに他用途データを置かない。HMACと書込み鍵の同時漏洩は偽通知リスクとして扱う |
| 復元試験 | 既存age/hash/契約/期限/取消し/新規staging検査に加え、専用exportと元EVIDENCEを別の模擬bucketで試験する将来差分が必要。欠落part・遅れたcontrol・片側書込み失敗・旧pin・read-only credentialの越境拒否を受入条件にする |

専用export実装・実効権限・実NASでの鍵保管/復号/復元は未検証で、release blocker。今回のNAS作業は既存実装の回帰検証とこの設計評価だけ。NAS変更、bucket作成、token発行、Secret設定、機能増築は行わない。既存合成S3 prefix試験でクラウドIAMの分離を証明したとは報告しない。

## 移行・本番統合・rollback（未実行）

0014は#16で前進追加、0012の再作成箇所でも同じDELETE禁止triggerを復元する。新規0009→0012→0014と、0009→0014適用済み→後から0010〜0013の順序を試験し、FK・期限・観測・assessmentを照合する。0012適用済みの環境は0014で保護を追加できる。0009は変更しない。一般研究のreconcile/purgeにあるpersonal専用authority拒否をmerge時に維持する。

本番反映前に最新の実配信Worker commit/version、bindings、Cron、PoC Private、ECB/Models設定、適用migrationをread-onlyで照合する。このタスクでは本番を再監査したとはしない。配信版から統合branchを作り、必要な研究コード/migrationだけ選択的に取り込む。旧main由来のPR全体を上書きdeployしない。既存Public/API/Admin設定には触れない。

rollbackは新sourceの取得だけ停止し、確認済みの直前配信versionへ戻す計画とする。IDを推測しない。保持/取消しcontrol・履歴を残し、down migrationで破壊しない。停止後も必要な保守が継続できることを別途受入する。main merge、remote migration、deploy、Cron・Secret・grantの変更はいずれも未承認。

## 検証結果の読み方

新fixtureの価格/ID/行数はすべて独自の合成値。見出し階層、複数table、GPU切替、48件境界/超過、時間/月額対応、null、DOM破損、重複事例、再観測・消失、規約切替、移行順序を試験する。既存日次40run/80観測・NAS復元・11年後保持・public境界も回帰対象。最新commitの全件/check/runtime/build/offline preflight/CI結果はPR本文に記載する。synthetic成功はlive page/実NAS/鍵/productionの証明ではない。
