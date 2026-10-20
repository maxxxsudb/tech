const assert = require('node:assert/strict');
const q = require('../plugin/query-tools');
const a = require('../plugin/alerting');
const fs = require('node:fs');

module.exports = async ({ page, api, uid, folderUid, from, to, check }) => {
  const datasource = { uid, type: 'grafana-postgresql-datasource' };
  const statements = ['SELECT customer_id+1 AS grouped FROM orders GROUP BY (customer_id+1)', 'SELECT amount FROM orders ORDER BY (amount)', 'SELECT row_number() OVER (PARTITION BY (service) ORDER BY created_at) AS n FROM orders', "SELECT CASE (service) WHEN 'api' THEN 1 ELSE 0 END AS n FROM orders", "SELECT service FROM orders WHERE service ILIKE ('%api%')", 'SELECT amount FROM orders WHERE amount BETWEEN (1) AND (2000)', "SELECT service FROM orders WHERE service LIKE ('api%')"];
  for (const sql of statements) {
    const response = await api('/api/ds/query', 'POST', { from: String(from), to: String(to), queries: [{ refId: 'A', datasource, format: 'table', rawQuery: true, ...q.boundedSql(sql) }] });
    assert.ok(!response.results.A.error, JSON.stringify(response)); assert.ok(response.results.A.frames?.length);
  }
  check('Seven parenthesized SQL forms pass validator and execute on actual PostgreSQL');
  for (const operator of ['gt', 'gte', 'lt', 'lte']) {
    const rule = a.buildRule({ uid: 'threshold-review', title: 'Review', folderUID: folderUid, ruleGroup: 'Review', intervalSeconds: 60, lookbackSeconds: 300, for: '0s', threshold: 50, reducer: 'max', operator, source: { datasource, rawSql: 'SELECT $__timeTo()::timestamptz AS time, 50.0::double precision AS value' } }, q.boundedSql);
    const request = (path, options) => api(path, options?.method || 'GET', options?.body);
    const preview = await a.previewRule(request, rule, { at: to });
    assert.equal(preview.status, 'ok', JSON.stringify(preview));
    assert.equal(preview.samples[0].value,50); assert.equal(preview.samples[0].condition,['gte','lte'].includes(operator));
    // Preserve a moving window in SQL to exercise the actual replay planner and backend parity check.
    rule.data[0].model.rawSql += ' FROM orders WHERE $__timeFilter(created_at) LIMIT 1';
    const plan = a.planReplay(rule,60,to-120000,to), replay = await a.replayRule(request,rule,plan);
    assert.equal(replay.complete,true); assert.equal(replay.errors,0); assert.equal(replay.statistics.firingEpisodes,['gte','lte'].includes(operator)?1:0);
  }
  check('Actual Grafana SQL eval and rolling replay agree at equality for gt/gte/lt/lte');
  await page.emulateTimezone('Europe/Moscow');
  await page.evaluate(async ({uid,from,to}) => {
    const plugin=await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/module.js');
    const React=await System.import('react'), dom=await System.import('react-dom/client');
    const response=await fetch('/crf/dashboard/api/dashboards/uid/'+uid).then(r=>r.json());
    const context={dashboardUid:uid,panels:response.dashboard.panels,timeRange:{from,to},variables:{}};
    const settings={...plugin.__test.defaults,allowedDatasourceUids:uid};
    const wrapper=document.createElement('div');wrapper.id='tech-ai-assistant-drawer';document.body.appendChild(wrapper);
    const host=document.createElement('div');host.id='review-ui';host.style.cssText='position:fixed;inset:20px;z-index:2147483002;overflow:auto;background:#181b1f;color:white;padding:12px';wrapper.appendChild(host);
    window.reviewRoot=dom.createRoot(host);window.reviewRepairs=[];window.reviewApplies=[];
    const code='SELECT missing_review_column FROM orders';
    window.reviewRoot.render(React.createElement(plugin.__features.CodeBlock,{context,settings,selectedPanelIds:[1],lang:'sql',code,onApply:value=>window.reviewApplies.push(value),onRepair:value=>window.reviewRepairs.push(value)}));
  },{uid,from,to});
  await page.waitForSelector('#review-ui [data-testid="tech-ai-try-panel"]');
  await page.click('#review-ui [data-testid="tech-ai-try-panel"]');
  assert.equal(await page.$eval('#review-ui [data-testid="tech-ai-apply-proposal"]', n=>n.disabled),true);
  await page.click('#review-ui [data-testid="tech-ai-validate-proposal"]');
  await page.waitForSelector('#review-ui [data-testid="tech-ai-repair-proposal"]');
  await page.click('#review-ui [data-testid="tech-ai-repair-proposal"]');
  const repair=await page.evaluate(()=>window.reviewRepairs[0]);
  assert.match(repair.details[0].error,/missing_review_column/); assert.match(repair.details[0].query.rawSql,/missing_review_column/);
  assert.deepEqual(await page.evaluate(()=>window.reviewApplies),[]);
  check('SQL code block opens local proposal; real datasource error and tested SQL reach repair without any save');
  await page.evaluate(async()=>{
    const plugin=await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/module.js'),React=await System.import('react');
    const lines=Array.from({length:60},(_,i)=>({type:i===30?'add':'equal',text:'SQL line '+i}));
    window.reviewRoot.render(React.createElement(plugin.__features.QueryDiff,{lines}));
  });
  await page.waitForSelector('#review-ui [data-testid="tech-ai-diff-fold"]');
  assert.ok((await page.$$('#review-ui [data-testid="tech-ai-diff-fold"]')).length>=2);
  await page.click('#review-ui [data-testid="tech-ai-diff-fold"] summary');
  assert.equal(await page.$eval('#review-ui [data-testid="tech-ai-diff-fold"]', n=>n.open),true);
  check('Long diff folds unchanged runs and expands them without hiding changed lines');
  await page.evaluate(async({uid})=>{
    const plugin=await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/module.js'),React=await System.import('react');
    window.reviewRoot.render(React.createElement(plugin.__features.AlertSilences,{context:{alerting:{instances:[{labels:{alertname:'fixture',service:'review'}}]}}}));
  },{uid});
  await page.waitForSelector('#review-ui [data-testid="tech-ai-alert-silences"]');
  await page.click('#review-ui [data-testid="tech-ai-alert-silences"] > summary');
  await page.click('#review-ui [data-testid="tech-ai-silence-duration-4"]');
  const silence=await page.evaluate(()=>({start:document.querySelector('#review-ui [data-testid="tech-ai-silence-startsAt"]').value,end:document.querySelector('#review-ui [data-testid="tech-ai-silence-endsAt"]').value,type:document.querySelector('#review-ui [data-testid="tech-ai-silence-endsAt"]').type}));
  assert.equal(silence.type,'datetime-local'); assert.equal(new Date(silence.end)-new Date(silence.start),14400000);
  await page.setViewport({width:390,height:844});
  await page.screenshot({path:'test-results/review-silence-mobile.png'});
  const overflow=await page.$eval('#review-ui', n=>n.scrollWidth>n.clientWidth);assert.equal(overflow,false);
  check('Silence local datetime and four-hour preset work in Moscow timezone and mobile width');
  await require('./hotfix-live-checks.cjs')({page,api,uid,from,to,check});
  await page.evaluate(()=>{window.reviewRoot.unmount();document.getElementById('tech-ai-assistant-drawer').remove();});
  await page.setViewport({width:1400,height:1000});
  const savedSettings = await api('/api/plugins/tech-ai-assistant-app/settings');
  const originalDashboard = await api('/api/dashboards/uid/' + uid);
  const multiDashboard=structuredClone(originalDashboard.dashboard);
  multiDashboard.panels[0].targets.push({...multiDashboard.panels[0].targets[0],refId:'B',legendFormat:'preserve-B',interval:'2m'});
  await api('/api/dashboards/db','POST',{dashboard:multiDashboard,folderUid});
  let models = 0, writes = 0, dialogs = 0, unsafeQueries = 0;
  const protectedBytes = process.env.PROTECTED_REVIEW === '1' ? fs.readFileSync('protected/tech-ai-assistant-app/module.js') : undefined;
  let protectedResponses = 0;
  const diagnostics = [];
  const pageError = error => diagnostics.push({ error: error.message });
  const failed = request => diagnostics.push({ path: new URL(request.url()).pathname, failure: request.failure()?.errorText });
  page.on('pageerror',pageError); page.on('requestfailed',failed);
  const correctedSql = 'SELECT created_at, amount, service FROM orders WHERE $__timeFilter(created_at) ORDER BY (amount)';
  const intercept = request => {
    const url=request.url();
    if(url.endsWith('/api/ds/query')&&(request.postData()||'').includes('DELETE FROM orders'))unsafeQueries++;
    if(protectedBytes && /\/public\/plugins\/tech-ai-assistant-app\/module\.js(?:\?|$)/.test(url)) { protectedResponses++; return request.respond({status:200,contentType:'application/javascript',body:protectedBytes}); }
    if(url.endsWith('/api/plugins/tech-ai-assistant-app/settings') && request.method()==='GET') return request.respond({status:200,contentType:'application/json',body:JSON.stringify({...savedSettings,jsonData:{...savedSettings.jsonData,streaming:false,previewBeforeSend:'never',includePanelData:false}})});
    if(url.includes('/api/plugin-proxy/tech-ai-assistant-app/') && request.method()==='POST') { models++; return request.respond({status:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'```sql\n'+(models===1?'DELETE FROM orders':models===2?'SELECT missing_review_column FROM orders':correctedSql)+'\n```'}}]})}); }
    if(url.endsWith('/api/dashboards/db') && request.method()==='POST') writes++;
    return request.continue();
  };
  const dialog = d => {dialogs++;d.dismiss();};
  await page.setRequestInterception(true); page.on('request',intercept);page.on('dialog',dialog);
  try {
    if(protectedBytes) { assert.equal(process.env.REVIEW_ONLY,'1'); await page.reload({waitUntil:'domcontentloaded'}); await page.waitForSelector('#tech-ai-assistant-launcher'); }
    await page.click('#tech-ai-assistant-launcher');
    await page.waitForSelector('[data-testid="tech-ai-composer"] textarea:not([disabled])');
    await page.type('[data-testid="tech-ai-composer"] textarea','Review SQL fixture');
    await page.click('[data-testid="tech-ai-composer"] button[aria-label="Отправить"]');
    await page.waitForSelector('[data-testid="tech-ai-try-panel"]');
    await page.click('[data-testid="tech-ai-try-panel"]');
    assert.equal(await page.$('[data-testid="tech-ai-validate-proposal"]'),null);
    await page.select('[data-testid="tech-ai-proposal-target"]','B');await page.click('[data-testid="tech-ai-validate-proposal"]');
    await page.waitForFunction(()=>document.querySelector('[data-testid="tech-ai-validation-result"]')?.textContent.includes('только SELECT'));
    assert.equal(await page.$('[data-testid="tech-ai-code-header"] a'),null);
    await page.click('[data-testid="tech-ai-proposal-confirm"]');await page.click('[data-testid="tech-ai-apply-proposal"]');
    await page.waitForFunction(()=>document.querySelector('[data-testid="tech-ai-error"]')?.textContent.includes('только SELECT')||document.querySelector('#tech-ai-assistant-drawer')?.textContent.includes('Ошибка применения: SQL-инструмент выполняет только SELECT'));
    assert.equal(writes,0);assert.equal(unsafeQueries,0);
    check('Full Assistant rejects model DELETE in preview and confirmed apply; no unsafe Explore link or dashboard write');
    await page.type('[data-testid="tech-ai-composer"] textarea','Предложи SELECT для исправления');await page.click('[data-testid="tech-ai-composer"] button[aria-label="Отправить"]');
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid="tech-ai-try-panel"]').length===2);
    await page.$$eval('[data-testid="tech-ai-try-panel"]',nodes=>nodes.at(-1).click());
    await page.$$eval('[data-testid="tech-ai-proposal-target"]',nodes=>{const node=nodes.at(-1);node.value='B';node.dispatchEvent(new Event('change',{bubbles:true}));});
    await page.$$eval('[data-testid="tech-ai-validate-proposal"]',nodes=>nodes.at(-1).click());
    await page.waitForSelector('[data-testid="tech-ai-repair-proposal"]');await page.click('[data-testid="tech-ai-repair-proposal"]');
    const repairDraft=await page.$eval('[data-testid="tech-ai-composer"] textarea',n=>n.value);
    assert.match(repairDraft,/missing_review_column/);assert.match(repairDraft,/фактической ошибке/);assert.doesNotMatch(repairDraft,/__tech_ai_result|LIMIT 101/);assert.equal(models,2);assert.equal(writes,0);
    check('Actual Assistant repair button prepares factual query/error draft without another model call or write');
    await page.click('[data-testid="tech-ai-composer"] button[aria-label="Отправить"]');
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid="tech-ai-try-panel"]').length===3);
    await page.$$eval('[data-testid="tech-ai-try-panel"]',nodes=>nodes.at(-1).click());
    await page.$$eval('[data-testid="tech-ai-proposal-target"]',nodes=>{const node=nodes.at(-1);node.value='B';node.dispatchEvent(new Event('change',{bubbles:true}));});
    await page.$$eval('[data-testid="tech-ai-validate-proposal"]',nodes=>nodes.at(-1).click());
    await page.waitForFunction(()=>[...document.querySelectorAll('[data-testid="tech-ai-validation-result"]')].at(-1)?.textContent.includes('Запросы выполнены'));
    await page.$$eval('[data-testid="tech-ai-proposal-confirm"]',nodes=>nodes.at(-1).click());
    await page.evaluate(from=>{const url=new URL(location.href);url.searchParams.set('from',new Date(from-3600000).toISOString());history.pushState({},'',url);dispatchEvent(new PopStateEvent('popstate'));},from);
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid="tech-ai-validation-result"]').length===0);
    assert.equal(await page.$$eval('[data-testid="tech-ai-proposal-confirm"]',nodes=>nodes.at(-1).checked),false);
    await page.$$eval('[data-testid="tech-ai-validate-proposal"]',nodes=>nodes.at(-1).click());
    await page.waitForFunction(()=>[...document.querySelectorAll('[data-testid="tech-ai-validation-result"]')].at(-1)?.textContent.includes('Запросы выполнены'));
    check('Changing dashboard time clears proposal validation and confirmation before rechecking');
    const concurrent=(await api('/api/dashboards/uid/'+uid)).dashboard;concurrent.panels[0].targets[1].rawSql+=' /* concurrent fixture */';
    await api('/api/dashboards/db','POST',{dashboard:concurrent,folderUid});
    await page.$$eval('[data-testid="tech-ai-proposal-confirm"]',nodes=>nodes.at(-1).click());
    await page.$$eval('[data-testid="tech-ai-apply-proposal"]',nodes=>nodes.at(-1).click());
    await page.waitForFunction(()=>document.querySelector('#tech-ai-assistant-drawer').textContent.includes('Запросы панели изменились'));
    assert.equal(writes,0);assert.equal(dialogs,0);
    const latest=await api('/api/dashboards/uid/'+uid);latest.dashboard.panels[0].targets=multiDashboard.panels[0].targets;
    await api('/api/dashboards/db','POST',{dashboard:latest.dashboard,folderUid});
    await page.$$eval('[data-testid="tech-ai-proposal-confirm"]',nodes=>nodes.at(-1).click());
    let reloadTimer, loaded;
    const reloaded=new Promise((resolve,reject)=>{loaded=resolve;page.once('domcontentloaded',loaded);reloadTimer=setTimeout(()=>reject(Error('Actual document reload did not finish')),60000);});
    try { await Promise.all([reloaded,page.$$eval('[data-testid="tech-ai-apply-proposal"]',nodes=>nodes.at(-1).click())]); }
    finally {clearTimeout(reloadTimer);page.off('domcontentloaded',loaded);}
    await page.waitForSelector('#tech-ai-assistant-launcher',{timeout:60000});
    const updated=await api('/api/dashboards/uid/'+uid);
    assert.equal(updated.dashboard.panels[0].targets[0].rawSql,originalDashboard.dashboard.panels[0].targets[0].rawSql);assert.equal(updated.dashboard.panels[0].targets[1].rawSql,correctedSql);assert.equal(updated.dashboard.panels[0].targets[1].format,'table');assert.equal(updated.dashboard.panels[0].targets[1].legendFormat,'preserve-B');assert.equal(writes,1);assert.equal(dialogs,0);
    check('Explicit target B selection preserves A/options; inline confirmation blocks stale changes and saves once');
    await page.click('#tech-ai-assistant-launcher');await page.waitForSelector('[data-testid="tech-ai-composer"] textarea:not([disabled])');
    await page.setViewport({width:390,height:844});
    await page.click('[data-testid="tech-ai-scope-chip"]');await page.click('[data-testid="tech-ai-chat-panel-toggle"]');
    assert.ok(await page.$('[data-testid="tech-ai-context-popover"]'));assert.equal(await page.$eval('[data-testid="tech-ai-chat-panel-toggle"]',n=>n.checked),false);
    await page.click('[data-testid="tech-ai-chat-panel-toggle"]');assert.equal(await page.$eval('[data-testid="tech-ai-chat-panel-toggle"]',n=>n.checked),true);
    await page.screenshot({path:'test-results/review-context-mobile.png'});
    await page.click('[data-testid="tech-ai-chat-panel"]');
    assert.equal(await page.$('[data-testid="tech-ai-context-popover"]'),null);
    const composer=await page.$eval('[data-testid="tech-ai-composer"] textarea',n=>{const r=n.getBoundingClientRect();return r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;});assert.equal(composer,true);
    check('Mobile context toggles preserve popover and single-panel title shortcut; composer stays in bounds');
    if(protectedBytes) { assert.ok(protectedResponses>=2); check('Full review Assistant scenario uses exact protected AMD bytes, including reload after actual save'); }
    await page.click('#tech-ai-assistant-launcher');
  } finally {
    fs.writeFileSync('test-results/review-ui-diagnostics'+(protectedBytes?'-protected':'')+'.json',JSON.stringify({url:page.url(),models,writes,dialogs,unsafeQueries,diagnostics,protectedResponses,moduleSHA256:protectedBytes?require('node:crypto').createHash('sha256').update(protectedBytes).digest('hex'):undefined},null,2));
    page.off('pageerror',pageError);page.off('requestfailed',failed);
    page.off('request',intercept);page.off('dialog',dialog);await page.setRequestInterception(false);
    const latest=await api('/api/dashboards/uid/'+uid);
    await api('/api/dashboards/db','POST',{dashboard:{...originalDashboard.dashboard,version:latest.dashboard.version},folderUid});
    await page.setViewport({width:1400,height:1000});
    await page.evaluate(uid=>{for(const key of Object.keys(sessionStorage)) if(key.includes(uid)) sessionStorage.removeItem(key);},uid);
  }
};
