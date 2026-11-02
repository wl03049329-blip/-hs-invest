# V3.3 最終驗收續作

基準：`feat/hs-portfolio-v330`／`42c31b7df59dc91e5ddc7fcbf6e292ac97bb6067`。
恢復時工作樹乾淨。所有 V3.3 UI／計算成果保留；不修改原 dirty main。

既有證據：相鄰 `hs-v330-evidence/`，新流程106、相容96、版面14、JS154已核對。
產品程式Commit97f164b；後續Commit為測試同步，74份Runtime資源逐位元一致。
PWA仍NO-GO：`sealed-pwa`歷史index導覽、`final-pwa-guarded`重載逾時；
診斷24 PASS/2既有SKIP不代表根因修復。

已確定性重現並修正：Headers後解除Body期限、快取導覽先等網路，
以及失敗producer清理刪除peer完整快取。RED/GREEN在相鄰證據目錄。
使用程式專用Worker Lock、v2快取suffix及同鎖prepare/CAS；金融鎖不變。
測試改核對commit、新Document與真實UI/資料；不提高Timeout或刪斷言。
先導PWA31 PASS/2原SKIP（含更新途中關閉、快取遺失精確修復）；真正
V3.2樹升級/重啟4 PASS。舊版深Profile的IndexedDB UnknownError失敗保留，
改用既有可寫TEMP Profile可完成；不宣稱產品已修復Windows儲存環境。
確定性生命週期9 PASS、原更新單元46 PASS；Chrome375新流程先導通過。
UI正向C4測試明確使用2026-11-01T10:00Z與原10/30來源，不改正式時間、
行情或C4；11/2即時行情不是此次正向fixture已驗證項目。
候選a041428固定首輪再FAIL，原紀錄`fixed-acceptance-a041428`保留。
純觀測先導雖PASS不計穩定性；再拆開啟動重載/穩態故障仍重現FAIL。
不附加Inspector的副本診斷：舊Worker NAV→DB_OPEN後沒有DB_VALUE，
新Worker同時ACTIVATE/CLAIM。缺少transaction abort/error使唯讀Promise
懸住；補完成/中止處理。曾試code hint但未解決完整阻塞，已保存diff並
撤除這個本輪試作；導覽及checks/status/CAS均真DB，舊成果未重置。
交易abort兩個保留安全RED→GREEN；另補導覽仍核對真DB反向案例。
修補後先導33項流程完成，但收尾新增的
嚴格錯誤分類少列WK離線公開JSON拒絕而FAIL，原log保留；限定分類明確
read-only JSON傳輸錯誤，完整保留JS異常拒絕與所有財務/版本斷言。
啟動時連續重載保留；穩態故障先核對CURRENT/控制中Worker，不增加期限。
再確認產品提前CURRENT：send優先registration.active而非真正Controller。
實際app-update.js的舊版2個案例均錯CURRENT（真RED保留），修補後
控制權尚未交接必須WORKER_HANDOFF，之後以實際Controller回覆判定。
CURRENT也須選定active==載入Commit；以Controller回覆而非Reg物件同一性。
Controller claim可先於activated；補statechange事件，不靠任意延遲重查。
已有程式判定Current但實際控制中Build舊版的RED；CURRENT現在需
loaded code=selected active=actual Controller build，未選定新code也不假Current。
關鍵測試根因已用空白Chrome證實：本機Playwright1.62.1 async-false
predicate在17ms回false，並未等到true；同步false正確503ms Timeout。
原交接守門用了async predicate，實際未等。改同步ready，再await原生回覆。
既有native-worker-probe的failed-install同樣誤用async，不引用該項PASS。
原先導每個失敗與trace全部保留。CAS測試改走真App更新與明確原生互動，
避免新頁自動更新已完成後仍等待手動提示；沒有放寬版本或財務斷言。
目前完整先導33 PASS/0 FAIL/2原WK SKIP；生命週期18/18及原更新單元
46/46 PASS。新固定Commit/三輪仍PENDING，不把先導當成最終穩定性。
當前：該最小修補先導後建立新固定Commit，三輪完整PWA（原兩項WK環境
SKIP不擴大），再同版完整JS/UI/相容/版面/保護驗證。證據保存於相鄰
`hs-v330-evidence/`；最終Commit及結果以該處fixed-acceptance紀錄為準。
不Merge、Push或Deploy；Writer OFF；iPhone真機PENDING。
