const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const response = await fetch('/crf/dashboard/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'admin', password: 'admin' }),
    });
    if (!response.ok) throw new Error(`Login failed: ${response.status}`);
  });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/d/tech/tech-stand?orgId=1', { waitUntil: 'domcontentloaded' });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (process.env.EXPECT_NO_LAUNCHER === '1' && await page.$('#tech-ai-assistant-launcher')) throw new Error('Floating launcher is visible in commandPalette mode');
  const search = await page.$('input[placeholder="Search..."]');
  if (search) await search.click();
  else {
    await page.keyboard.down('Control');
    await page.keyboard.press('k');
    await page.keyboard.up('Control');
  }
  await page.keyboard.type('Tech AI Assistant');
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const paletteText = await page.evaluate(() => document.body.innerText);
  await page.screenshot({ path: '/test/command-palette-success.png', fullPage: false });
  console.log(`palette=${paletteText.slice(0, 4000)}`);
  if (!paletteText.includes('Открыть Tech AI Assistant')) throw new Error('Command Palette action is missing');

  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/explore', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('Explore'), { timeout: 30000 });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const controls = await page.evaluate(() => [...document.querySelectorAll('button,a')].map((item) => ({
    text: item.textContent.trim(),
    aria: item.getAttribute('aria-label'),
    title: item.getAttribute('title'),
  })).filter((item) => item.text || item.aria || item.title));
  const addControl = controls.find((item) => item.text === 'Add' || item.aria === 'Add' || item.title === 'Add');
  if (addControl) {
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('button,a')].find((node) => node.textContent.trim() === 'Add' || node.getAttribute('aria-label') === 'Add' || node.getAttribute('title') === 'Add');
      if (item) item.click();
    });
    await page.waitForFunction(() => document.body.innerText.includes('Спросить AI'), { timeout: 10000 });
  }
  await page.screenshot({ path: '/test/explore-entry-success.png', fullPage: false });
  const hasExploreAction = await page.evaluate(() => document.body.innerText.includes('Спросить AI'));
  console.log(JSON.stringify({ addControl, hasExploreAction, controls: controls.slice(0, 40) }));
  if (!hasExploreAction) throw new Error('Explore AI action is missing');
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
