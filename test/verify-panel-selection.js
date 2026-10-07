const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  let chatBody;
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.url().includes('/api/plugin-proxy/tech-ai-assistant-app/')) {
      chatBody = JSON.parse(request.postData());
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: 'selection-ok' } }] }),
      });
    } else request.continue();
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
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/d/tech/tech-stand?orgId=1&from=now-24h&to=now', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tech-ai-assistant-launcher', { visible: true, timeout: 30000 });
  await page.click('#tech-ai-assistant-launcher');
  await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])', { visible: true, timeout: 30000 });
  const initial = await page.$eval('[data-testid="tech-ai-panel-summary"]', (node) => node.textContent);
  if (!/^Передаём панели: \d+ из \d+$/.test(initial)) throw new Error(`Panel summary missing: ${initial}`);
  await page.click('[data-testid="tech-ai-panel-summary"]');
  const selectedTitle = await page.evaluate(() => {
    const drawer = document.querySelector('#tech-ai-assistant-drawer');
    const buttons = [...drawer.querySelectorAll('button')].filter((button) => button.textContent.trim() === 'Только эта');
    if (buttons.length < 2) throw new Error('Not enough panel controls');
    const row = buttons[1].parentElement;
    const title = row.querySelector('label').textContent.trim();
    buttons[1].click();
    return title;
  });
  await page.type('#tech-ai-assistant-drawer textarea', 'Проверь выбранную панель');
  await page.evaluate(() => {
    const drawer = document.querySelector('#tech-ai-assistant-drawer');
    [...drawer.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Отправить').click();
  });
  await page.waitForSelector('[data-testid="tech-ai-send-preview"]', { visible: true, timeout: 10000 });
  await page.click('[data-testid="tech-ai-send-preview"] button');
  await page.waitForFunction(() => document.querySelector('#tech-ai-assistant-drawer').innerText.includes('selection-ok'), { timeout: 60000 });
  if (!chatBody) throw new Error('Chat request was not captured');
  const attachment = chatBody.messages.find((message) => typeof message.content === 'string' && message.content.startsWith('Файл: grafana-context.json'));
  if (!attachment) throw new Error('grafana-context.json message missing');
  const match = /```json\n([\s\S]*?)\n```/.exec(attachment.content);
  if (!match) throw new Error('JSON document body missing');
  const context = JSON.parse(match[1]);
  if (!Array.isArray(context.panels) || context.panels.length !== 1) throw new Error(`Expected one panel, got ${context.panels && context.panels.length}`);
  if (Array.isArray(context.panelData) && context.panelData.some((item) => Number(item.panelId) !== Number(context.panels[0].id))) throw new Error('Unselected panel data was sent');
  const summary = await page.$eval('[data-testid="tech-ai-panel-summary"]', (node) => node.textContent);
  if (!summary.includes('1 из')) throw new Error(`Selection was not reflected: ${summary}`);
  console.log(`panel-selection-test=ok; selected=${selectedTitle}; panelId=${context.panels[0].id}`);
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
