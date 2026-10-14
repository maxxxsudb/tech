const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
const root = 'http://tech-ai-grafana-test:3000/crf/dashboard';
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const statuses = [], results = [];
  let settings, calls = 0;
  try {
    page.setDefaultTimeout(30000);
    await page.setRequestInterception(true);
    page.on('response', response => { if (response.url().includes('/api/datasources/proxy/uid/loki/loki/api/v1/')) statuses.push({ url: response.url(), status: response.status() }); });
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      const respond = value => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
      if (settings && path.endsWith('/api/plugins/tech-ai-assistant-app/settings')) return respond({ ...settings, jsonData: { provider: 'custom', model: 'Live schema mock', streaming: false, includePanelData: false, schemaDiscoveryEnabled: true, previewBeforeSend: 'always', launcherMode: 'both' } });
      if (path.includes('/api/plugin-proxy/tech-ai-assistant-app/')) {
        const body = JSON.parse(request.postData());
        const last = body.messages.at(-1);
        if (typeof last.content === 'string' && last.content.startsWith('Результаты запросов')) results.push(last.content);
        calls++;
        const content = calls === 1 ? '```grafana-schema\n{"datasourceUid":"loki","action":"labels","reason":"Проверить живой API labels"}\n```' : calls === 2 ? '```grafana-schema\n{"datasourceUid":"loki","action":"label_values","label":"service_name","reason":"Проверить живой API label values"}\n```' : 'SCHEMA LIVE VERIFIED';
        return respond({ choices: [{ message: { content } }] });
      }
      return request.continue();
    });
    await page.goto(`${root}/login`);
    await page.evaluate(async () => { const response = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) }); if (!response.ok) throw new Error('Login failed'); });
    settings = await page.evaluate(async () => (await fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings')).json());
    await page.goto(`${root}/a/tech-ai-assistant-app?dashboardUid=tech&from=now-1h&to=now`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.tech-ai-root[data-busy="false"] [data-testid="tech-ai-composer"] textarea:not([disabled])');
    await page.select('[data-testid="tech-ai-composer-data-mode"]', 'investigation');
    await page.type('[data-testid="tech-ai-composer"] textarea', 'Проверь метаданные Loki');
    await page.evaluate(() => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Отправить').click());
    await page.waitForSelector('[data-testid="tech-ai-investigation-setup"]');
    await page.click('[data-testid="tech-ai-allow-queries"]');
    await page.waitForSelector('[data-testid="tech-ai-allow-schema"]'); await page.click('[data-testid="tech-ai-allow-schema"]');
    await page.evaluate(() => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Начать расследование').click());
    await page.waitForFunction(() => document.body.textContent.includes('SCHEMA LIVE VERIFIED'));
    assert.equal(calls, 3); assert.equal(statuses.length, 2);
    assert.ok(statuses.every(item => item.status === 200), JSON.stringify(statuses));
    assert.equal(results.length, 2);
    assert.ok(results.every(value => value.includes('"kind":"schema"') && !value.includes('"error":')), results.join('\n'));
    console.log('live-loki-schema=ok; actual Grafana proxy, actual Loki labels and label_values, HTTP 200; model only is mocked; empty metadata is valid for current range');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exit(1); });
