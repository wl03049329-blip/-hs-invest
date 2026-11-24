'use strict';
const assert=require('assert/strict'),fs=require('fs');
const q=fs.readFileSync('.github/workflows/update-market-quotes.yml','utf8'),m=fs.readFileSync('.github/workflows/completed-market-watchdog.yml','utf8');
const start=q.indexOf('  official_quote_cache:'),cache=q.slice(start);
assert(start>0);
assert(!cache.includes('needs: intraday'),'official closes do not depend on intraday success');
assert(cache.includes('group: hs-live-intraday-slot-v4'),'shared files serialized with primary publisher');
assert(cache.includes('now.hour < 9 or (now.hour, now.minute) >= (13, 30)'),'actual runtime after close, not delayed cron label');
assert(q.includes('scripts.check_completed_market --final-expected-only'),'official calendar candidate after close, not raw historical18:00 gate');
const final=q.slice(q.indexOf('  eod:'),start);
assert(!final.includes('needs: intraday'),'FINAL independent of LIVE job completion');
assert(final.includes('group: hs-eod-core-history'),'shared exclusion with the standalone immutable FINAL writer');
assert(final.includes('FINAL_DATE_NOT_PUBLISHED'),'no success from an old local snapshot');
assert(final.includes('--verify-final --attempts 1'),'no-op Git cannot mask an unpublished FINAL');
assert(final.includes('gh workflow run hs-stable-pages.yml --ref main'),'FINAL publication independent of overall LIVE result');
assert(q.includes('timeout --signal=TERM 120s node scripts/finalize_core_score_history.js'));
assert(q.includes("grep -q 'FINALIZED_CORE_HISTORY_SOURCE_NOT_READY'"),'no fake success on source absence');
assert(cache.includes('gh workflow run hs-stable-pages.yml --ref main'));
assert(cache.includes('gh run watch "$found" --interval 5 --exit-status'));
assert(cache.includes('python -m scripts.verify_stable_pages'));
assert(!/gh workflow run.*(?:recovery|packaging)/i.test(q+m));
assert(m.includes('--repair')&&m.includes("if: github.ref == 'refs/heads/main'"));
assert(m.includes('--report "$RUNNER_TEMP/completed-market.json"'));
assert(!m.includes('--repair >'),'report file must not capture a child CLI URL');
const daily=fs.readFileSync('.github/workflows/update-radar-daily.yml','utf8'),terminal=daily.slice(daily.indexOf('  publication_audit:'),daily.indexOf('  update:'));
assert(daily.includes("run-name: HS daily close ${{ inputs.as_of || 'calendar-current' }}"));
for(const gate of ['needs: update',"if: always() && github.ref == 'refs/heads/main'",'actions: write','producer_result="$DAILY_RESULT"','gh workflow run completed-market-watchdog.yml'])assert(terminal.includes(gate));
assert(!terminal.includes('scripts.update_radar_daily')&&!terminal.includes('finalize_core_score_history'));
assert(m.includes('HS_COMPLETED_PRODUCER_RESULT: ${{ inputs.producer_result }}'));
assert(m.includes("if: steps.audit.outcome != 'success' && steps.incident.outputs.disposition != 'duplicate'"),'only a recognized duplicate may suppress a failure');
console.log('PASS 12 completed-market workflow / isolated publication / bounded source contracts');
const publication=q.slice(q.indexOf('  official_quote_publication:')),collector=q.slice(start,q.indexOf('  official_quote_publication:'));
assert(publication.includes('needs: official_quote_cache'));
assert(!publication.includes('needs: intraday')&&!publication.includes('needs: eod'));
assert(!publication.includes('hs-live-intraday-slot-v4'),'Pages waiting must never occupy the LIVE writer mutex');
assert(!collector.includes('gh run watch'),'source writer releases lock before Pages wait');
assert(publication.includes('ref: ${{ needs.official_quote_cache.outputs.quote_commit }}'),'attest the collected immutable checkout');
assert(publication.includes('--verify-quotes --attempts 1'),'no-op collection repairs unpublished quotes');
assert(!publication.includes("if: steps.quotes.outputs.changed == 'true'"),'changed=false cannot skip public attestation');
assert(collector.includes('for attempt in 1 2 3')&&collector.includes('test "$published" = true'),'bounded same-commit push retry still fails closed');
assert(!/continue-on-error: true/.test(publication+collector),'partial failure cannot be green');
console.log('PASS 9 quote-scope / no-op repair / short writer-lock / bounded push contracts');
const vm=require('node:vm');
const reportScript=m.split('          script: |')[1].split('\n      - uses:')[0];
const marker='<!-- hs-completed-market-v1 -->', mutations=[], notices=[], outputs=[];
let report, prior;
const env={
  require:()=>({readFileSync:()=>JSON.stringify(report)}),process:{env:{RUNNER_TEMP:'/fixture'}},
  context:{repo:{owner:'fixture',repo:'test'},runId:123},
  github:{paginate:async()=>prior?[prior]:[],
    rest:{issues:{listForRepo(){},create:async args=>{mutations.push(args);prior={number:44,user:{login:'github-actions[bot]'},body:args.body};},
      update:async args=>{mutations.push(args);if(args.state==='closed')prior=null;else prior.body=args.body;}}}},
  core:{notice:message=>notices.push(message),setOutput:(key,value)=>outputs.push([key,value]),summary:{addCodeBlock(){return this;},async write(){}}}
};
(async()=>{
  const run=()=>vm.runInNewContext('(async()=>{'+reportScript+'})()',env);
  report={healthy:null,deferred:true,waiting:'WAIT_DAILY_PUBLICATION',reasons:['DAILY_BARS_INCOMPLETE']};
  await run();assert.deepEqual(notices,['WAIT_DAILY_PUBLICATION']);assert.equal(mutations.length,0);
  report={healthy:false,reasons:['DAILY_BARS_INCOMPLETE'],daily_unverified:{'009815':{status:'STALE',reason:'Missing 2026-11-18'}}};
  await run();assert.match(mutations[0].body,/DAILY_BARS_INCOMPLETE/);assert.equal(outputs.length,0);
  report={...report,repair:['BOUNDED_COOLDOWN'],daily_unverified:{'009815':{status:'STALE',reason:'Missing 2026-11-19'}}};
  await run();assert.equal(mutations.length,1);assert.deepEqual(outputs,[['disposition','duplicate']]);
  report={...report,daily_unverified:{'009815':{status:'STALE',reason:'HTTP 522'}}};
  await run();assert.match(mutations[1].body,/HTTP 522/);assert.equal(mutations[1].issue_number,44);assert.equal(outputs.length,1);
  report={healthy:null,deferred:true,waiting:'WAIT_DAILY_PUBLICATION',reasons:['DAILY_BARS_INCOMPLETE']};
  await run();assert.equal(mutations.length,2);
  report={healthy:true,reasons:[]};
  await run();assert.equal(mutations[2].state,'closed');
  report={healthy:false,reasons:['OFFICIAL_CLOSE_NOT_CURRENT_TPEx']};
  await run();assert.match(mutations[3].body,/OFFICIAL_CLOSE_NOT_CURRENT_TPEx/);assert.equal(outputs.length,1);
  console.log('PASS watchdog waiting preserves alerts, incomplete reports, and verified recovery closes');
})().catch(e=>{console.error(e);process.exitCode=1;});
