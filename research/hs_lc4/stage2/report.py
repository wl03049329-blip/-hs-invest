"""Measured stage2 report, all candidates and failures, no leaderboard pick."""
import argparse,pathlib,subprocess,statistics
from common import *
def pct(x):return '—' if x is None else f'{100*x:.2f}%'
def num(x):return '—' if x is None else f'{x:.2f}'
def interval(x):return '—' if not x else pct(x[0])+'～'+pct(x[1])
NAMES={'NEXT_OPEN_FULL':'次日全額','HALF_THEN_DOWN5':'半額／續跌加碼','CONFIRM_HIGH5_FULL':'止跌確認才進場','QUARTER_THEN_CONFIRM5':'四分之一／確認加碼'}
def run(out):
    check(out);models=load(out/'all-models.json');pairs=load(out/'paired-comparisons.json');f=load(out/'forensic-summary.json');inc=load(out/'incident-set-audit.json');ev=load(out/'events.json');bench=load(out/'benchmarks.json');ctrl=load(out/'lagged-exposure-controls.json');op=load(out/'opportunity.json');receipt=load(out/'study-receipt.json');verify=load(out/'verification.json') if (out/'verification.json').exists() else None
    lines=['# HS 00631L L-C4 第二階段研究報告','', '**研究交付完成；A/B/C均不足以支持正式L-C4分數、權重或加碼級距。正式交易、實資與Shadow恢復全部未啟用。**','',
    f"分支 `research/hs-lc4-history-v1`；第一階段 `{BASE}`；本輪程式 `{receipt['head']}`。",
    '固定資料2014-10-31～2026-11-04，完整沿用第一階段官方修復副本、314份來源收據。第一階段程式、報告、原始資料與所有失敗證據逐檔SHA封存，沒有重新下載、覆寫或改寫正式研究。','',
    '## 一、資料可靠性：222日逐筆核對','',
    '逐日原始OHLC、FinMind對照、Yahoo、Frozen值、還原原價後差值、調整除數、來源收據SHA與判定，見 [222日JSON](discrepancies-222.json) 與 [逐日CSV](discrepancies-222.csv)。不是只抽查幾個日期。','',
    '|凍結檔與官方的殘餘差異（已統一分割基準）|日期數|','|---|---:|']
    for k,v in f['classifications'].items():lines.append(f'|{k}|{v}|')
    lines += ['',
    '- 182日多欄衝突、19日不合理平坦OHLC、7日一個價格刻度的收盤差異、14日較大收盤差異，共222日。沒有一日僅靠合法22:1換算或二進位浮點誤差即可消除。0.01元的一個刻度不是五位小數調整價最多約0.00011元的還原誤差。',
    '- 原始價與調整價本來有22倍差異：全序列另作原價/分割價基準分類，不把正常基準差異全判成壞資料。222日是Frozen調整值對官方調整值的重疊差異；不能僅用目前Yahoo在0.011元容差內通過，就宣稱Frozen相同。',
    f"- 凍結檔截至2026-08-27，在該覆蓋期間另缺{len(f['missing_frozen_sessions'])}個官方有成交的日期："+'、'.join(f['missing_frozen_sessions'])+'。這些是缺列，不混入222個重疊價格差異。',
    '- 目前Yahoo另有6個缺完整OHLC日期與11/04缺close/adjclose；詳見forensic-summary.json。來源原始列缺漏與官方停牌是不同類別。',
    '- 00631L官方22:1於2026-03-31恢復交易，3/25～3/30停牌；官方最後分割前收盤443.15、恢復參考20.14已核對。大部分衝突出現在2014～2017等非分割生效日，不能歸咎當日分割。研究副本只調整一次。',
    '- TWSE原始OHLC與FinMind逐筆一致；因此本研究採官方值並保留所有被拒舊值。供應商內部到底發生日期錯位、歷史覆寫或資料產生器錯誤，現有證據不足，不虛構內部根因，也不把222日全部標成同一種已修復bug。', '',
    '## 二、L7事故7／8：完整事件集合，而非改預期值','',
    f"- status快照列{inc['cached_status_count']}筆；canonical審核重讀完整有效鏈列{inc['canonical_count']}筆。差集只有最新一筆，無已解除事故被漏算。",
    f"- 新增ID：`{inc['newest']['record_id']}`；記錄hash `{inc['newest']['record_hash']}`；檢查時間 `{inc['newest']['checked_at']}`；目標日期2026-10-19，current_failure_reason為RECOVERY_EVIDENCE_AVAILABLE，但requires_integrity_review仍true。",
    '- 精確原因：`phase_l7_daily.py:operational_failure()`先用舊history建立unresolved及status.blocking_incidents，再append_record新增該筆，最後把預先組成的status寫出。`prepare_review()`重讀新增後的鏈，因此是8筆。最新fingerprint與歷史不同，不是可任意去重刪掉的事故。',
    '- 原測試test_real_review_preparation_is_read_only_and_never_approval把7寫死，混淆了新增前快照與新增後權威集合。第二階段新增獨立集合核對：須審核事故－具有合法恢復憑證的ID，逐一比對ID/hash/授權狀態；不把7改8，不刪測試、不製造approval。',
    '- 此為診斷清單落後一筆的產品問題，加上測試固定數量問題；目前FAIL_CLOSED沒有被繞過。後續如另獲維護授權，可在append完成後由canonical鏈產生診斷清單，將測試改為集合完整性及逐位元不變，保留外部審核憑證要求。本輪不改正式Shadow。','',
    '## 三、事前固定的實驗','',
    '- 事前登錄commit898c829；執行／統計補充於9c5d8f4及5252e09在第二階段績效運算前封存。4種進場×9種退出＝36組，不從第一階段162組事後挑一組當新分數。',
    '- 四種進場：C95觸發次日10%NAV；先5%續跌5%再5%；觸發後5日內收盤突破前5個實際最高價才次日投入10%；先2.5%再於10日內確認後投入最多7.5%。加碼不在第一個進場日收盤就觸發，至少再觀察一個完整持有日；至多兩批。',
    '- 退出：固定5/10/20/40/60交易日；淨停利20%／淨停損15%／最長40日；收盤高點回落10%／最長40日；持有10日仍未淨獲利退出／最長40日；淨損10%或既有MA200熊市且低於MA10／最長40日。',
    '- 全部只在收盤決策，下一實際交易日開盤加滑價成交；沒用未來最低/最高點或保證停損成交價。加碼與停損用已付成本及已實現部分減碼所得共同核對；退出優先於加碼。',
    '- 1,000萬元研究資金，新增風險10%NAV，費用雙邊各0.1425%、賣方稅0.1%、雙邊滑價0.1%；另0.25/0.5%滑價壓力，未投資現金0/1/2%收益假設。所有候選相同。',
    '- 相同風險規則：收盤超過10%則次日開盤減超額；跨夜與盤中仍可突破，報告最大曝險與超標日，不能說是永不突破的硬上限。所有買賣費用都計入部分減碼。',
    f"- 共{len(ev)}個共同C95事件，固定冷卻70個完整交易日（起點至少相隔71列），其中{sum(x['mature'] for x in ev)}個成熟、1個觀察未完成。所有候選使用同一事件ID與到期定義，沒等到確認的事件算零配置，不只拿成功進場者比較。",
    '- 固定冷卻是為避免5～60日比較的事件重疊，短期策略即使已出場也不能在同一急殺中重新入場；本研究沒有涵蓋同場崩跌多次再進場，這項限制會提高空手時間、減少樣本。',
    '- 2014～2017是初始訓練，各年C95只用之前年度資料。2018～2021、2022～2024、2025～2026為時間順序檢查，但第一階段已經看過，全部不能稱為全新獨立樣本外。並未再以全期勝負調參。',
    '- 使用分割調整後的可分割研究單位，不是可直接下單的整股/零股。真實開盤價存在不代表漲跌停排隊必能成交；日線不足驗證撮合、最小費用、容量與原始交易單位。因此結果是次開盤成交假設下的歷史研究，未取得實資可執行認證。','',
    '## 四、全部36組結果（2018～2026-11-04）','',
    '帳戶報酬與CAGR包含期末未平倉市價；交易統計不把未完倉算完成。最差單筆／中位數是該筆累計已投入資金報酬，不是全帳戶報酬。成熟共同比較一律14個事件，與各候選已完成交易數不同。','',
    '|進場／退出|帳戶報酬|CAGR|帳戶MDD|最差單筆|最差MAE|完成交易|成熟事件|單筆中位數|平均曝險|空手日%|Calmar|','|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    for k,r in models.items():
        m=r['metrics'];lines.append('|'+ '|'.join([k,pct(m['total_return']),pct(m['CAGR']),pct(m['max_drawdown']),pct(m['worst_trade']),pct(m['worst_MAE']),str(m['closed_trades']),str(m['mature_common_events']),pct(m['median_trade_return']),pct(m['average_exposure']),pct(m['flat_fraction']),num(m['calmar'])])+'|')
    lines += ['', '### 中位數與事件信賴區間','', 'CI為2000次年度區塊bootstrap；交易CI按交易觸發年分組；共同slot報酬以該事件前帳戶NAV的10%額度為分母，沒進場為0。年度區塊仍不保證市場獨立，少數年份會讓CI不穩，0中位數CI不代表零風險。','',
    '|策略|交易中位數95%CI|成熟共同slot平均|共同slot平均95%CI|共同slot中位數95%CI|區塊年數|','|---|---:|---:|---:|---:|---:|']
    for k,r in models.items():
        t=r['trade_uncertainty'];e=r['event_uncertainty'];lines.append(f"|{k}|{interval(t['median_CI95'])}|{pct(e['mean'])}|{interval(e['mean_CI95'])}|{interval(e['median_CI95'])}|{e['years']}|")
    lines += ['', '## 五、逐年與時間區塊穩定性','', '|策略|2018|2019|2020|2021|2022|2023|2024|2025|2026至11/04|','|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    for k,r in models.items():lines.append('|'+k+'|'+'|'.join(pct(r['metrics']['annual'].get(str(y))) for y in range(2018,2027))+'|')
    lines += ['', '每年最大回撤、進場交易數與平均曝險均存於all-models.json的annual_details。下表為三個歷史時間區塊，並非新獨立OOS。','', '|策略|2018-21 報酬／MDD／Calmar|2022-24 報酬／MDD／Calmar|2025-26 報酬／MDD／Calmar|','|---|---:|---:|---:|']
    for k,r in models.items():lines.append('|'+k+'|'+'|'.join(pct(b['return'])+'／'+pct(b['max_drawdown'])+'／'+num(b['calmar']) for b in r['metrics']['blocks'].values())+'|')
    lines += ['', '## 六、成本敏感性與資金閒置','', '|策略|滑價0.1%帳戶報酬|0.25%|0.5%|現金年息1%|2%|日曆空手時間|資金年效率|','|---|---:|---:|---:|---:|---:|---:|---:|']
    for k,r in models.items():lines.append('|'+ '|'.join([k,pct(r['metrics']['total_return']),*[pct(s['metrics']['total_return']) for s in r['cost_sensitivity']],*[pct(s['metrics']['total_return']) for s in r['cash_yield_sensitivity']],pct(r['metrics']['flat_calendar_fraction']),num(r['metrics']['capital_year_efficiency'])])+'|')
    lines += ['', '現金收益會主導長期空手的帳戶報酬，不能當成策略alpha。基準全現金年息0/1/2%假設與第一階段一致；股息、活期利率及投資人稅務不能視為保證收益。','',
    '## 七、長抱與曝險對照','',
    '100%及初始10%B&H僅背景對照，允許市值漂移，不能假稱與戰術策略全期同曝險。每日10%控制與候選採相同費率；另為每個候選建立「嚴格前一日已知曝險」的次開盤控制，不用事後全期平均曝險來下單。控制存在一日延遲及商品停牌日差異，不是完美同期匹配，也不是另選的alpha模型。0050股利採官方值且不再投資；動態控制將股利列鎖定應收，不當提前可用現金。','',
    '|基準|報酬|CAGR|MDD|平均曝險|最大收盤曝險|','|---|---:|---:|---:|---:|---:|']
    for s,bs in bench.items():
        for k,m in bs.items():lines.append('|'+ '|'.join([s+' '+k,pct(m['total_return']),pct(m['CAGR']),pct(m['max_drawdown']),pct(m['average_exposure']),pct(m.get('max_exposure'))])+'|')
    lines += ['', '|候選|自身CAGR／MDD|同軌00631L控制CAGR／MDD|同軌0050控制CAGR／MDD|自身最大曝險／超標日|','|---|---:|---:|---:|---:|']
    for k,r in models.items():
        m=r['metrics'];a=ctrl[k]['00631L'];b=ctrl[k]['0050'];lines.append(f"|{k}|{pct(m['CAGR'])}／{pct(m['max_drawdown'])}|{pct(a['CAGR'])}／{pct(a['max_drawdown'])}|{pct(b['CAGR'])}／{pct(b['max_drawdown'])}|{pct(m['max_exposure'])}／{m['over_cap_sessions']}|")
    lines += ['', '這些內生曝險路徑控制只能協助區分持有曝險與標的效果，不能提供新的獨立顯著性證明。完整控制年度與費用結果見lagged-exposure-controls.json。', '',
    '## 八、進場、分批、退出的配對分析','',
    '固定27項進場對比（同退出對立即全額），32項退出對比（同進場對TIME20）。差異以共用成熟事件的slot報酬計算，精確年度區塊符號翻轉p值，再各自Holm校正；前提為年度差異可符號交換且近似對稱，這在少數相依市場年份未必成立，不能把p值當正式認證。第一階段162次與跨階段嘗試的資料探勘風險仍存在，這裡的家族校正沒有抹掉它。','',
    '|比較|參考|事件差異平均|95%CI|原始p|Holm p|','|---|---|---:|---:|---:|']
    for family in ['entry_family','exit_family']:
        for x in pairs[family]:lines.append(f"|{x['model']}|{x['reference']}|{pct(x['paired']['mean'])}|{interval(x['paired']['mean_CI95'])}|{x['p_raw']:.4f}|{x['p_holm']:.4f}|")
    lines += ['', '風險機制另以RISK對TIME40作相同最長期間的描述配對，見paired-comparisons.json的risk_same_horizon；不能把最長持有期不同所造成的回撤變化，全歸因於風控。', '',
    '## 九、失敗事件與尾部風險','', '|策略|觸發|進場|退出|原因|持有日|單筆淨報酬|MAE|批數|','|---|---|---|---|---|---:|---:|---:|---:|']
    failures=[]
    for k,r in models.items():
        for t in r['worst_events']:failures.append((k,t))
    for k,t in sorted(failures,key=lambda x:x[1]['net_return'])[:20]:lines.append(f"|{k}|{t['trigger']}|{t['entry_date']}|{t['exit_date']}|{t['reason']}|{t['held']}|{pct(t['net_return'])}|{pct(t['mae'])}|{t['tranches']}|")
    lines += ['', '所有候選的前三差交易及最差MAE均保存在all-models.json；不是只列獲利交易。移動/停損是收盤判斷後次開盤，跳空與價差可令損失超過門檻。下表列共同事件清單，避免把同一重大急殺的36種策略當成36個獨立事件。','', '|事件|市況|成熟|C95急跌速度|20日收盤回撤|','|---|---|---:|---:|']
    for e in ev:lines.append(f"|{e['date']}|{e['regime']}|{'是' if e['mature'] else '未完成，排除配對CI'}|{e['velocity']:.4f}|{e['dd20']:.4f}%|")
    lines += ['', '## 十、L-C4可行性 A／B／C','',
    '### A. 超跌機會分數','',
    f"共同C95成熟事件{op['n']}個；急跌歷史分位與20日結果的Spearman關聯{num(op['velocity_rank_association'])}，回撤深度關聯{num(op['drawdown_rank_association'])}。這不是經校準的0～100機率分數。", '',
    '|先前訓練因素|條件|事件|slot平均|平均95%CI|中位數|','|---|---|---:|---:|---:|---:|']
    for k,bs in op['bins'].items():
        for flag,x in bs.items():lines.append(f"|{k}|{flag}|{x['n']}|{pct(x['mean'])}|{interval(x['mean_CI95'])}|{pct(x['median'])}|")
    a90=load(out/'a90-robustness.json');lines += ['',
    f"A90單一預先指定敏感性檢查：{a90['uncertainty']['n']}個成熟事件，平均slot報酬{pct(a90['uncertainty']['mean'])}，95%CI {interval(a90['uncertainty']['mean_CI95'])}；未另跑36組A90搜尋。",
    '- C95事件的deep20全為真，無對照組，無法辨識深跌因素的增量效果。極端97.5%分位僅5件，區間與其他組重疊，中位數不呈可靠單調。A不足以支持因素權重或正式機會分數。', '',
    '### B. 止跌與風險條件','',
    '- 五日突破前高再全額進場的TIME20僅2筆完成交易；少交易/少曝險不等於已證明止跌有效。先小額再確認亦未形成穩定的配對改善，不能推廣成所有止跌條件無效。',
    '- 風控可降低部分情境回撤，但有持有期與資金使用率差異；停損並不保證損失停在設定值。必須同時看帳戶MDD、單筆尾損、共同slot、相同最長持有期配對及費用。B尚無可靠的正式優勢證據。', '',
    '### C. 分批與退出','',
    '- 20日例：次日全額帳戶報酬3.42%、MDD−4.26%；下跌分批3.61%、MDD−2.67%，但最差單筆由−18.19%變為−19.36%。降低投入曝險可降低帳戶回撤，不代表單筆風險或統計優勢改善。',
    '- 27進場及32退出比較的Holm校正p全部為1；單一族群的正向bootstrap CI不能脫離共同配對、多重比較、有限年份及跨階段選模背景，升格為顯著買點。',
    '- 所有歷史區間早已在第一階段檢視，沒有新的真正獨立樣本外。C不能判定為「已在新OOS改善風險調整報酬」。', '',
    '### 決策','',
    '**保留研究，正式L-C4分數／因素權重／加碼級距：NO-GO。** 不自動挑CAGR最高者。可保留立即進場與續跌分批的固定20日作未來並行對照，但不是實際買進推薦；先小額後確認等機制不因本次樣本少就永久否定。',
    '下一步（僅建議，不啟動）：先由另外授權的維護處理L7診斷集合與事故審核；研究則登錄少數固定對照，等待真正未見的新事件及不同熊市/轉折，再驗證交易單位、撮合限制和實際費率。不要再用同一歷史大規模掃參數來湊正式分數。','',
    '## 十一、安全、測試與封存','']
    if verify:
        for k,v in verify['tests'].items():lines.append(f"- {k}: "+(f"{v['pass']} PASS / {v['fail']} FAIL / {v['skip']} SKIP" if 'total' in v else f"exit_code={v['exit_code']}"))
        lines += [f"- Protected {verify['protected']}/20；Provenance {verify['provenance']}/7；三條Hash Chain PASS。",'- 36組現金與PnL守恆、年度報酬複合、至多兩批、無同日訊號成交、無重複事件交易均已實測核對。']
    else:lines.append('- 最終固定版本安全回歸仍待完成，不以暫存報告冒稱PASS。')
    lines += ['- 第一階段所有程式／證據逐位元不變；Frozen V1、正式Shadow、原C4、Ledger、PWA、使用者資料及原dirty main不變。Writer OFF，沒有Push、PR、部署、自動交易或實資。',
    '- 舊L7唯一失敗繼續保留；沒有把FAIL改SKIP、沒有改預期7為8。正式Shadow仍FAIL_CLOSED，本輪不宣稱已解除。', '',
    '## 十二、來源與重現','',
    '- [00631L官方分割時程、比例與參考價](https://www.twse.com.tw/zh/ETFortune/announcement?company=A00005&date=20260330&fund=00631L&seq=1&type=all)',
    '- 第一階段source-manifest.json、dataset-manifest.json及其SHA固定於study-receipt.json；全部官方月報、除權息表與次級來源原始收據沿用，不覆寫。',
    '- 本輪資料稽核：forensic-summary.json、discrepancies-222.json/csv、incident-set-audit.json；策略全紀錄：all-runs.json、all-models.json；統計：paired-comparisons.json、opportunity.json；實測：verification.json及test-*.log。', '',
    '```text','python research/hs_lc4/stage2/forensics.py --out ../hs-lc4-stage2-evidence','python research/hs_lc4/stage2/study.py --out ../hs-lc4-stage2-evidence','python research/hs_lc4/stage2/verify.py --out ../hs-lc4-stage2-evidence','python research/hs_lc4/stage2/report.py --out ../hs-lc4-stage2-evidence','```','',
    '本報告不包含真實使用者持股、資產或券商秘密。1,000萬元只是假設研究資金。']
    (out/'REPORT.md').write_text('\n'.join(lines)+'\n',encoding='utf8');dump(out/'report-receipt.json',{'head':receipt['head'],'report_sha256':sha((out/'REPORT.md').read_bytes()),'artifact_hashes':{p.name:sha(p.read_bytes()) for p in out.glob('*.json') if p.name not in ['stage1-seal.json','report-receipt.json']},'decision':'RESEARCH_ONLY_NO_FORMAL_LC4','phase1_preserved':True});check(out);print('REPORT_GENERATED',len(lines),'lines')
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);run(pathlib.Path(p.parse_args().out).resolve())
