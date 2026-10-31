# 原 HS 個人持股 V2

只替換原 `index.html` 的個人持股區塊；原導覽、首頁、雷達與籌碼頁保留。
`legacy-home-view.js` 保留舊持股腳本中原樣的首頁唯讀情緒呈現函式，
不啟動舊持股的交易、遷移、績效快照或儲存流程。

## 本機資料邊界

真正的儲存鍵使用 `hsPersonalV2.v1.` 加上邏輯鍵的 UTF-8 十六進位編碼。
舊版持股鍵、完整備份、還原與恢復點的前綴掃描均不包含此命名空間。
私有 Storage view 只列舉新鍵，沒有 `clear()`，不會讀取或自動遷移舊資料。
Shared Web Lock、Journal、Revision、SHA、原本的現金與股息契約保持不變。
加密備份額外包覆 `HS_PERSONAL_V2_EXPORT_V1`，匯入必須預覽、匯出目前備份與確認。

僅提供持股登記、手動現金檢查點及參考設定；沒有 BUY、券商下單、
Approval 消耗或 Reservation 轉換入口。無自動跨裝置同步，無外部高水位防回退保證。

## 可重現封裝

`node personal-v2/build.cjs` 從已封版的 `31394246f406134f0dc0fe9df2d25ee541c6efeb`
取得 26 份未修改的計算模組，封裝於私有 browser namespace。
`sealed-sources.json` 記錄各原始 Blob 內容 SHA-256；測試逐一驗證。
不覆寫原站任何共用金融模組或共用 JavaScript global。

## 行情限制

瀏覽器僅以 GET 讀取 TWSE MIS 官方 HTTPS 原始回應；核對代號、交易所、
成交欄位 `z`、資料時間、原始 SHA 與既有十分鐘有效期。
不使用買賣報價、`pz`、舊快取或日期不明價格替代成交價。
官方 CORS 阻擋、休市缺價或逾期時，明確顯示行情待更新，估值與完整圓環不可計算。
這只是本機唯讀估算，不代表正式 Source Trust 或可執行買進額度。
C4 使用原站正式快照與原分級，顯示日期；009815 WAIT_NATIVE、00631L 不推薦。

## 發布及回復

使用原公開儲存庫的既有 GitHub Pages main/root，不新增服務、網域或固定費用。
發布前備份原 main Git Blobs；需要回復時，以新的 revert commit 撤回本次
`index.html` 與 `personal-v2` 資產。不回滾行情、C4、Ledger 或其他使用者資料。
新命名空間仍保留，重新發布新版後可再讀取；不要清除網站 Storage。

iPhone Safari／PWA 真機未驗收，維持 PENDING。
