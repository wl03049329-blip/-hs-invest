"""Generate public-data-only research tables from measured artifacts, never scores."""
import argparse,json,pathlib,statistics,random,subprocess
from datetime import date
from capture import ROOT,sha,dump,seal
from engine import features,thresholds,signals,candidates,avg,quantile,simulate
def pct(x):return '—' if x is None else f'{100*x:.2f}%'
def n(x):return '—' if x is None else f'{x:.2f}'
def load(out,name):return json.loads((out/name).read_text(encoding='utf8'))
def metricrow(name,m):return '|'+ '|'.join([name,pct(m['total_return']),pct(m['CAGR']),pct(m['max_drawdown']),str(m['closed_trades']),pct(m['win_rate']),pct(m['worst_MAE']),n(m['mean_holding_sessions']),pct(m['average_exposure']),n(m['capital_year_efficiency'])])+'|'
def tableheader():return ['|方法|累積報酬|CAGR|收盤最大回撤|完成交易|勝率|交易最差低點MAE|平均持有日|平均曝險|資金年效率|','|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
def event_study(panel):
    th=thresholds(panel);m=next(x for x in candidates() if x['id']=='A90|NEXT_OPEN|NONE|TIME20');sg=signals(panel,th,m);events=[];last_exit=-1
    for i,x in enumerate(panel):
        if not sg[i] or i<=last_exit or i+21>=len(panel):continue
        en=panel[i+1]['open'];ex=panel[i+21]['open'];ret=ex*(1-.001)*(1-.001425-.001)/(en*(1+.001)*(1+.001425))-1
        events.append({'signal':x['date'],'return':ret,'regime':x['regime'],'extreme95':x['velocity']>=th[int(x['date'][:4])]['C95'],'deep20':x['dd20']<=th[int(x['date'][:4])]['deep']});last_exit=i+21
    bins={}
    for key in ['extreme95','deep20']:
        bins[key]={str(flag):{'n':len(xs:=[x['return'] for x in events if x[key]==flag]),'mean':avg(xs),'median':statistics.median(xs) if xs else None,'win_rate':avg([int(x>0) for x in xs])} for flag in [False,True]}
    return {'events':events,'bins':bins,'warning':'A90 nonoverlapping20-session event screen, annual past-only thresholds; historical selected sample, not new OOS or proof of score calibration.'}
def year_bootstrap(trades):
    groups={y:[t['net_return'] for t in trades if t['trigger'][:4]==y] for y in sorted({t['trigger'][:4] for t in trades})};years=list(groups);rng=random.Random(631);means=[]
    for _ in range(2000):
        sample=[x for y in rng.choices(years,k=len(years)) for x in groups[y]]
        if sample:means.append(avg(sample))
    return {'years':len(years),'mean_CI95':[quantile(means,.025),quantile(means,.975)],'warning':'Year-block descriptive uncertainty only; few dependent regimes, already selected history.'}
def run(out):
    seal(out);s=load(out,'summary.json');a=load(out,'data-audit.json');grid=load(out,'all-models.json');diag=load(out,'selected-diagnostics.json');wf=load(out,'walk-forward.json');manifest=load(out,'source-manifest.json');panel=features(load(out,'adjusted-00631L.json')['rows']);ev=event_study(panel);dump(out/'factor-diagnostics.json',ev);yb=year_bootstrap(wf['trades']);dump(out/'year-block-uncertainty.json',yb)
    lines=['# HS 00631L L-C4 歷史戰術研究 V1','', '**研究資料重建完成；歷史比較完成。正式 L-C4 分數／實資／正式 Shadow 恢復：NO-GO。**','',
    '研究分支 `research/hs-lc4-history-v1`，基準 main `7cb3a015e565222d95cdc42ec8eac100951f6cbe`。只新增 research/hs_lc4；原正式程式、凍結研究、三鏈與金融資料不改寫。',
    '資料截點2026-11-04；擷取開始2026-11-05 00:07台北時間。下列不是今日買點，也不是投資報酬保證。','',
    '## 1. 資料稽核與10/13後故障','',
    f'- 已逐月擷取兩商品共292份官方成交日線及13份年度官方除權息日曆；所有{len(manifest)}份原始JSON均有URL、取得UTC、長度與SHA收據。HTTP308失敗紀錄保留；最終292/292月份成功，不以失敗退出碼充當完整來源。',
    f"- 00631L：{a['symbols']['00631L']['official_rows']}筆，2014-10-31～2026-11-04；0050：{a['symbols']['0050']['official_rows']}筆同期間。每筆官方OHLC與FinMind交叉一致；分割停牌是合法無成交區間，不填人工價格。",
    '- 00631L官方22:1，2026-03-31恢復交易；此前價格除22一次，不再重複調整。0050官方4:1，2025-06-18恢復交易；此前價格除4一次。以官方分割前收盤與分割參考價再次核對。',
    '- 00631L：Yahoo與官方有222個歷史日期差異，另7個日期不完整，包括11/04 close/adjclose缺值；原凍結研究對應222日也不同。TWSE＋FinMind一致時只修復新研究副本，完整列出被拒vendor值，絕不重算舊研究或覆寫其結果。',
    '- 0050：Yahoo另有缺欄位及5筆OHLC差異，且多一筆2022-08-02未獲官方確認的配息。拒絕使用該供應商調整因子；改用TWSE逐年除權息表與FinMind逐筆相符的23筆事件（其中一筆早於研究起日）。買入持有的股息留現金，不虛構再投資。',
    '- 原Shadow第一層：歷史已發布資料後來在主要供應商出現缺口，bridge禁止事後以新來源冒認原有橋接權威，觸發 `BRIDGE_HISTORICAL_GAP_REVIEW_REQUIRED:2026-10-13`，完整性審核仍PENDING。現在來源重新齊全不等於可抹掉事故。',
    '- 第二層：11/04 GitHub Run41860366624的前置安全測試212項中211通過、1失敗：`test_real_review_preparation_is_read_only_and_never_approval` 期待7筆事故但實際8筆，daily job因此SKIPPED，根本未進入當次資料生產。不是把Workflow FAILURE說成Yahoo當天一定失敗。',
    '- 既有exact recovery只授權2026-10-16、anchor10/13與6小時新鮮證據，現在不可套用。研究資料已補齊，不代表原正式Shadow復原；須另行逐事故審核、更新精確恢復範圍與外部授權。未修改或放寬舊安全測試。','',
    '## 2. 實驗、成本與防洩漏','',
    '- 已登錄162組：A90/C95/C95＋深跌20；次日開盤/延遲3個完整交易日/5日內突破前5日高；單筆/半筆後跌5%加碼/半筆後突破確認加碼；6種退出（20日、40日、-10/+20/40、-15/+30/60、10%移動/40、MA10/40）。',
    '- 初始資金1,000萬元，每次新部位最多NAV10%，分批各5%，至多2批，單一episode不可重設持有時計。買賣佣金各0.1425%、賣方ETF稅0.1%、每邊滑價0.1%；另壓力0.25/0.5%，閒置現金年息0/1/2%。均為研究假設，非使用者券商已核准費率。',
    '- 每個條件收盤才知道，最早下一個實際交易日開盤成交；停損/停利/移動退出同樣次日開盤，跳空可以超過停損設定。日內high/low只作MAE/MFE診斷，從未拿最低/最高作可成交價。',
    '- 使用分割調整後的「可分割研究單位」，不是可直接下單的原始股數。尚未驗證整張/零股撮合、歷史最小手續費、漲跌停排隊、滑價容量與個人股利稅。基金內扣費用已在價格中，不再次扣一次。',
    '- 10%是新增資金/名義曝險上限，不是無法跳空突破的連續硬保證；上漲及跨夜會造成被動漂移，逐日揭露。B&H10%是同初始投入，不是全期相同風險。100%B&H僅情境基準，不當作同風險策略優劣判決。',
    '- 各年門檻只用先前年份正向crash velocity分位數；2014-2017訓練。年度選模只用2018起已完成的歷史walk-forward交易，前年末70個交易日前即停止新訓練訊號，至少5筆成熟交易，否則持現金。跨年持倉沿用進場時的原退出規則。',
    '- L2～L7已看過歷史與重要極端事件，本研究明確標記「歷史選模後時間序列再分析」，不宣稱全新獨立樣本外。162次比較具有資料探勘風險；事後第一名不可升格正式模型。期末未完成持倉只按市價列帳，不放入完成勝率。','',
    '## 3. 2018～2026-11-04 主比較','']+tableheader()
    lines += [metricrow('年度先前資料選模WF',s['walk_forward']),metricrow('固定C95/次日/單筆/20日',s['fixed_reference']),metricrow('事後最高CAGR（非推薦）',s['hindsight_best']['metrics'])]
    for symbol,bs in s['benchmarks'].items():
        for alloc in ['0.1','1']:lines.append(metricrow(f'{symbol} B&H 初始{float(alloc)*100:.0f}%',bs[alloc]))
    lines += [metricrow('全現金0%',s['benchmarks']['00631L']['0']),'',
    '- 策略報酬為全帳戶NAV，交易MAE則為該筆已投入資金的最差低價淨值損失，不能把兩者混為一談。資金年效率＝淨帳戶獲利/市值曝險積分資金年，不等於無風險可放大的年報酬；含利息情境須另看對全現金超額。',
    '- 0050含官方現金分配並留現金（不再投資），不扣投資人個別股息稅；除息日僅估值應收，不宣稱當天現金已入帳可下單。默认0%現金收益下不產生提前入息利息。B&H最終市值另扣一次出場成本，策略未完倉仍為未實現市價估值，不能將微小差額當alpha。','',
    '### 全上市期間2014-10-31起','']+tableheader()
    lines.append(metricrow('WF（2014-17及無足夠選模樣本年持現金）',s['full_period']['walk_forward']))
    for symbol,bs in s['full_period']['benchmarks'].items():
        for alloc in ['0.1','1']:lines.append(metricrow(f'{symbol} B&H 初始{float(alloc)*100:.0f}%',bs[alloc]))
    lines += ['', '## 4. 年度選模（不是事後挑全期第一）','', '|測試年|先前訓練結束|最後容許訓練訊號|合格候選|選用|','|---|---|---|---:|---|']
    for x in s['choices']:lines.append(f"|{x['year']}|{x['train_end']}|{x['last_signal_date']}|{x['candidates_eligible']}|{x['selected'] or '現金：成熟樣本不足'}|")
    lines += ['', '## 5. 分批、首次進場與退出的敏感性','', '下表是各參數族群內54/81/27組候選的全期描述中位數，不是新增獨立樣本，也不以中位數再選模。','', '|維度|設定|組數|CAGR中位數|回撤中位數|最差交易MAE中位數|','|---|---|---:|---:|---:|---:|']
    for i,label in [(0,'急殺條件'),(1,'首次進場'),(2,'加碼'),(3,'退出')]:
        for v in sorted({k.split('|')[i] for k in grid}):
            ms=[m for k,m in grid.items() if k.split('|')[i]==v];lines.append('|'+ '|'.join([label,v,str(len(ms)),pct(statistics.median(m['CAGR'] for m in ms)),pct(statistics.median(m['max_drawdown'] for m in ms)),pct(statistics.median(m['worst_MAE'] for m in ms if m['worst_MAE'] is not None))])+'|')
    lines += ['', '## 6. 候選、失敗事件與可靠性','',
    '- 推薦保留「研究候選」：年度WF於2026年依2025年底前資料選出的 C95_AND_DEEP20 / DELAY_3 / HALF_THEN_DOWN5 / TIME20；另保留不加碼的 C95 / NEXT_OPEN / NONE / TIME20 作透明對照。這不是推薦實際買進，尤其向下加碼不可只因全期中位數較好就啟用。',
    f"- 事後最高CAGR為 `{s['hindsight_best']['id']}`，但它只是診斷候選；單筆最差MAE達{pct(s['hindsight_best']['metrics']['worst_MAE'])}。高報酬排名無法消除崩跌風險。",
    f"- WF僅{s['walk_forward']['closed_trades']}筆完成交易，episode bootstrap平均單筆報酬95%區間{pct(diag['nested_walk_forward']['bootstrap']['mean_CI95'][0])}～{pct(diag['nested_walk_forward']['bootstrap']['mean_CI95'][1])}；年度區塊區間{pct(yb['mean_CI95'][0])}～{pct(yb['mean_CI95'][1])}（僅{yb['years']}個有交易年份）。這些區間未消除選模偏誤，且不足支持正式校準。",
    f"- WF收盤最大曝險{pct(s['walk_forward']['max_close_exposure'])}，超過10%漂移{s['walk_forward']['cap_breach_sessions']}個交易日。不能宣稱具有無條件10%硬上限。",
    f"- 移除WF最大3筆交易的既有損益後，剩餘交易損益/初始資金為{pct(diag['nested_walk_forward']['leave_best_3_trade_pnl_out'])}。這是固定PnL歸因，非重新計算未來部位大小的可交易反事實。", '',
    '|WF市場狀態|交易數|平均單筆淨報酬|最差MAE|','|---|---:|---:|---:|']
    for k,v in diag['nested_walk_forward']['regimes'].items():lines.append(f"|{k}|{v['n']}|{pct(v['mean'])}|{pct(v['worst_MAE'])}|")
    lines += ['', '### 重大失敗交易（WF與事後第一名）','', '|來源|訊號|進場|退出|原因|持有日|單筆淨報酬|MAE|批數|','|---|---|---|---|---|---:|---:|---:|---:|']
    for label,k in [('WF','nested_walk_forward'),('事後第一','hindsight_best_NOT_A_RECOMMENDATION')]:
        for t in sorted(diag[k]['trades'],key=lambda x:x['mae'])[:5]:lines.append(f"|{label}|{t['trigger']}|{t['entry_date']}|{t['exit_date']}|{t['exit_reason']}|{t['held']}|{pct(t['net_return'])}|{pct(t['mae'])}|{t['tranches']}|")
    lines += ['', '### 極端年份剔除與成本/現金敏感性','', '剔除該年觸發的新episode，保持原年度選模不變；不是新的樣本外或重新訓練結果。','', '|不進場年份|帳戶報酬|MDD|完成交易|','|---|---:|---:|---:|']
    for y,m in s['leave_crisis_year_out'].items():lines.append(f"|{y}|{pct(m['total_return'])}|{pct(m['max_drawdown'])}|{m['closed_trades']}|")
    lines += ['', '|每邊滑價|閒置現金假設年息|WF報酬|CAGR|對全現金超額|','|---:|---:|---:|---:|---:|']
    for x in s['stress']:lines.append(f"|{pct(x['slippage'])}|{pct(x['cash_yield'])}|{pct(x['metrics']['total_return'])}|{pct(x['metrics']['CAGR'])}|{pct(x['metrics']['excess_return_over_all_cash'])}|")
    lines += ['', '## 7. L-C4判讀方式與分數決策','',
    '- 機會程度：只讀取當年以前訓練的急跌velocity分位與20日回撤位置，不將急跌直接解讀為買點。',
    '- 止跌確認：獨立顯示是否在觸發後5日內收盤突破前5日高，確認後也只能次日開盤進場；沒有確認可過期，不補買。',
    '- 風險狀態：MA200/斜率市場分群、歷史低點MAE、跳空風險、已有曝險與資料完整性；不足則研究訊號不可用，不以機會高分抵銷風險。',
    '- 退出條件：進場前選定時間、收盤停損/停利/移動/MA規則，不事後找最高點；風險退出優先於加碼。',
    '- **不發布因素正式權重、不校準0～100正式分數、不給正式加碼級距。** 樣本少、均值區間跨0、熊市/轉折樣本不足、歷史已被選模、vendor舊研究資料有差異；即使162組事後有贏家也不構成驗證。',
    '- 下表僅把A90首次訊號做20日不重疊事件篩選，測試條件是否有單調線索；不將重疊的162套交易相加當成獨立樣本。','', '|機會因素|條件|事件數|平均20日淨報酬|中位數|勝率|','|---|---|---:|---:|---:|---:|']
    for k,b in ev['bins'].items():
        for flag,v in b.items():lines.append(f"|{k}|{flag}|{v['n']}|{pct(v['mean'])}|{pct(v['median'])}|{pct(v['win_rate'])}|")
    lines += ['', '## 8. 全部162候選（完整公開，禁止只報贏家）','']+tableheader()
    for k,m in sorted(grid.items()):lines.append(metricrow(k,m))
    lines += ['', '## 9. 驗證、限制與下一步','',
    '- 新增研究機制44項PASS，包含前5日最高價而非最高收盤的RED→GREEN修正；既有L7安全回歸211PASS/1FAIL/0SKIP（事故數硬編碼7，實際8，與遠端相同），沒有將FAIL改SKIP、沒有修改舊斷言。Protected20/20、Provenance7/7、三鏈PASS；正式Writer及實資配置維持OFF/0。',
    '- 原dirty main與既有工作樹以既有逐位元封印核對通過；新研究前後所有舊research/hs_leverage檔案SHA一致。沒有讀取/輸出個人真實持股資料，沒有操作PR、Push、Merge、正式Workflow或Deploy。',
    '- 原Shadow恢復仍BLOCKED；正式模型/分數仍NO-GO。本輪已完成可重現歷史比較，不授權回填舊Forward觀察或把已看過的2024/2025當全新OOS。',
    '- 後續如授權：先針對8筆事故及最新完整來源另作精確恢復審核（含原硬編碼測試的等價修復），再以新研究協定登錄後的真正前瞻資料驗證候選，完成實際交易單位/成本/流動性與曝險控制。此處不啟動下一階段。','',
    '## 10. 官方來源與可重現命令','',
    '- [00631L基本資料與上市日](https://www.yuantaetf.com/product/detail/00631L/Basic_information)',
    '- [00631L官方22:1分割公告](https://www.twse.com.tw/zh/ETFortune/announcement?company=A00005&date=20260330&fund=00631L&seq=1&type=all)',
    '- [0050官方4:1分割公告](https://www.twse.com.tw/zh/ETFortune/announcement?company=A00005&date=20250617&fund=0050&seq=1&type=other)',
    '- [TWSE交易規則及ETF稅費](https://www.twse.com.tw/zh/products/securities/etf/overview/rules.html)',
    '- [Shadow故障Run41860366624](https://github.com/wl03049329-blip/-hs-invest/actions/runs/41860366624)',
    '- 各官方月行情及除權息日曆精確URL/取得時間/長度/SHA見source-manifest.json與receipts/；官方資料非私人持股。', '',
    '```text', 'python research/hs_lc4/audit.py --out ../hs-lc4-evidence', 'python -m unittest discover -s research/hs_lc4 -p test_engine.py', 'python research/hs_lc4/engine.py --out ../hs-lc4-evidence', 'python research/hs_lc4/report.py --out ../hs-lc4-evidence','```','',
    '原始資料不會在重跑研究時被自動重新下載；audit確認每個收據SHA後才計算。完整訂單、逐日NAV、各年選模與未完成部位見walk-forward.json、selected-diagnostics.json；所有候選摘要見all-models.json。']
    (out/'REPORT.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
    dump(out/'report-receipt.json',{'report_sha256':sha((out/'REPORT.md').read_bytes()),'files':{name:sha((out/name).read_bytes()) for name in ['summary.json','data-audit.json','dataset-manifest.json','source-manifest.json','walk-forward.json','all-models.json','selected-diagnostics.json','factor-diagnostics.json']},'scope':'RESEARCH_ONLY_NO_FORMAL_SCORE_NO_RECOVERY','source_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()});seal(out);print('REPORT_COMPLETE',len(lines),'lines')
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);run(pathlib.Path(p.parse_args().out).resolve())
