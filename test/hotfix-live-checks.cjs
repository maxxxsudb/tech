const assert = require('node:assert/strict');
const fs = require('node:fs');
const puppeteer = require('puppeteer-core');
const root = process.env.GRAFANA_TEST_URL || 'http://localhost:3300/crf/dashboard';
const fill = (page, selector, value) => page.$eval(selector, (node,value)=>{Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));},value);
const clickText = (page,text) => page.$$eval('button',(nodes,text)=>{const node=nodes.find(n=>n.textContent===text);if(!node||node.disabled)throw Error('Missing button '+text);node.click();},text);

module.exports = async ({page,api,uid,from,to,check}) => {
  const sqlRequests=[];
  const count = request => { if(request.url().endsWith('/api/ds/query')||request.url().endsWith('/api/dashboards/db')&&request.method()==='POST') sqlRequests.push(request.url()); };
  await page.waitForNetworkIdle({idleTime:500});page.on('request',count);
  try {
    const blocked=await page.evaluate(async({uid,from,to})=>{
      const plugin=await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/module.js');
      const saved=await fetch('/crf/dashboard/api/dashboards/uid/'+uid).then(r=>r.json());
      const context={dashboardUid:uid,panels:saved.dashboard.panels,timeRange:{from,to},variables:{}},settings=plugin.__test.defaults;
      const results=[];
      for(const rawSql of ['DELETE FROM orders','WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x','SELECT 1; DELETE FROM orders']) {
        const proposal={panelId:1,targets:[{refId:'A',rawSql}]};
        for(const method of ['validateDashboardProposal','applyDashboardProposal']) {let error;try{await plugin.__features[method](settings,context,proposal);}catch(e){error=e.message;}results.push({method,error});}
      }
      return results;
    },{uid,from,to});
    assert.equal(blocked.length,6);assert.ok(blocked.every(item=>item.error));assert.equal(sqlRequests.length,0);
  } finally {page.off('request',count);}
  check('Unsafe SQL proposal validation/save block before any ds/query or dashboard POST on actual Grafana');
  const executed=[];
  const capture=request=>{if(request.url().endsWith('/api/ds/query'))executed.push(...JSON.parse(request.postData()).queries);};
  page.on('request',capture);
  let bounded,failed;
  try {
    ({bounded,failed}=await page.evaluate(async({uid,from,to})=>{
      const plugin=await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/module.js');
      const context={dashboardUid:uid,panels:[{id:1,datasource:uid,targets:[{refId:'A',datasource:uid,rawSql:'SELECT 1',format:'table',rawQuery:true}]}],timeRange:{from,to}};
      const proposal=plugin.__features.codeProposal(context,[1],'sql','SELECT generate_series(1,1000) AS value',plugin.__test.defaults);
      if(!proposal)throw Error('String datasource code proposal unavailable');
      const bounded=await plugin.__features.validateDashboardProposal(plugin.__test.defaults,context,proposal);
      const failed=await plugin.__features.validateDashboardProposal(plugin.__test.defaults,context,{panelId:1,targets:[{refId:'A',rawSql:'SELECT missing_review_column FROM orders'}]});
      return {bounded,failed:{...failed,prompt:plugin.__features.repairPrompt(failed,plugin.__test.defaults)}};
    },{uid,from,to}));
  } finally {page.off('request',capture);}
  assert.equal(bounded.ok,true);assert.equal(bounded.details[0].rows,101);assert.equal(bounded.details[0].query.rawSql,'SELECT generate_series(1,1000) AS value');
  assert.equal(executed.length,2);assert.ok(executed.every(query=>/LIMIT 101$/.test(query.rawSql)));
  check('Proposal preview actually bounds a thousand PostgreSQL rows to 100 plus one sentinel');
  check('Legacy string datasource resolves through actual Grafana registry for code proposal and successful SELECT preview');
  assert.equal(failed.ok,false);assert.equal(failed.details[0].query.rawSql,'SELECT missing_review_column FROM orders');assert.match(failed.prompt,/missing_review_column/);assert.doesNotMatch(failed.prompt,/__tech_ai_result|LIMIT 101/);
  check('Real PostgreSQL error repair receives original SQL; preview LIMIT stays only in ds/query execution');
  for(const sql of ["SELECT to_jsonb(orders) FROM orders","SELECT jsonb_path_query('[1,2]'::jsonb,'$[*]') AS item","SELECT array_length(ARRAY[1,2],1) AS n","SELECT string_to_array('a,b',',') AS parts","SELECT regexp_split_to_table('a,b',',') AS item","SELECT format('%s','ok') AS text"]) {
    const q=require('../plugin/query-tools');const result=await api('/api/ds/query','POST',{from:String(from),to:String(to),queries:[{refId:'A',datasource:{uid,type:'grafana-postgresql-datasource'},format:'table',rawQuery:true,...q.boundedSql(sql)}]});
    assert.ok(!result.results.A.error,JSON.stringify(result));
  }
  check('Curated JSON/array/string SQL functions execute successfully on existing PostgreSQL');
  await page.emulateTimezone('America/New_York');
  await page.evaluate(async uid=>{
    const plugin=await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/module.js'),React=await System.import('react');
    window.reviewRoot.render(React.createElement(plugin.__features.IncidentChangesPanel,{context:{dashboardUid:uid},onEvidence:()=>{}}));
  },uid);
  await page.waitForSelector('[data-testid="tech-ai-incident-changes"]');await page.click('[data-testid="tech-ai-incident-changes"] > summary');
  await fill(page,'[data-testid="tech-ai-incident-at"]','2026-03-08T02:30');
  await page.waitForSelector('[data-testid="tech-ai-incident-time-error"]');
  assert.match(await page.$eval('[data-testid="tech-ai-incident-time-error"]',n=>n.textContent),/не существует/);
  assert.equal(await page.$eval('[data-testid="tech-ai-incident-at"]',n=>n.value),'2026-03-08T02:30');
  assert.equal(await page.$eval('[data-testid="tech-ai-incident-load"]',n=>n.disabled),true);
  await fill(page,'[data-testid="tech-ai-incident-at"]','');await page.waitForFunction(()=>!document.querySelector('[data-testid="tech-ai-incident-load"]').disabled);
  await page.evaluate(async()=>{const plugin=await System.import('/crf/dashboard/public/plugins/tech-ai-assistant-app/module.js'),React=await System.import('react');window.reviewRoot.render(React.createElement(plugin.__features.AlertSilences,{context:{alerting:{instances:[]}}}));});
  await page.waitForSelector('[data-testid="tech-ai-alert-silences"]');await page.click('[data-testid="tech-ai-alert-silences"] > summary');
  await fill(page,'[data-testid="tech-ai-silence-endsAt"]','2026-03-08T02:30');await page.waitForSelector('[data-testid="tech-ai-silence-time-error-endsAt"]');
  assert.equal(await page.$eval('[data-testid="tech-ai-silence-endsAt"]',n=>n.value),'2026-03-08T02:30');assert.equal(await page.$eval('[data-testid="tech-ai-silence-preview"]',n=>n.disabled),true);
  await page.click('[data-testid="tech-ai-silence-duration-1"]');await page.waitForFunction(()=>!document.querySelector('[data-testid="tech-ai-silence-preview"]').disabled);
  await page.emulateTimezone('Europe/Moscow');
  check('DST gap remains visible with inline error and blocked incident/silence actions; explicit clear or preset recovers');

  let browser;
  try {
    const stand=new URL(root);assert.ok(['localhost','127.0.0.1'].includes(stand.hostname));const httpRoot=`http://grafana.test:${stand.port}${stand.pathname}`;
    const settings=await api('/api/plugins/tech-ai-assistant-app/settings'),bytes=process.env.PROTECTED_REVIEW==='1'?fs.readFileSync('protected/tech-ai-assistant-app/module.js'):undefined;
    browser=await puppeteer.launch({executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP grafana.test 127.0.0.1']});
    const insecure=await browser.newPage();insecure.setDefaultTimeout(60000);let models=0,writes=0;
    await insecure.setRequestInterception(true);insecure.on('request',request=>{
      const url=request.url();
      if(bytes&&/\/public\/plugins\/tech-ai-assistant-app\/module\.js(?:\?|$)/.test(url))return request.respond({status:200,contentType:'application/javascript',body:bytes});
      if(url.endsWith('/api/plugins/tech-ai-assistant-app/settings')&&request.method()==='GET')return request.respond({status:200,contentType:'application/json',body:JSON.stringify({...settings,jsonData:{...settings.jsonData,includePanelData:false,previewBeforeSend:'never',streaming:false,alertingEnabled:true}})});
      if(url.includes('/api/plugin-proxy/tech-ai-assistant-app/')&&request.method()==='POST'){models++;return request.respond({status:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'HTTP fixture answer'}}]})});}
      if(request.method()==='POST'&&(url.includes('/alert-rules')||url.includes('/alertrules')||url.endsWith('/api/v1/eval')))writes++;
      return request.continue();
    });
    await insecure.goto(httpRoot+'/login',{waitUntil:'domcontentloaded'});
    await insecure.evaluate(async({path,user,password})=>{const r=await fetch(path+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user,password})});if(!r.ok)throw Error('Login '+r.status);},{path:stand.pathname,user:process.env.GRAFANA_TEST_USER||'admin',password:process.env.GRAFANA_TEST_PASSWORD||'admin'});
    await insecure.goto(httpRoot+'/d/'+uid,{waitUntil:'domcontentloaded'});await insecure.waitForSelector('#tech-ai-assistant-launcher');
    const support=await insecure.evaluate(()=>({secure:isSecureContext,uuid:typeof crypto.randomUUID,random:typeof crypto.getRandomValues}));
    assert.deepEqual(support,{secure:false,uuid:'undefined',random:'function'});
    await insecure.click('#tech-ai-assistant-launcher');await insecure.waitForSelector('[data-testid="tech-ai-composer"] textarea:not([disabled])');
    await insecure.click('[data-testid="tech-ai-actions-panel"] > summary');await clickText(insecure,'Подготовить алерт');await insecure.waitForSelector('[data-testid="tech-ai-alert-editor"]');await clickText(insecure,'Вернуться в чат');
    assert.equal(models,0);assert.equal(writes,0);
    await insecure.type('[data-testid="tech-ai-composer"] textarea','HTTP UUID fixture');await insecure.click('[data-testid="tech-ai-composer"] button[aria-label="Отправить"]');await insecure.waitForFunction(()=>document.querySelector('[data-testid="tech-ai-history"]')?.textContent.includes('HTTP fixture answer'));
    await insecure.$eval('[data-testid="tech-ai-actions-panel"]',n=>{n.open=true;});await insecure.click('[data-testid="tech-ai-case-notebook"] > summary');await insecure.click('[data-testid="tech-ai-cases-opt-in"]');await insecure.click('[data-testid="tech-ai-case-save"]');await insecure.waitForFunction(()=>document.querySelector('[data-testid="tech-ai-case-status"]')?.textContent.includes('сохранён'));
    const record=await insecure.evaluate(()=>{const key=Object.keys(localStorage).find(k=>k.startsWith('tech-ai-assistant:cases:v1:'));return JSON.parse(localStorage.getItem(key))[0];});
    assert.match(record.id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    await insecure.$$eval('[data-testid="tech-ai-case-notebook"] details > summary',nodes=>nodes.find(n=>n.textContent==='Импорт кейса JSON').click());
    await fill(insecure,'[aria-label="JSON кейса"]',JSON.stringify(record));await clickText(insecure,'Импортировать локально');await insecure.waitForFunction(()=>document.querySelector('[data-testid="tech-ai-case-status"]')?.textContent.includes('импортирован'));
    const ids=await insecure.evaluate(()=>{const key=Object.keys(localStorage).find(k=>k.startsWith('tech-ai-assistant:cases:v1:'));return JSON.parse(localStorage.getItem(key)).map(c=>c.id);});assert.equal(ids.length,2);assert.equal(new Set(ids).size,2);assert.equal(models,1);assert.equal(writes,0);
    check((bytes?'Protected':'Source')+' HTTP non-localhost origin has no randomUUID: alert builder and case save/import work via getRandomValues');
  } finally {if(browser)await browser.close();}
};
