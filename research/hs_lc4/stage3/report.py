"""Stage3 research and UI design handoff; no scoring/deployment decision."""
import argparse,pathlib
from base import *
def pct(x):return '—' if x is None else f'{x*100:.2f}%'
def num(x):return '—' if x is None else f'{x:.3f}'
def interval(x):return '—' if not x else pct(x[0])+'～'+pct(x[1])
def run(out):
    guard(out);d=load(out/'distributions.json');review=load(out/'data-review.json');rec=load(out/'analysis-receipt.json');snap=load(out/'radar-snapshot.json');paths=load(out/'event-paths.json');risk=load(out/'risk-comparison-reused.json')['models'];v=load(out/'verification.json') if (out/'verification.json').exists() else None
    lines=['# HS 00631L L-C4 第三階段｜狀態判讀研究與UI設計','',
    '**研究報告與離線UI設計已交付。描述性雷達可供檢視；正式L-C4分數、進場資格與預測功能仍不可核准。沒有部署。**','',
    f"沿用 `research/hs-lc4-history-v1`，基礎 `{BASE}`，本輪分析 `{rec['head']}`。固定資料2014-10-31～2026-11-04；不是目前即時行情。",
    '前兩階段所有程式、原始收據、報告、失敗紀錄與結果先後逐檔SHA相同；本輪只新增stage3程式及新的研究輸出，不新增策略搜尋。','',
    '## 1. 資料完整性與研究副本','',
    f"從官方月報逐筆重建{review['rows']}筆00631L OHLC，分割前除22一次、之後不再調整；每欄與FinMind及既有修復副本核對一致。新的research-copy-00631L.json保留獨立版本，沒有覆寫Frozen或前兩階段資料。",
    '|222日殘餘差異（已一致化原價/調整價基準）|件數|','|---|---:|']
    for k,n in review['classifications'].items():lines.append(f'|{k}|{n}|')
    lines += ['',
    '- 另14個凍結檔缺漏日期逐一重建及比對，見missing-14.json；222日原值/官方值/調整/收據見conflicts-222.json。分割停牌不填虛構價格，也不將正常22倍基準差異算成新的來源錯誤。',
    '- 一刻度收盤差異不是二進位浮點誤差；182日多欄與19日平坦OHLC等殘餘衝突不能只用分割解釋。TWSE/FinMind一致支持研究採用官方值，但供應商內部錯因仍未證實，不宣稱全部原始成因已修復。',
    '- 00631L官方22:1，2026-03-31恢復交易、3/25～3/30停牌，最後分割前收盤443.15、參考價20.14。資料只調整一次，沒有自動改使用者股數或成本。',
    '- 所有歷史價格是2026取得的官方修復版本，不是每個過去交易日當時發佈的vintage，無法排除資料修訂偏差。計算上只看當時以前價格，不等於已驗證完整point-in-time資料來源。','',
    '## 2. L7事故時序：仍不解除FAIL_CLOSED','',
    '- 重新核對有效事故鏈與審核集合：狀態快照7筆、canonical事故8筆，差集仍是2026-10-19那一筆。operational_failure先建立unresolved/status，再append最新事故，最後寫出舊清單；prepare_review重讀新增後集合。',
    '- 這包含診斷清單時序問題與測試固定數量問題；最新事故未被批准或去重刪除。原測試仍保留，沒有把預期7改8。詳見incident-timing-review.json。',
    '- Frozen V1、正式Shadow、原C4、交易權限均不修改。研究價格核對通過，不能解除正式鏈的完整性審核，也不能回填歷史Shadow訊號。','',
    '## 3. 事件、0050環境與結果口徑','',
    '- 沿用第二階段完全相同的15個C95事件ID與固定70日冷卻，沒有挑下一個低點或增加策略。主分析固定14個全部觀察期已成熟的共同事件；第15個只在補充表列真正觀察完成的期限。',
    '- 0050環境使用官方分割調整收盤及現金分配構成的研究指標，避免除息或分割造成假跌勢；不是把股息虛構入帳或重投資。觸發當日指標高於MA200且MA200高於5日前均線為多頭，反之為空頭，其餘震盪。無匹配當日或不足資料列UNKNOWN，不跨停牌偷補。',
    '- 14個成熟事件的0050分類：多頭9、空頭2、震盪3。空頭只有2件，不能推出熊市成功率或哪種環境應買進。這是研究分類，不改HS正式C4。',
    '- 市場路徑報酬：觸發後第h日收盤/觸發收盤−1。只是描述，不是用已知訊號收盤進場的可執行策略。',
    '- 另列次開盤單位報酬：t+1實際開盤進、t+h+1實際開盤出，佣金各0.1425%、賣方稅0.1%、每邊滑價0.1%。這是未套部位/風控減碼的研究單位價格報酬，不是全帳戶NAV、已通過買進資格或實際可成交股數。',
    '- 未來high/low僅作結果標籤、MFE/MAE與破低觀察，從未拿最低價買、最高價賣。真實漲跌停排隊、零股、容量、個人費率仍不可驗證。','',
    '## 4. 5／10／20／40／60日分布','',
    '### 觸發收盤至未來收盤的市場路徑（非策略成交）','',
    '|期限|共同n|5分位|25分位|中位數|75分位|95分位|最差|平均95%年度區塊CI|','|---|---:|---:|---:|---:|---:|---:|---:|---:|']
    for h,x in d.items():
        a=x['common_mature']['close_return'];q=a['q'];lines.append('|'+ '|'.join([h,str(a['n']),*[pct(q[str(k)]) for k in [.05,.25,.5,.75,.95]],pct(a['minimum']),interval(a['year_block_CI']['mean_CI95'])])+'|')
    lines += ['', '### 次開盤單位假設報酬（含固定成本，不是帳戶報酬）','', '|期限|n|5分位|25分位|中位數|75分位|95分位|最差|中位數95%年度區塊CI|','|---|---:|---:|---:|---:|---:|---:|---:|---:|']
    for h,x in d.items():
        a=x['common_mature']['net_next_open_return'];q=a['q'];lines.append('|'+ '|'.join([h,str(a['n']),*[pct(q[str(k)]) for k in [.05,.25,.5,.75,.95]],pct(a['minimum']),interval(a['year_block_CI']['median_CI95'])])+'|')
    lines += ['', '年度區塊bootstrap2000次只表示已觀察樣本的不確定性；市場事件仍相依、歷史已被檢視，不能當預測區間。', '',
    '### 後續破低：歷史比例，不是未來機率','',
    '基準為觸發當日低價；觀察t+1～t+h最低價是否再低於該基準。深度=min(0,未來最低/觸發低價−1)，不把未來最低點當可買價。','',
    '|期限|破低n/N|歷史比例|Wilson描述區間|年度區塊比例CI|破低深度中位數|最深|期末未收復觸發收盤|','|---|---:|---:|---:|---:|---:|---:|---:|']
    for h,x in d.items():
        a=x['common_mature'];f=a['further_break'];depth=a['further_break_depth'];end=a['end_below_trigger_close'];lines.append(f"|{h}|{f['count']}/{f['n']}|{pct(f['historical_fraction'])}|{interval(f['wilson_descriptive_CI95'])}|{interval(f['year_block_CI95'])}|{pct(depth['q']['0.5'])}|{pct(depth['minimum'])}|{end['count']}/{end['n']}|")
    lines += ['',
    '- Wilson的獨立Bernoulli前提未證實，區間只作描述。年度區塊也只有少數年份，不可把11/14改寫成下一次78.6%會破低。',
    '- 在這14個固定樣本中，5日內皆曾有收盤回到觸發收盤；不能寫成100%反彈成功。0/14「期間從未收復」的Wilson上界仍約21.5%，bootstrap退化成0也不能代表零風險。更重要的是，曾短暫收復與期末獲利是不同問題。', '',
    '### 尾端事件與可用案例補充','', '|期限|主表完整共同n|已有收盤路徑n|已有次開盤出場n|','|---|---:|---:|---:|']
    for h,x in d.items():lines.append(f"|{h}|{x['common_mature']['close_return']['n']}|{x['available_case']['close_return']['n']}|{x['available_case']['net_next_open_return']['n']}|")
    lines += ['', '第15個事件未完成的20/40/60日結果一律PENDING，不以部分路徑補齊。逐筆見event-paths.json。', '',
    '## 5. 0050多頭／空頭／震盪差異','', '|市場環境|期限|n|次開盤中位數|最差|平均95%區塊CI|破低n/N|','|---|---|---:|---:|---:|---:|---:|']
    for reg in ['BULL','BEAR','RANGE','UNKNOWN']:
        for h,x in d.items():
            a=x['by0050_environment'][reg];n=a['net_next_open_return'];f=a['further_break'];lines.append(f"|{reg}|{h}|{n['n']}|{pct(n['q']['0.5'])}|{pct(n['minimum'])}|{interval(n['year_block_CI']['mean_CI95'])}|{f['count']}/{f['n']}|")
    lines += ['', 'n=0顯示未知，不輸出0報酬；n=2或3只可列樣本，不能據此驗證市場條件。這個受限C95群不是整體市場的隨機樣本。', '',
    '## 6. 急跌程度與反彈幅度的關聯','',
    'Spearman僅描述同14個成熟觸發事件。回撤欄是負值：負相關表示更負的回撤與較高後續值同現，並非因果或可預測。多個期限/因素一起檢查也有多重比較風險，未據此擬合分數或選參數。','',
    '|期限|速度對期末收盤報酬|DD120對期末報酬|DD240對期末報酬|速度對期間最高收盤反彈|','|---|---:|---:|---:|---:|']
    for h,x in d.items():
        a=x['associations'];lines.append(f"|{h}|{num(a['trigger_velocity']['close_return'])}|{num(a['trigger_dd120']['close_return'])}|{num(a['trigger_dd240']['close_return'])}|{num(a['trigger_velocity']['max_close_rebound'])}|")
    lines += ['', '短期/中長期的速度關聯不一致，樣本與環境分組太少；沒有未觸發日對照及新的獨立OOS，不能驗證泛用預測力或校準未來概率。', '',
    '## 7. 極端虧損與曾反彈仍失敗','', '|觸發日|0050環境|期限|次開盤進／出|單位淨報酬|低價相對進場|期間最高收盤反彈|期末未收復|','|---|---|---:|---|---:|---:|---:|---|']
    complete=[r for r in paths if r['common_mature'] and r.get('net_next_open_return') is not None]
    for r in sorted(complete,key=lambda r:r['net_next_open_return'])[:10]:lines.append(f"|{r['date']}|{r['market0050']}|{r['horizon']}|{r['entry_open_date']}／{r['exit_open_date']}|{pct(r['net_next_open_return'])}|{pct(r['low_vs_entry_open'])}|{pct(r['max_close_rebound'])}|{bool(r['end_below_trigger_close'])}|")
    lines += ['',
    '- 2020-01-30事件：40日次開盤單位報酬約−33.88%，期間卻曾有正反彈；多頭分類與急跌本身都不保證安全。',
    '- 2025-03-31事件：5日觸發收盤路徑約−33.80%，次開盤假設約−22.16%，兩個基準不同不可混算。事後看到期間最高價也不能假定能在那裡賣出。',
    '- 本群「期間從未收復觸發收盤」的定義下沒有案例；如實回報沒有，不放寬定義或事後挑另一個崩跌低點製造故事。期末虧損/再破低案例已完整列出。', '',
    '## 8. 首次買進與加碼：相同曝險規則對照','',
    '直接沿用第二階段已封存的固定TIME20四組結果，不重算、不新增選模。每組相同10%新增上限、超標次開盤減碼、相同成本與事件；平均曝險仍不同，不能只比報酬。以下是全帳戶NAV，與前面的單位路徑報酬分開。','',
    '|進場方式|帳戶報酬|CAGR|MDD|單筆最差|交易MAE|平均曝險|最大收盤曝險|完成交易|','|---|---:|---:|---:|---:|---:|---:|---:|---:|']
    for k,r in risk.items():
        m=r['metrics'];lines.append('|'+ '|'.join([k,pct(m['total_return']),pct(m['CAGR']),pct(m['max_drawdown']),pct(m['worst_trade']),pct(m['worst_MAE']),pct(m['average_exposure']),pct(m['max_exposure']),str(m['closed_trades'])])+'|')
    lines += ['', '下跌分批的帳戶回撤較小，不代表單筆損失較小；確認才進場僅2筆，不能宣稱普遍較安全或無效。曝險軌跡對照仍有一日延遲限制。前輪多重比較沒有穩健顯著改善，不因本輪改成雷達就變成正式資格。', '',
    '## 9. 研究版雷達：當前固定快照，不是正式分數','',
    f"截至{snap['asof']}：五日收盤變化{pct(snap['opportunity']['return5'])}，急跌速度{snap['opportunity']['crash_velocity_pct_per_session']:.2f}%/交易日；訓練期下跌日第{snap['opportunity']['positive_decline_percentile']:.1f}百分位。訓練資料僅{snap['training_start']}～{snap['training_end']}、正急跌速度樣本{snap['opportunity']['training_positive_days']}日。",
    f"120D與240D最高收盤回撤分別{pct(snap['opportunity']['drawdown']['dd120']['drawdown'])}、{pct(snap['opportunity']['drawdown']['dd240']['drawdown'])}；深度歷史分位分開呈現，沒有相加成買點分數。",
    f"0050研究趨勢{snap['market']['regime']}；{snap['stabilization']['description']}。研究價格可核對，正式Shadow仍FAIL_CLOSED、即時行情未驗證。進場授權永遠NOT_APPROVED；score/tiers/predictive_probability均為null。", '',
    '### UI交付','',
    '- [離線設計稿](radar-design.html)：上方固定日期與未核准資格，再列急跌、120/240D位置、0050趨勢、止跌、歷史分布及資料核對；黑金、手機單欄/桌機雙欄。可切換五個觀察期、展開方法與限制，沒有買單按鈕。',
    '- 完整欄位契約與狀態方案：研究分支research/hs_lc4/stage3/UI_DESIGN.md。高歷史百分位不轉成進場資格；研究價格OK與正式鏈鎖定可同時顯示。',
    '- 缺價格、回看不足、無匹配0050日期一律顯示資料不足/UNKNOWN，不以0或假中性取代。設計稿CSP禁止外連，沒有儲存、帳戶、金融寫入或PWA註冊。',
    '- 375px手機與1280px桌機等實際截圖見chromium-375-design.png、webkit-375-design.png及*-1280-design.png。這是離線研究稿，不是正式站UI，也不是iPhone實機。', '',
    '## 10. 可驗證／不可驗證與決策','',
    '- 已核對：官方研究副本、既定事件、當時以前價格的計算依賴、歷史路徑、0050分組、破低次數、成本口徑分離及四個既有風險對照。',
    '- 不可驗證：歷史每一天當時發布版本、供應商內部222日錯誤成因、未來反彈機率、新獨立OOS優勢、可實際撮合股數/價格、iPhone實機及正式PWA。小樣本分組不能拿來預測。',
    '- **研究狀態雷達設計可供審閱；正式L-C4分數、權重、加碼級距及進場資格仍NO-GO。** 不增策略、不挑歷史最高收益、不配實資。',
    '- 後續若另獲授權，先解決來源版本/事故審核、以真正未見的新事件追蹤固定指標，再評估是否有校準與預測依據。本輪不啟動部署或下一階段。', '',
    '## 11. 驗證與資料保護','']
    if v:
        for k,t in v['tests'].items():lines.append(f"- {k}: "+(f"{t['pass']} PASS / {t['fail']} FAIL / {t['skip']} SKIP（本輪實跑）" if 'total' in t else f"exit_code={t['exit_code']}（本輪）"))
        old=v['inherited_full_L7'];lines.append(f"- 完整L7：{old['pass']} PASS / {old['fail']} FAIL / {old['skip']} SKIP為前輪同Blob/同鏈證據沿用，不是本輪完整重跑；本輪另重現那1個既有失敗，沒有改斷言。")
        ui=v['UI'];lines.append(f"- 離線UI：{ui.get('pass')} PASS / {ui.get('fail')} FAIL / {ui.get('skip')} SKIP，Chrome/WebKit各320/375/430/1280共8組；另測缺資料。初次啟動缺少測試Chromium屬環境錯誤，紀錄保留，後改用已安裝Chrome及既有WebKit，未下載或放寬檢查。")
        lines.append(f"- Protected {v['protected']}/20、Provenance {v['provenance']}/7、三鏈PASS；前兩階段全部程式與證據逐位元不變，原dirty main與其他工作樹未改動。")
    else:lines.append('- 最終本輪驗證尚未匯入，暫不宣稱全部PASS。')
    lines += ['- Writer維持OFF；Frozen V1、正式C4、Shadow Ledger、個人持股、現金、Ledger、PWA均未改寫。沒有Push、PR、Merge、Deploy或自動交易。',
    '- 真實iPhone Safari／已安裝PWA：PENDING。設計稿測試不代表正式站驗收。', '',
    '## 12. 來源與重現','',
    '- [00631L官方22:1分割時程與參考價](https://www.twse.com.tw/zh/ETFortune/announcement?company=A00005&date=20260330&fund=00631L&seq=1&type=all)',
    '- 原始行情與除權息證據沿用stage1 source-manifest.json的314份URL/SHA收據；前輪封印及本輪輸出SHA見prior-stages-seal.json、report-receipt.json。', '',
    '```text','python research/hs_lc4/stage3/data_review.py --out ../hs-lc4-stage3-evidence','python research/hs_lc4/stage3/analysis.py --out ../hs-lc4-stage3-evidence','python research/hs_lc4/stage3/prototype.py --out ../hs-lc4-stage3-evidence','python research/hs_lc4/stage3/verify.py --out ../hs-lc4-stage3-evidence','python research/hs_lc4/stage3/report.py --out ../hs-lc4-stage3-evidence','```','',
    '全部價格與研究數值為公開歷史資料／假設，沒有讀取或輸出真實使用者持股或資產。']
    (out/'REPORT.md').write_text('\n'.join(lines)+'\n',encoding='utf8');dump(out/'report-receipt.json',{'head':rec['head'],'report_sha256':sha((out/'REPORT.md').read_bytes()),'artifacts':{p.name:sha(p.read_bytes()) for p in out.glob('*.json') if p.name not in ['prior-stages-seal.json','report-receipt.json']},'formal_score':None,'deployed':False});guard(out);print('STAGE3_REPORT_COMPLETE',len(lines))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);run(pathlib.Path(p.parse_args().out).resolve())
