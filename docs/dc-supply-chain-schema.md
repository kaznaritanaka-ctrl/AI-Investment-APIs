# DC・電力・取引関係の後続設計

Phase 2ではsrc/dc.tsのschemaとsynthetic検証のみです。実案件・企業データの収集や公開APIは作っていません。

project → site → phaseを別IDにします。projectはoperator/owner/tenantを分け、siteは所在地とその根拠、phaseは計画・申請・電力契約・建設・系統通電・設備引渡し・IT設置・IT稼働・延期・中止を区別します。予定日と実績日も別です。

capacity observationはscope_id、measure_kind、MWのdecimal、as_of日、出典・観測時刻・basis・証拠水準を保持します。planned_mw/contracted_mw/energized_mw/it_operational_mwを足しません。施設の受電容量とIT負荷容量、別phaseの重なり、将来増設込みの累計値を混ぜません。PUE不明の換算はしません。

relationshipはfrom/to entity、role（GPU vendor/OEM・ODM/rack integrator/電源冷却/施工/facility owner/utility/financier/cloud customer）、contract_status、valid_from/to、disclosed_vs_inferred、project/site/phase、sourceを持ちます。企業間協業は特定siteへの納入証拠ではありません。schemaも企業協業にdelivery date/phaseを付けることを拒否します。納入にはproject/siteと明示的な稼働報告根拠を要求します。

調査手順は、①案件の識別と同名案件の分離、②一次開示と発表日の確認、③所在地とphaseの対応、④MWの定義・時点・累計/増分の照合、⑤契約当事者/負担者/資産所有者の分離、⑥訂正・延期・中止を新観測で追加、⑦source権利・保持/公開の審査、です。企業レベルの取引をprojectへ推定割当しません。

将来のAI売上・課金利用・API消費量は、売上定義、期間、連結範囲、有償/無料を分離して別datasetにします。API単価だけから最終需要量を作りません。個別ケースから開始できる構造ですが、対話中の企業名・MWを未検証の実データとして登録しません。
