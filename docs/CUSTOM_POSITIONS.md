# 自訂部位（3.2.0）

本功能是股票內部的分類與目標比較，不是新持股帳本、不產生交易，
不影響個股目標、C4、現金、建倉演算法或交易 Writer。

- 使用 V3 原本的私有命名空間 `hsPersonalV3.v1.`。
- 新增可選設定 `hsRadar.portfolio.customPositions.v1`，契約
  `HS_CUSTOM_POSITIONS_V1`。含 revision、前版 SHA、確認時間、顯示模式、
  部位 ID、名稱、代號與可空白的整數 basis-points 目標。只保存設定。
- 缺少此設定代表從未分類／舊備份，不會自動建立或遷移資料；設定損壞
  則停用部位寫入並顯示錯誤，不得重設。既有金融 schema 不變。
- 沿用正式 Shared Web Lock、全資料 expected snapshot、Journal、寫後驗證；
  失敗或結果不明需恢復，不能宣稱成功。儲存時阻止更新重載。
- 所有部位目標合計不得超過100%；同一代號只可在一個部位。
  刪除分類不刪持股。軟刪除的持股恢復後仍可回到原分類。
- 分母僅使用全部有效股票市值；任何持股缺價時不給完整占比、差距、
  目標金額。百分比計算前不四捨五入。
- 畫面「持股成本」是目前股數乘券商損益平衡價的推算值（整數分），
  不是歷史成交成本；原帳本、已實現／未實現損益算法沒有改寫。
  不明分割基準或缺少成本時顯示資料不足。
- 原完整備份及 Recovery Point 會涵蓋同命名空間的新設定；加密匯出、
  匯入預覽前額外檢查此 schema/SHA。還原前仍須匯出當前版本及明確確認。
  舊備份無部位設定時，預覽明示將還原0個部位；取消預覽不寫資料。
- 舊版 Writer 的原始邏輯 key 不會碰觸 V3 編碼 key；不得因此宣稱可抵禦
  惡意同源腳本或完整本機回退。沒有自動跨裝置同步，換機須手動加密備份。

測試：`node tests/test_portfolio_custom_positions.js`；設好既有 Playwright
依賴後，以外部證據資料夾 `HS_GROUPS_OUT` 執行
`node tests/portfolio_groups_browser.cjs`。只使用合成資料及新 browser context。
實機 iPhone Safari／原桌面 PWA 必須由實機驗收，不以 WebKit 模擬代替。

回退：保留上一版 Pages artifact／精確 SHA，正常 revert 程式 commit 再走
原 Pages workflow；不得還原金融 JSON 或清除使用者 Storage 來回退介面。
