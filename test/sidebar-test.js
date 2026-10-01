const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
  const login = await page.evaluate(async () => {
    const response = await fetch('/crf/dashboard/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'admin', password: 'admin' }),
    });
    return response.status;
  });
  if (login !== 200) throw new Error(`Login failed: ${login}`);
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/d/tech/tech-stand?orgId=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[aria-label^="Menu for panel"]', { timeout: 60000 });
  await page.keyboard.press('Escape');
  await new Promise((resolve) => setTimeout(resolve, 800));

  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          text: button.textContent?.trim(),
          aria: button.getAttribute('aria-label'),
          title: button.getAttribute('title'),
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          left: rect.left,
          visible: rect.width > 0 && rect.height > 0,
        };
      })
      .filter((button) => button.visible && button.left > window.innerWidth - 80 && button.y > 90 && button.y < 400)
  );
  const candidate = buttons.at(-1);
  if (!candidate) throw new Error(`Sidebar button not found: ${JSON.stringify(buttons)}`);
  console.log(JSON.stringify({ candidate, buttons }, null, 2));
  await page.mouse.click(candidate.x, candidate.y);
  await page.waitForFunction(() => document.body.innerText.includes('Задайте вопрос по текущему дашборду'), { timeout: 10000 });
  await page.screenshot({ path: '/test/ai-assistant-sidebar.png', fullPage: false });
  console.log(JSON.stringify({ sidebarOpened: true, candidate, buttons }, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
