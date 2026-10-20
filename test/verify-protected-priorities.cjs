const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const puppeteer = require('puppeteer-core');
const root = process.env.GRAFANA_TEST_URL || 'http://localhost:3300/crf/dashboard';
const auth = 'Basic ' + Buffer.from((process.env.GRAFANA_TEST_USER || 'admin') + ':' + (process.env.GRAFANA_TEST_PASSWORD || 'admin')).toString('base64');
const moduleBytes = fs.readFileSync('protected/tech-ai-assistant-app/module.js');
const uid = 'ai-prot-pri-' + Date.now().toString(36);
const report = { checks: [], moduleSHA256: crypto.createHash('sha256').update(moduleBytes).digest('hex'), method: 'Exact protected module bytes substituted in browser response; server installation unchanged' };
let browser, folder, dashboard = false;
async function api(path, method = 'GET', body) { const res = await fetch(root + path, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await res.text(); if (!res.ok) throw Error(res.status + ' ' + path); return text ? JSON.parse(text) : {}; }
const check = name => { report.checks.push(name); console.log('PASS ' + name); };
async function clickText(page, label) { await page.$$eval('button', (items, label) => { const button = items.find(item => item.textContent === label); if (!button || button.disabled) throw Error('Button missing/disabled: ' + label); button.click(); }, label); }
(async () => {
  try {
    assert.equal((await api('/api/health')).version, '13.2.2');
    folder = (await api('/api/folders', 'POST', { title: uid })).uid;
    dashboard = true; await api('/api/dashboards/db', 'POST', { folderUid: folder, dashboard: { uid, title: uid, schemaVersion: 41, panels: [{ id: 1, title: 'Protected case fixture', type: 'text', options: { mode: 'markdown', content: 'Temporary UI verification' }, gridPos: { x: 0, y: 0, w: 24, h: 8 } }] } });
    const settings = await api('/api/plugins/tech-ai-assistant-app/settings');
    browser = await puppeteer.launch({ executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox'] }); const page = await browser.newPage(); page.setDefaultTimeout(30000); let moduleResponses = 0, modelCalls = 0;
    await page.setRequestInterception(true); await page.setCacheEnabled(false);
    page.on('request', request => {
      const url = request.url();
      if (/\/public\/plugins\/tech-ai-assistant-app\/module\.js(?:\?|$)/.test(url)) { moduleResponses++; return request.respond({ status: 200, contentType: 'application/javascript', body: moduleBytes }); }
      if (url.endsWith('/api/plugins/tech-ai-assistant-app/settings') && request.method() === 'GET') return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...settings, jsonData: { ...settings.jsonData, previewBeforeSend: 'never', includePanelData: false, streaming: false } }) });
      if (url.includes('/api/plugin-proxy/tech-ai-assistant-app/') && request.method() === 'POST') { modelCalls++; return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'Protected case answer.' } }] }) }); }
      return request.continue();
    });
    await page.goto(root + '/login'); await page.evaluate(async path => { const res = await fetch(path + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) }); if (!res.ok) throw Error('Login'); }, new URL(root).pathname);
    await page.goto(root + '/d/' + uid); await page.waitForSelector('#tech-ai-assistant-launcher'); await page.click('#tech-ai-assistant-launcher'); await page.waitForSelector('[data-testid="tech-ai-composer"] textarea:not([disabled])');
    await page.type('[data-testid="tech-ai-composer"] textarea', 'Protected fixture question'); await page.click('[data-testid="tech-ai-composer"] button[aria-label="Отправить"]'); await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-history"]')?.textContent.includes('Protected case answer.'));
    await page.click('[data-testid="tech-ai-actions-panel"] > summary'); await page.click('[data-testid="tech-ai-case-notebook"] > summary'); await page.click('[data-testid="tech-ai-cases-opt-in"]'); await page.click('[data-testid="tech-ai-case-save"]'); await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-case-status"]')?.textContent.includes('сохранён'));
    check('Actual protected AMD payload renders Assistant, model response and explicit local case save');
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#tech-ai-assistant-launcher'); await page.click('#tech-ai-assistant-launcher'); await page.waitForSelector('[data-testid="tech-ai-composer"] textarea:not([disabled])'); await clickText(page, 'Новый диалог');
    await page.click('[data-testid="tech-ai-actions-panel"] > summary'); await page.click('[data-testid="tech-ai-case-notebook"] > summary'); await page.click('[data-testid="tech-ai-cases-load"]'); await page.$$eval('[data-testid="tech-ai-case-notebook"] details > summary', (items, uid) => items.find(item => item.textContent.startsWith(uid)).click(), uid); await page.click('[data-testid="tech-ai-case-restore"]'); await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-history"]')?.textContent.includes('Восстановлен кейс'));
    assert.equal(modelCalls, 1); assert.ok(moduleResponses >= 2); await page.setViewport({ width: 390, height: 844 }); await page.screenshot({ path: 'test-results/protected-case-mobile.png' });
    const fits = await page.$eval('[data-testid="tech-ai-composer"] textarea', node => node.getBoundingClientRect().bottom <= innerHeight); assert.equal(fits, true);
    check('Protected UI reload/restore keeps helper contracts and mobile composer without another model request');
    await page.goto(root + '/alerting/list'); await page.waitForSelector('#tech-ai-assistant-launcher'); await page.click('#tech-ai-assistant-launcher'); await page.waitForSelector('[data-testid="tech-ai-alert-context"]'); await page.$$eval('[data-testid="tech-ai-alert-context"] > details > summary', nodes => nodes[0].click()); await page.click('[data-testid="tech-ai-notifications"] > summary'); await page.click('[data-testid="tech-ai-notifications-load"]'); await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-notifications"]')?.textContent.includes('Текущих экземпляров нет.'));
    check('Protected notification UI reads real Alertmanager and handles zero instances without claiming delivery'); report.ok = true;
  } catch (error) { report.ok = false; report.error = error.message; console.error(error); process.exitCode = 1; }
  finally { if (browser) await browser.close(); if (dashboard) await api('/api/dashboards/uid/' + uid, 'DELETE'); if (folder) await api('/api/folders/' + folder, 'DELETE'); fs.writeFileSync('test-results/protected-priorities-live.json', JSON.stringify(report, null, 2)); }
})();
