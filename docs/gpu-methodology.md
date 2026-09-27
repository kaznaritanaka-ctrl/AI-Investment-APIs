# GPU市場観測の方法（gpu-market-v1）

この基盤が測るのは、定義した検索範囲に現れた提示価格と提供状況です。市場全体の在庫、成約、実現売上、稼働率、未稼働GPUの倉庫在庫は測っていません。強気・弱気のどちらも実装上の正解にしません。

## 観測単位と識別

gpu_rental と gpu_secondary を別datasetにします。原通貨・decimal string・課金単位を保存します。node_hour、gpu_hour、second、monthを混ぜず、月額を720/730時間で換算しません。GPU台数不明の按分もしません。単価への按分と中古価格÷レンタル時給は今回の公開指標には含めません。

カタログは識別辞書であり収集実績ではありません。model、明示VRAM（GB）、PCIe/SXM、明示SXM世代を照合します。GiBをGBに読み替えません。GB300/NVL72はrack/systemとして扱い、B300 GPUのSKUへ写像しません。不明・部品・故障品・GPUなしserver・rental listing・販売単位不明・auction/best-offerは確定した中古fixed-ask統計から除外します。

eBayのtitleは抽出時だけ参照し、証拠には識別した事実と分類理由を投影します。商品説明、画像、sellerプロフィール、OAuth tokenを保存しません。quantity_available_reportedは根拠がなければnullです。1 listingを1 GPUとは数えません。

## 取得範囲と品質

日次run → 検索partition → immutable page → snapshot。scope_hashはquery/filter/marketplace/sort/地域対応表/分類版/ページサイズを含みます。変更した検索は別scopeとなり、件数変化を同じ市場系列へ混ぜません。completeはその検索範囲を取り切った意味です。

ページ失敗・schema破損・totalの途中変化・重複ページ・上限到達・6時間のcapture window超過はpartial/quarantined/expiredです。公開coverageに理由コードを返し、完全取得の価格として公開しません。正常な0件はcompleteな空snapshotとして保存します。

GPUでは件数20%減や価格50%変動だけで隔離しません。同じ比較条件で確認できた大幅変動はconfirmed_large_price_change警告付きの有効観測です。SKU・lot・通貨・契約等の変更、比較条件不明の大幅変動はreview隔離します。警告、統計除外、隔離、権利停止は別です。FX/AI価格の従来基準は維持します。

次の同一scope完全snapshotに存在しないIDはnot_seenです。soldではありません。別IDの再出品を統合しません。価格・条件の訂正は保存済み証拠を使い、新しいparser版・review_ref・recorded_at・snapshot・supersedes IDを追加します。元行や元snapshot membershipは更新しません。

## 統計

比較keyにはSKU、VRAM、form factor、販売単位・台数、状態、format、currency、税、提供地域、契約、専有/共有、minimum term、付帯構成、network、price scope、basis等を含めます。地域はサービス提供地です。seller所在地や本社所在地から補いません。

中央値・25/75分位はdecimal演算のtype 7です。金額をfloatへ変換して並べません。最低サンプル数は1（記述統計）であり、統計的信頼性や危険閾値を主張しません。unknown条件を含む提示価格分布はその条件を明示し、税抜確定比較には使いません。secondary/aggregatorは独立サンプルへ加えません。除外理由ごとの件数を返します。

7/30/90日変化は同じsource/scope/cohortの該当UTC日の完全snapshotを参照します。欠測を補間しません。履歴が足りなければ値はnull、statusはinsufficient_dataです。同価格の翌日も新観測です。

matched-offerは前回と今回に共通するrecord IDかつ同一条件の集合です。その両時点の中央値比と加入/未観測件数を返し、全listingの中央値変化と区別します。IDが同じでも条件が違う観測はmatched集合へ入れません。

availabilityはoffer-regionの根拠付き状態の割合です。known_fractionとavailable_fraction_of_knownを返します。GPU供給台数や稼働率ではありません。first_seen_rangeはこのcollectorが観測を始めてからの範囲で、出品開始以前の滞留日数を推定しません。

## spot・世代・日米比較

spot/on-demandは同じprovider/SKU/region/その他条件で比較します。世代間比はSKU/model/VRAM以外の条件を揃え、両方の仕様を返します。性能調整価格ではありません。比較候補探索は各cohortにつき同じUTC日の最大10件で、網羅的な市場指数ではありません。比較不能理由も保存します。

日米比較はJPとUSの提供地域根拠があり、net-tax（excluded）、専有/共有、network、構成、最低台数、契約等が一致する場合だけ作ります。異なる地域・providerであること自体は明示した比較軸として残します。税不明や条件不一致を推測で埋めません。

JPY原値とUSD原値を保持し、JPY換算は両価格観測以前に取得・記録された同日付のECB EUR/USD・EUR/JPYから算出します。最大4暦日までの参照値に限定し、source_date、age、carried_forward、FX observation IDを派生行へ保存します。休日の参照値を当日の実勢FXとは表示しません。原通貨変化と換算値を別に返します。

すべての派生値に入力snapshotとsource/policyの系譜を保持し、FXは原観測IDも保持します。入力の権利停止・期限切れ・retention削除があれば公開読取時にも非表示になります。対話で登場した実価格や企業情報を初期データにしていません。
