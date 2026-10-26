# PR案: Highresoの型番変更で掲載系列が分断される問題を修正

Highresoの型番表示だけが変わると同じ掲載内容をfirst_seen/not_seenとして記録していた。製品・GPU数・VRAM・ストレージ・OS・単位と重複順位から作る安定キーへ移行し、型番変更をrevised＋改名元として記録する。価格改定・実際の消失・再登場は従来どおり区別する。

既存観測は不変のまま、private 0018に追記専用の対応表を追加する。10/26→10/27の対応案は読取専用SQLで出力し、件数不一致等は結び付けない。private履歴／AdminReadは対応表を通して「型番変更」と連続系列を投影する。公開DB/API・権利・Cron・Secrets・NASは変更しない。稼働設定はv2を維持し、v3は別の設定候補に置く。

配備は相互レビュー・全CI成功とAdmin側のcontract/表示更新後、**0018 migration → 対応表dry-run確認 → 別承認済みの対応表適用 → configの明示adoptとCollector/Adminの協調deploy**の順。旧版とconfigへ戻す際も、新表・対応表・v3観測は削除せず、保持処理とR2 control markersを維持する。詳細と復旧条件は [本番手順・ロールバック](highreso-stable-key.md) に記載。

検証：check、build dry-run、offline preflight、schema生成、Nodeテスト8件が成功。SQLite＋メモリR2の一時互換環境で既存94件＋新規7件が成功。通常のworkerd runtimeはサンドボックスのローカル待受け禁止で未完了。Claudeレビューも未ログインで未取得。CI・相互レビュー完了まで配備しない。本作業ではpush・PR作成・本番操作・実サイト取得なし。
