const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    timeout: 60000,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  await page.setViewport({ width: 1500, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.url().includes('/api/plugin-proxy/tech-ai-assistant-app/')) {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: '```dashboard-json\n{"panelId":1,"targets":[{"datasource":{"type":"loki","uid":"loki"},"expr":"{service_name=\\"keycloak\\"} |= \\"error\\"","refId":"A"}]}\n```' } }] }),
      });
    } else request.continue();
  });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const login = await fetch('/crf/dashboard/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }),
    });
    if (!login.ok) throw new Error(`Login failed: ${login.status}`);
    const create = await fetch('/crf/dashboard/api/dashboards/db', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        overwrite: true,
        dashboard: {
          id: null,
          uid: 'tech-ai-apply-test',
          title: 'Tech AI apply test',
          schemaVersion: 42,
          version: 0,
          panels: [{ id: 1, title: 'Logs', type: 'logs', datasource: { type: 'loki', uid: 'loki' }, targets: [{ datasource: { type: 'loki', uid: 'loki' }, expr: '{service_name="keycloak"}', refId: 'A' }], gridPos: { h: 8, w: 24, x: 0, y: 0 } }],
          time: { from: 'now-1h', to: 'now' },
        },
      }),
    });
    if (!create.ok) throw new Error(`Create dashboard failed: ${create.status}`);
  });
  try {
    await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/d/tech-ai-apply-test/test?from=now-1h&to=now', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tech-ai-assistant-launcher', { visible: true, timeout: 30000 });
    await page.click('#tech-ai-assistant-launcher');
    await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])', { visible: true, timeout: 30000 });
    await page.$eval('[data-testid="tech-ai-actions-panel"]', (node) => { node.open = true; });
    await page.evaluate(() => {
      const drawer = document.querySelector('#tech-ai-assistant-drawer');
      [...drawer.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Исправить запрос').click();
    });
    await page.waitForSelector('[data-testid="tech-ai-send-preview"]', { visible: true, timeout: 10000 });
    await page.click('[data-testid="tech-ai-send-preview"] button');
    await page.waitForFunction(() => document.querySelector('#tech-ai-assistant-drawer').innerText.includes('Применить к дашборду'), { timeout: 60000 });
    page.once('dialog', (dialog) => dialog.accept());
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.evaluate(() => {
        const drawer = document.querySelector('#tech-ai-assistant-drawer');
        [...drawer.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Применить к дашборду').click();
      }),
    ]);
    const expression = await page.evaluate(async () => {
      const response = await fetch('/crf/dashboard/api/dashboards/uid/tech-ai-apply-test');
      const data = await response.json();
      return data.dashboard.panels[0].targets[0].expr;
    });
    if (expression !== '{service_name="keycloak"} |= "error"') throw new Error(`Unexpected saved expression: ${expression}`);
    console.log('apply-test=ok');
  } finally {
    const cleanup = await browser.newPage();
    await cleanup.goto('http://tech-ai-grafana-test:3000/crf/dashboard/api/health', { waitUntil: 'domcontentloaded' });
    await cleanup.evaluate(() => fetch('/crf/dashboard/api/dashboards/uid/tech-ai-apply-test', { method: 'DELETE' }));
    await cleanup.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
