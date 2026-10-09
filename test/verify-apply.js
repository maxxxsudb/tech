const puppeteer = require('puppeteer');
let testStage = 'launch';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    timeout: 60000,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  const pendingRequests = new Map();
  const failedRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfinished', (request) => pendingRequests.delete(request));
  page.on('requestfailed', (request) => {
    pendingRequests.delete(request);
    failedRequests.push({ url: request.url(), type: request.resourceType(), error: request.failure()?.errorText });
  });
  page.setDefaultNavigationTimeout(60000);
  await page.setCacheEnabled(false);
  await page.setViewport({ width: 1500, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    pendingRequests.set(request, { url: request.url(), type: request.resourceType(), navigation: request.isNavigationRequest(), started: Date.now() });
    if (request.url().includes('/api/plugin-proxy/tech-ai-assistant-app/')) {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: '```dashboard-json\n{"panelId":1,"targets":[{"expr":"{service_name=\\"keycloak\\"} |= \\"error\\"","refId":"A"},{"expr":"{service_name=\\"keycloak\\"} |= \\"warn\\"","refId":"B"}]}\n```' } }] }),
      });
    } else request.continue();
  });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
  testStage = 'login and create';
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
          panels: [{ id: 1, title: 'Logs', type: 'logs', datasource: { type: 'loki', uid: 'loki' }, targets: [{ datasource: { type: 'loki', uid: 'loki' }, expr: '{service_name="keycloak"}', refId: 'A', legendFormat: 'preserve-options' }, { datasource: { type: 'loki', uid: 'loki' }, expr: '{service_name="keycloak"} |= "keep"', refId: 'B' }], gridPos: { h: 8, w: 24, x: 0, y: 0 } }],
          time: { from: 'now-1h', to: 'now' },
        },
      }),
    });
    if (!create.ok) throw new Error(`Create dashboard failed: ${create.status}`);
  });
  try {
    testStage = 'open dashboard';
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
    testStage = 'select targets';
    await page.$eval('[data-testid="tech-ai-proposal-diff"]', (node) => {
      node.open = true;
      const targets = node.querySelectorAll('input[type="checkbox"]');
      if (targets.length !== 2) throw new Error('Expected two target controls');
      targets[1].click();
    });
    testStage = 'concurrent update';
    await page.evaluate(async () => {
      const latest = await (await fetch('/crf/dashboard/api/dashboards/uid/tech-ai-apply-test')).json();
      latest.dashboard.panels[0].targets[1].expr = '{service_name="keycloak"} |= "concurrent"';
      const save = await fetch('/crf/dashboard/api/dashboards/db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dashboard: latest.dashboard, overwrite: false }) });
      if (!save.ok) throw new Error(`Concurrent test update failed: ${save.status}`);
    });
    const dialogs = [];
    page.on('dialog', (dialog) => { dialogs.push(dialog.type()); dialog.accept(); });
    testStage = 'apply and reload';
    // History API changes also satisfy waitForNavigation, but do not reload the document.
    let documentLoaded = false, reloadListener, reloadTimer;
    const actualDocument = new Promise((resolve, reject) => {
      reloadListener = () => { documentLoaded = true; clearTimeout(reloadTimer); resolve(); };
      page.once('domcontentloaded', reloadListener);
      reloadTimer = setTimeout(() => reject(new Error('Applied dashboard did not complete document reload within 60s')), 60000);
    });
    try {
      await Promise.all([actualDocument, page.click('[data-testid="tech-ai-apply-proposal"]')]);
      testStage = 'verify saved targets';
      await page.waitForSelector('#tech-ai-assistant-launcher', { timeout: 60000 });
    }
    catch (error) {
      console.error('reload-state=' + JSON.stringify({ url: page.url(), errors: pageErrors, dialogs,
        documentLoaded,
        pending: [...pendingRequests.values()].map(({ started, ...request }) => ({ ...request, ageMs: Date.now() - started })),
        failed: failedRequests,
        state: await page.evaluate(() => ({ ready: document.readyState, timeOrigin: performance.timeOrigin, title: document.title, headings: [...document.querySelectorAll('h1,h2')].map((node) => node.textContent) })) }));
      await page.screenshot({ path: '/test-results/apply-failure.png' });
      throw error;
    } finally {
      clearTimeout(reloadTimer);
      page.off('domcontentloaded', reloadListener);
    }
    const targets = await page.evaluate(async () => {
      const response = await fetch('/crf/dashboard/api/dashboards/uid/tech-ai-apply-test');
      const data = await response.json();
      return data.dashboard.panels[0].targets;
    });
    if (targets[0].expr !== '{service_name="keycloak"} |= "error"' || targets[0].legendFormat !== 'preserve-options' || targets[1].expr !== '{service_name="keycloak"} |= "concurrent"') throw new Error(`Unexpected saved targets: ${JSON.stringify(targets)}`);
    console.log('apply-test=ok; dialogs=' + dialogs.join(','));
  } finally {
    const cleanup = await browser.newPage();
    await cleanup.goto('http://tech-ai-grafana-test:3000/crf/dashboard/api/health', { waitUntil: 'domcontentloaded' });
    await cleanup.evaluate(() => fetch('/crf/dashboard/api/dashboards/uid/tech-ai-apply-test', { method: 'DELETE' }));
    await cleanup.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(`apply-test stage=${testStage}`);
  console.error(error.stack || error);
  process.exit(1);
});
