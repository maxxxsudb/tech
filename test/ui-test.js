const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const errors = [];
  const failedResponses = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
  const login = await page.evaluate(async () => {
    const response = await fetch('/crf/dashboard/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'admin', password: 'admin' }),
    });
    return { status: response.status, body: await response.text() };
  });
  if (login.status !== 200) throw new Error(`Login failed: ${JSON.stringify(login)}`);

  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/d/tech/tech-stand?orgId=1&from=now-24h&to=now', {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('button[aria-label^="Menu for panel"]', { timeout: 60000 });
  await page.keyboard.press('Escape');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const assistantControls = await page.$$eval('button,a', (items) =>
    items
      .map((item) => ({ text: item.textContent?.trim(), aria: item.getAttribute('aria-label'), title: item.getAttribute('title') }))
      .filter((item) => JSON.stringify(item).toLowerCase().includes('assistant'))
  );

  await page.click('button[aria-label^="Menu for panel"]');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const extensionsRect = await page.evaluate(() => {
    const label = [...document.querySelectorAll('*')].find(
      (node) => node.children.length === 0 && node.textContent?.trim() === 'Extensions'
    );
    if (!label) return null;
    const rect = label.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  if (extensionsRect) await page.mouse.move(extensionsRect.x, extensionsRect.y);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const menuText = await page.evaluate(() => document.body.innerText.slice(-4000));
  if (!menuText.includes('Спросить AI')) {
    await page.screenshot({ path: '/test/ai-assistant-ui-error.png', fullPage: false });
    console.log(JSON.stringify({ assistantControls, errors, menuText }, null, 2));
    throw new Error('Panel menu extension is not visible');
  }
  const itemRect = await page.evaluate(() => {
    const label = [...document.querySelectorAll('*')].find(
      (node) => node.children.length === 0 && node.textContent?.trim() === 'Спросить AI'
    );
    if (!label) return null;
    const rect = label.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  if (!itemRect) throw new Error('Panel menu extension was not clickable');
  await page.mouse.click(itemRect.x, itemRect.y);

  try {
    await page.waitForFunction(() => document.body.innerText.includes('Задайте вопрос по текущему дашборду'), { timeout: 10000 });
  } catch (error) {
    await page.screenshot({ path: '/test/ai-assistant-sidebar-error.png', fullPage: false });
    console.log(JSON.stringify({ errors, failedResponses, body: await page.evaluate(() => document.body.innerText.slice(-4000)) }, null, 2));
    throw error;
  }
  const textarea = await page.waitForSelector('textarea[placeholder*="PromQL"]', { timeout: 10000 });
  await textarea.type('ping from ui');
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Отправить');
    if (!button) throw new Error('Send button not found');
    button.click();
  });
  await page.waitForSelector('[data-testid="tech-ai-send-preview"]', { visible: true, timeout: 10000 });
  await page.click('[data-testid="tech-ai-send-preview"] button');
  await page.waitForFunction(() => document.body.innerText.includes('mock: ping from ui'), { timeout: 15000 });
  await page.screenshot({ path: '/test/ai-assistant-ui.png', fullPage: false });

  console.log(JSON.stringify({ panelMenu: true, assistantOpened: true, chatReply: true, assistantControls, errors }, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
