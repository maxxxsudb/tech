const fs = require('node:fs');
const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
const baselineSource = fs.readFileSync(0, 'utf8');
assert.ok(baselineSource.includes('PLUGIN_VERSION = "0.8.7"'), 'Pipe module.js from commit 9ca5104 to stdin');
const root = 'http://tech-ai-grafana-test:3000/crf/dashboard';
const uid = `tech-ai-ui-compare-${Date.now().toString(36)}`;
const result = [];
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, timeout: 60000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  let created = false;
  const setup = await browser.newPage();
  try {
    await setup.goto(`${root}/login`, { waitUntil: 'domcontentloaded' });
    await setup.evaluate(async uid => {
      const login = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) }); if (!login.ok) throw new Error('Login failed');
      const response = await fetch('/crf/dashboard/api/dashboards/db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dashboard: { uid, title: 'UI comparison', schemaVersion: 42, panels: [{ id: 1, title: 'CPU', type: 'text', targets: [], options: { mode: 'markdown', content: 'Test dashboard' }, gridPos: { x: 0, y: 0, w: 24, h: 8 } }], time: { from: 'now-1h', to: 'now' } }, overwrite: false }) }); if (!response.ok) throw new Error('Create failed');
    }, uid); created = true;
    const settings = await setup.evaluate(async () => (await fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings')).json());
    for (const baseline of [true, false]) {
      const page = await browser.newPage(); page.setDefaultTimeout(60000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.setRequestInterception(true);
      page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (baseline && path.endsWith('/tech-ai-assistant-app/module.js')) return request.respond({ status: 200, contentType: 'application/javascript', body: baselineSource });
        if (path.endsWith('/api/plugins/tech-ai-assistant-app/settings')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...settings, jsonData: { provider: 'custom', model: 'UI mock', apiUrl: 'http://unused', apiPath: '/v1/chat/completions', launcherMode: 'both', streaming: false, includePanelData: false, screenshotEnabled: true, previewBeforeSend: 'always' } }) });
        if (path.includes('/api/plugin-proxy/tech-ai-assistant-app/')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '## Назначение панели\n\nCPU показывает загрузку сервера.\n\n' + 'Одинаковый длинный ответ для сравнения интерфейса.\n\n'.repeat(18) } }] }) });
        return request.continue();
      });
      await page.setViewport({ width: 1280, height: 650 });
      await page.goto(`${root}/d/${uid}/compare?from=now-1h&to=now`, { waitUntil: 'networkidle2' });
      await page.waitForSelector('#tech-ai-assistant-launcher'); await page.click('#tech-ai-assistant-launcher');
      await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])');
      await page.type('#tech-ai-assistant-drawer textarea', 'Объясни назначение панели CPU');
      await page.evaluate(() => [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find(node => node.textContent.trim() === 'Отправить').click());
      await page.waitForSelector('[data-testid="tech-ai-send-preview"]'); await page.$eval('[data-testid="tech-ai-send-preview"] button', node => node.click());
      await page.waitForSelector('[data-testid="tech-ai-answer"]'); await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])');
      for (const width of [1280, 360]) {
        await page.setViewport({ width, height: width === 1280 ? 650 : 740 });
        const dimensions = await page.evaluate(() => {
          const history = document.querySelector('[data-testid="tech-ai-history"]');
          const footer = document.querySelector('#tech-ai-assistant-drawer textarea').closest('.tech-ai-root').lastElementChild;
          history.scrollTop = 0;
          return { history: history.clientHeight, footer: Math.round(footer.getBoundingClientRect().height), textarea: Math.round(document.querySelector('#tech-ai-assistant-drawer textarea').getBoundingClientRect().height), screen: innerHeight, rootOverflow: document.querySelector('.tech-ai-root').scrollWidth > document.querySelector('.tech-ai-root').clientWidth + 2 };
        });
        assert.ok(!dimensions.rootOverflow, JSON.stringify(dimensions));
        result.push({ version: baseline ? '0.8.7' : '0.8.8', width, ...dimensions });
        await page.screenshot({ path: `/test-results/assistant-compare-${baseline ? '087' : '088'}-${width}.png` });
      }
      assert.ok(!errors.length, errors.join('\n')); await page.close();
    }
    console.log('ui-comparison=' + JSON.stringify(result));
    for (const width of [1280, 360]) {
      const before = result.find(row => row.width === width && row.version === '0.8.7');
      const after = result.find(row => row.width === width && row.version === '0.8.8');
      assert.ok(after.history >= before.history, `History lost space at ${width}: ${before.history} -> ${after.history}`);
    }
  } finally {
    try { if (created) await setup.evaluate(async uid => { const response = await fetch(`/crf/dashboard/api/dashboards/uid/${uid}`, { method: 'DELETE' }); if (!response.ok) throw new Error('Cleanup failed'); }, uid); }
    finally { await browser.close(); }
  }
})().catch(error => { console.error(error.stack); process.exit(1); });
