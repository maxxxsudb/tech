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
  await page.setViewport({ width: 1600, height: 1000 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.url().includes('/api/plugin-proxy/tech-ai-assistant-app/')) {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { content: 'Исправленный запрос:\n' + Array.from({ length: 45 }, (_, index) => `Строка подробного ответа ${index + 1}`).join('\n') + '\n```logql\n{service_name="keycloak"} |= "error"\n```\n```dashboard-json\n{"panelId":2,"targets":[{"datasource":{"type":"loki","uid":"loki"},"expr":"{service_name=\\"keycloak\\"} |= \\"error\\"","refId":"A"}]}\n```' } }],
        }),
      });
    } else {
      request.continue();
    }
  });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const response = await fetch('/crf/dashboard/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'admin', password: 'admin' }),
    });
    if (!response.ok) throw new Error(`Login failed: ${response.status}`);
  });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/d/tech/tech-stand?orgId=1&from=now-24h&to=now&var-api_key=gsk_supersecretvalue12345', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tech-ai-assistant-launcher', { visible: true, timeout: 30000 });
  await page.click('#tech-ai-assistant-launcher');
  await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])', { visible: true, timeout: 30000 });
  const chatTabActive = await page.$eval('[data-testid="tech-ai-tab-chat"]', (node) => node.getAttribute('aria-selected') === 'true');
  if (!chatTabActive) throw new Error('Chat tab must be active by default');
  const actionsCollapsed = await page.$eval('[data-testid="tech-ai-actions-panel"]', (node) => !node.open);
  if (!actionsCollapsed) throw new Error('Actions must be collapsed by default');
  await page.$eval('[data-testid="tech-ai-actions-panel"]', (node) => { node.open = true; });
  await page.evaluate(() => {
    const drawer = document.querySelector('#tech-ai-assistant-drawer');
    [...drawer.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Объяснить').click();
  });
  await page.waitForSelector('[data-testid="tech-ai-send-preview"]', { visible: true, timeout: 10000 });
  await page.click('[data-testid="tech-ai-send-preview"] button');
  await page.waitForFunction(() => document.querySelector('#tech-ai-assistant-drawer').innerText.includes('Применить к дашборду'), { timeout: 60000 });
  await page.click('[data-testid="tech-ai-tab-diag"]');
  await page.evaluate(() => {
    const details = [...document.querySelectorAll('#tech-ai-assistant-drawer details')].find((item) => item.querySelector('summary')?.textContent.includes('Последний отправленный контекст'));
    details.open = true;
  });
  const drawerLayout = await page.evaluate(() => {
    const drawer = document.querySelector('#tech-ai-assistant-drawer').getBoundingClientRect();
    const close = document.querySelector('#tech-ai-assistant-drawer button[title^="Закрыть"]').getBoundingClientRect();
    return { drawerLeft: drawer.left, drawerRight: drawer.right, drawerWidth: drawer.width, closeLeft: close.left, closeRight: close.right, viewport: window.innerWidth };
  });
  if (drawerLayout.drawerLeft < 0 || drawerLayout.drawerRight > drawerLayout.viewport || drawerLayout.drawerWidth > drawerLayout.viewport || drawerLayout.closeLeft < 0 || drawerLayout.closeRight > drawerLayout.viewport) {
    throw new Error(`Drawer escaped viewport: ${JSON.stringify(drawerLayout)}`);
  }
  await page.click('[data-testid="tech-ai-tab-chat"]');
  await page.waitForSelector('[data-testid="tech-ai-history"]', { visible: true, timeout: 10000 });
  const scrolling = await page.$eval('[data-testid="tech-ai-history"]', (node) => {
    node.scrollTop = 0;
    const before = node.scrollTop;
    const canScroll = node.scrollHeight > node.clientHeight;
    node.scrollTop = node.scrollHeight;
    return { canScroll, moved: node.scrollTop > before, overflowY: getComputedStyle(node).overflowY };
  });
  if (!scrolling.canScroll || !scrolling.moved || scrolling.overflowY !== 'auto') throw new Error(`Answer history is not scrollable: ${JSON.stringify(scrolling)}`);
  await page.screenshot({ path: '/test/features-success.png', fullPage: false });
  await page.$$eval('[data-testid="tech-ai-user-turn"] details', nodes => nodes.forEach(node => { node.open = true; }));
  const chatText = await page.$eval('#tech-ai-assistant-drawer', (node) => node.innerText);
  await page.click('[data-testid="tech-ai-tab-diag"]');
  await page.waitForSelector('[data-testid="tech-ai-diagnostics-tab"]', { visible: true, timeout: 10000 });
  await page.evaluate(() => document.querySelectorAll('[data-testid="tech-ai-diagnostics-tab"] details').forEach((node) => { node.open = true; }));
  const text = chatText + ' ' + await page.$eval('#tech-ai-assistant-drawer', (node) => node.innerText);
  await page.click('[data-testid="tech-ai-tab-chat"]');
  if (!/Данные панелей: \d+ из 3/.test(text)) throw new Error('Live panel data note is missing');
  if (!text.includes('alice')) throw new Error('Live datasource rows are missing from context preview');
  if (text.includes('gsk_supersecretvalue12345') || !text.includes('[REDACTED]')) throw new Error('Secret redaction failed');
  if (!text.includes('Применить к дашборду')) throw new Error('Dashboard diff/apply control is missing');
  await page.evaluate(() => document.querySelector('#tech-ai-assistant-drawer button[title^="Закрыть"]').click());
  await page.click('#tech-ai-assistant-launcher');
  await page.waitForFunction(() => document.querySelector('#tech-ai-assistant-drawer').innerText.includes('Исправленный запрос'), { timeout: 10000 });
  await page.evaluate(() => {
    const drawer = document.querySelector('#tech-ai-assistant-drawer');
    [...drawer.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Новый диалог').click();
  });
  const cleared = await page.$eval('#tech-ai-assistant-drawer', (node) => node.innerText);
  if (cleared.includes('Исправленный запрос')) throw new Error('New dialog did not clear persisted history');
  console.log('feature-test=ok');
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
