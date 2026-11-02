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
當前：固定本輪Commit後，三輪完整PWA（原兩項WK環境SKIP不擴大），
再同版完整JS/UI/相容/版面/保護驗證。證據與每階段結果保存於相鄰
`hs-v330-evidence/`；最終Commit及結果以該處fixed-acceptance紀錄為準。
不Merge、Push或Deploy；Writer OFF；iPhone真機PENDING。
