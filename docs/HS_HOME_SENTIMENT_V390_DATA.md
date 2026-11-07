# HS V3.9 Phase A／Phase B 資料契約

## 已驗證：加權指數

- [TWSE 每日市場成交資訊](https://www.twse.com.tw/zh/trading/historical/fmtqik.html)，[政府開放資料集](https://data.gov.tw/dataset/11672)。
- 收盤與日變動取 FMTQIK 同列。前收取報表前一有效交易列（必要時跨月）；只接受兩個收盤值相減等於公告漲跌點數。百分比是漲跌點數除以前收。
- 2026-11-06 收盤 39,701.64 點；11-05 前收 41,574.72；變動 −1,873.08 點、−4.51%。亦與 [TWSE 當日大盤統計 MI_INDEX](https://www.twse.com.tw/exchangeReport/MI_INDEX?date=20261106&response=html&type=ALLBUT0999) 公告數值一致。
- home-taiex.json 記錄來源、原始回應 SHA-256、兩個交易日、取值／更新時間及驗證狀態。產生器以暫存檔原子替換；無新資料維持原檔，同日改值報錯等待人工核對，舊日期不覆蓋。收盤前不接受當日值。
- 候選排程在台北 16:50、19:20 檢查；成功發布獨立顯示資料檔後，沿用現有 Pages workflow_run。和行情／FINAL／Watchdog 不共用資料檔或資料驗證。未合併前不啟用。
- 瀏覽器只讀同源快照。既有已驗證值可在無網路時從獨立公開展示儲存鍵讀取，不寫入金融儲存或 Service Worker 快取。回到前景、連線恢復及可見頁面每五分鐘重新檢查；沿用時不改原交易日。

## 阻擋：散戶淨留單

HS 的 futures-position.json / estimated_non_institutional_tmf 是一般交易時段、所有有效月份的「全市場分別扣三大法人多、空未平倉」餘量。即使有整數 net 與 net_change，也不等於實際散戶或自然人的未平倉部位。不能直接從多空比還原口數，也不能用外資或全市場數字替代。

[期交所各期貨契約三大法人資料](https://www.taifex.com.tw/cht/3/futContractsDate) 不含自然人欄位；[期交所觀測站](https://www.taifex.com.tw/eventTaifexTradingCenter/cht/index.do) 的三大法人／大額交易人不是自然人分類。[期交所專題](https://www.sfb.gov.tw/uploaddowndoc?file=publication%2F202503201812170.pdf&filedisplay=04-%E5%B0%88%E9%A1%8C%E4%B8%80.pdf&flag=doc) 曾分析自然人未沖銷淨額，但不構成可持續每日取用的公開資料來源。未找到可驗證、可持續且可公開轉載的自然人逐日口數資料。

Phase A 僅替換加權指數卡；正式首頁保留原散戶微台多空比名稱、推估標示及計算方式。Phase B **BLOCKED**，不顯示散戶淨留單口數。解鎖需提供具使用權的 TMF 自然人每日未平倉多、空（或淨額）來源、涵蓋契約及交易時段，並能核對前一有效交易日。原雙卡候選及研究保存於本機 d0511719。
