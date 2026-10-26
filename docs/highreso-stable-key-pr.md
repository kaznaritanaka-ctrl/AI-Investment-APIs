# PR案: Highresoの型番変更で掲載系列が分断される問題を修正

Highresoの型番表示だけが変わると同じ掲載内容をfirst_seen/not_seenとして記録していた。製品・GPU数・VRAM・ストレージ・OS・単位と重複順位から作る安定キーへ移行し、型番変更をrevised＋改名元として記録する。価格改定・実際の消失・再登場は従来どおり区別する。

既存観測は不変のまま、private 0018に追記専用の対応表を追加する。10/26→10/27の対応案は読取専用SQLで出力し、件数不一致等は結び付けない。private履歴／AdminReadは対応表を通して「型番変更」と連続系列を投影する。公開DB/API・権利・Cron・Secrets・NASは変更しない。稼働設定はv2を維持し、v3は別の設定候補に置く。

Adminの追加3項目は型番変更のあるエントリだけに出力し、変更のない応答は従来と完全一致にする。Admin更新までは変更エントリが出なければ動くが、1件でも出ると旧strict validatorが応答全体を拒否する。Adminのcontract/表示更新を先行配備し、項目あり・なし両方の受理を確認するまでCollectorを配備しない。

OS未認識・複数OSの行は型番と掲載条件を含む `hr:fallback:v1:` キーにフォールバックし、ページ全体を止めない。前回complete runの読取はHighreso v3またはcompleteページに限り、他GPUアダプターのpartialページの動作を維持する。

配備は相互レビュー・全CI成功と**Admin先行配備・互換確認 → 0018 migration → 対応表dry-run確認 → 別承認済みの対応表適用 → configの明示adopt → Collector deploy**の順。**migration → deploy** を厳守し、0018の適用とjournal確認前に新Collectorを配備しない。旧版とconfigへ戻す際も、新表・対応表・v3観測は削除せず、保持処理とR2 control markersを維持する。詳細と復旧条件は [本番手順・ロールバック](highreso-stable-key.md) に記載。

本作業は合成データのローカル検証のみ。ネットワーク接続・Cloudflare操作・push・deploy・本番書込みは行わない。相互レビューとCI完了までは配備しない。

検証：`pnpm check` / `pnpm test` / `pnpm test:runtime` / `pnpm build` はすべて成功。Vitest 55ファイル・602件とNode 13件、合計615件が成功（失敗・skip 0）。旧Admin strict契約での変更なし応答、OS不明行のフォールバックと通常行の混在、既存GPUの前回run削除ゲートを検査した。runtimeはGPU 1,051件・Models最大1,000件の合成データを含む。buildはローカルdry-runのみ。offline preflight成功（network_performed=false）、生成schema/OpenAPIの差分なし。修正後の相互レビュー・CIは未実施。PR本文の更新はこのローカルファイルのみ。
