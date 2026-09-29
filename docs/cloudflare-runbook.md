# Cloudflare初期設定・デプロイ手順

2026-09-30のP0作業では既存設定を維持しています。Account/zone/D1 ID・所有domain・Workers Freeの手動確認根拠が設定されています。クラウド実環境はこの作業で照会していないため、本番稼働は未検証です。値を推測して追加しません。Models.dev拡張の適用順序は[専用手順](models-enablement.md)です。

## 現在の設定と実環境の区別

collectorはworkers.dev/preview/HTTP routeなし、COLLECTION_ENABLED=true、既存3 Cronです。APIはapi.ai-investment-research.netのcustom domainを持ちます。公開WorkerのbindingはPUBLIC_DBとrate limiterだけです。private D1/R2/取得Secretsはcollector側だけです。

config/deployment.jsonはstage=enabled、plan=free、Time Travel=7日で、過去の公開・初回収集の承認refがあります。設定済みD1 IDをplaceholderへ戻しません。pnpm buildは常に2 WorkerのWrangler dry-runです。GitHub ActionsはCI専用、Cloudflare Git連携による二重deployは使いません。

## ローカルで安全に実行できる検査

- pnpm check / pnpm test / pnpm test:runtime / pnpm build
- pnpm preflight: ネットワークなし。未設定ならexit 2、work/preflight.jsonに不足項目。
- node scripts/preflight.mjs --allow-unconfigured: CI用。構造エラーは失敗し、既知の未設定はready=falseで報告。
- pnpm deploy:plan: 手順表示のみ。deploy/migration/リソース作成を実行しません。

事前確認項目はaccount固定、public/private分離、placeholder、stageとCronの整合、source別4種retention、GPU owner/field許可、1page・50件の処理予算、公開/夜間運転の別承認です。

## 一度だけ必要な設定

1. 所有者が確認したAccount ID、zone ID、所有domain、2個の既存D1 ID、R2 bucketを記録し、両Wranglerのaccount_idを同じ値で固定します。設定値は秘密ではありませんが、環境変数との不一致は停止します。
2. WorkersプランとTime Travel（Free 7日/Paid 30日）を確認します。Website用Free/Proと取り違えません。GPU処理はFreeの50 SQL制約内ではないため、Paid確認をpreflightで要求します。未契約なら費用説明と別承認が必要です。
3. source別許諾・field scope・owner_approval_refと、evidence/archive/normalized/backupの日数・根拠を確定します。GPUは初期値nullです。source policy版を新しくし、許可された区分だけ変更します。
4. API/OAuth/通知の秘密はcollector Secretsへ設定します。ローカルは環境変数またはgitignore対象の.env/.dev.varsを使用します。値をチャット、Git、ログへ出しません。
5. 通知先と外部health監視を選びます。未接続のまま通知済み・監視中とは報告しません。通常運転にCSVや価格転記を要求しません。

## 明示opt-inのread-onlyクラウド検査

pnpm preflight:cloudflare -- --read-only は対象accountとCLOUDFLARE_API_TOKENが設定されて初めて接続します。GETでaccount、zone所有/active、D1、R2、R2公開状態/lifecycle、Worker bindings/Secrets名/Cron/subdomain、subscriptionを確認します。migration名だけはD1の固定SELECTをPOST query APIで読みます。秘密の値やレスポンス全文は出力しません。結果不明・権限不足は未確認として残します。subscriptionが空でもFree確認済みとは推定しません。

このタスクでは実行していません。Cloudflare API応答形の実アカウント検証、CPU計測、既存migrationの一致確認は設定後の作業です。

## 新規bootstrap環境専用の順序（既存enabled環境へ再適用しない）

1. 対象account/既存D1/R2とバックアップ復元手順を確認し、sourceごとのretentionが復元後も適用されることを確認。
2. private/publicそれぞれに0002を前進適用。0001を書き換えません。Wrangler migrations applyを対象config・DB名・remote指定で実行するのはDB変更承認後だけです。
3. collectorをCron空配列・内部gate falseのまま一度deploy。Secrets、R2非公開、healthを検証。
4. 公開承認後stage=publishedとし、APIだけにapi.<確認済み所有domain>のcustom_domain routeを設定。ダミーIPのAレコードは作りません。collectorは引き続き停止。
5. 夜間の継続取得を別承認後、stage=enabled、COLLECTION_ENABLED=true、WranglerのcronsにCOLLECTION_CRON/WATCHDOG_CRON/GPU_RESUME_CRONの3式を登録し、collectorを一度deploy。

上記は新規作成時の説明です。現行環境へのP0適用では両DBの0003を前進適用し、既存Cron・domain・gateを保ってWorkerを更新します。権利変更・remote migration・deployはそれぞれ別承認です。

COLLECTION_CRON=17 18 * * *（JST翌03:17）、WATCHDOG_CRON=47 18 * * *（翌03:47）。GPU_RESUME_CRON=*/5 18-23 * * *は同じ日次runを1pageずつ再開する候補設定です。新しい市場snapshotを5分ごとに作りません。監視・失敗復旧・保持期限処理もこの枠で決定的に動きます。

Cronの唯一の管理元はWranglerです。[公式説明](https://developers.cloudflare.com/workers/configuration/cron-triggers/)に従い、停止時は項目省略ではなく明示空配列に戻します。

## Retentionと復旧

既存案のevidence/ecb/365日、evidence/models_dev/90日、archive/365日を維持します。GPUには継承しません。GPUはevidence/<source>/とarchive/<source>/に短い個別lifecycleを設定し、D1のnormalized retentionとTime Travelも確認します。許諾上限がある場合、normalized日数＋backup日数も範囲内に収めます。[R2 lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

source停止時はpublicを先にrevoked、privateをsuspendedとし、現在のread gateでも派生値を止めます。DB復元後は公開を停止したまま現行policy、retention、migration、snapshot公開確定を再照合します。バックアップから期限切れ資料を再公開しません。
