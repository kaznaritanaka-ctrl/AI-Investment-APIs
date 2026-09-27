# 方法と限界

原観測・計算結果・解釈を分離する。数値変化は同一provider/model/条件の系列内のみ比較する。比較条件が変わると別系列になり、価格変化率として合成しない。欠落は提供終了ではない。

ECBのq_Cは1 EUR当たり通貨C。USDJPY=q_JPY/q_USD、C建て価格のJPY換算=price_C*q_JPY/q_C。入力の日付が一致しない、必要な入力がない、観測時点がas_ofより後なら計算しない。decimal precision 40、出力は小数18桁までhalf-even。丸めは原系列に適用しない。公開クロスは自前計算と明示し、原系列と全入力の権限を保持する。

TARGET休場（土日・元日・Good Friday・Easter Monday・5/1・12/25・12/26）を計算する。ECB source_dateを改変しない。休場日のAPIはfx_carried_forwardとfx_ageを示し、最新営業日からの欠測と区別する。時刻の締切はEurope/Berlinの日付と公表目安16:00に余裕を加えた17:00。遅配・障害はstaleとして表示し、休日を新レートにしない。

固定構成費用の計算関数は入力N・出力Mを同じprovider観測から使う。million_tokensへの換算倍率は1,000,000。unknown tier・追加課金の不明な場合は計算を拒否。これはトークン構成の仮想費用であり同等仕事量・品質の費用ではない。推論token、cache、request追加費用は仮定に明記する。初期APIには固定構成指数を公開しない。

APIのobservationsはリビジョンも含む監査履歴。latestは最新訂正版を返す。as_ofはobserved_atとrecorded_atの両方で切り、当時未認識の後日訂正を混入させない。cursorはpublic seq上限を固定し、新規追加に影響されにくいkeyset pagination。権利取り下げはsnapshotより優先する。

coverageは選定したモデルと通貨に限定。世界市場・需要加重・実取引・稼働率・供給量の指標ではない。GPU料金とトークン料金から利益率や供給過剰を推定しない。

## Phase 2

GPUの定義は[gpu-market-v1](gpu-methodology.md)に分離します。FX/AIの比較条件・隔離基準はそのままです。GPUの実際の値動きと取得障害を分け、unknown、insufficient_data、partialを0にしません。方法IDはAPI/v1/methodology/gpu-market-v1でも返します。
