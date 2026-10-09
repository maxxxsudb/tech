const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, timeout: 60000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  let settings, panel;
  const errors = [];
  try {
    page.setDefaultTimeout(60000);
    await page.setViewport({ width: 1280, height: 720 });
    await page.setRequestInterception(true);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (settings && path.endsWith('/api/plugins/tech-ai-assistant-app/settings') && request.method() === 'GET') {
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...settings, enabled: true, jsonData: { provider: 'custom', model: 'UI 084 test', apiUrl: 'http://unused', apiPath: '/v1/chat/completions', launcherMode: 'both', includePanelData: false, streaming: false, previewBeforeSend: 'never' } }) });
      }
      if (path.includes('/api/plugin-proxy/tech-ai-assistant-app/')) {
        const answer = `## Проверка навигации\n\nПосмотрите **${panel.title}** и панель ${panel.id}.\n\n\`${panel.title}\` — пример кода, не ссылка.\n\n[Существующая ссылка](https://example.com) и панель 987654 не меняются.`;
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: answer } }] }) });
      }
      return request.continue();
    });
    await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      const response = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) });
      if (!response.ok) throw new Error('Login failed');
    });
    settings = await page.evaluate(async () => (await fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings')).json());
    panel = await page.evaluate(async () => {
      const response = await (await fetch('/crf/dashboard/api/dashboards/uid/tech')).json();
      const flatten = panels => panels.flatMap(panel => panel.type === 'row' ? flatten(panel.panels || []) : [panel]);
      return flatten(response.dashboard.panels).find(panel => panel.title && panel.id != null);
    });
    assert.ok(panel, 'Real dashboard panel required');
    await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/d/tech/tech-stand?from=now-1h&to=now', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tech-ai-assistant-launcher');
    await page.click('#tech-ai-assistant-launcher');
    await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])');
    const click = text => page.evaluate(text => {
      const button = [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find(node => node.textContent.trim() === text);
      if (!button) throw new Error('No button ' + text);
      button.click();
    }, text);
    await page.type('#tech-ai-assistant-drawer textarea', 'Покажи панель');
    await click('Отправить');
    await page.waitForSelector('[data-testid="tech-ai-answer"] .tech-ai-panel-link');
    assert.equal(await page.$$eval('[data-testid="tech-ai-answer"] .tech-ai-panel-link', nodes => nodes.length), 2);
    assert.equal(await page.$('[data-testid="tech-ai-answer"] code a'), null);
    assert.equal(await page.$('[data-testid="tech-ai-answer"] a[data-panel-id="987654"]'), null);
    await page.click('[data-testid="tech-ai-expand"]');
    assert.equal(await page.$eval('#tech-ai-assistant-drawer', node => node.style.width), '100vw');
    const before = page.url();
    await page.click('[data-testid="tech-ai-answer"] .tech-ai-panel-link');
    await page.waitForSelector('.tech-ai-panel-highlight');
    assert.equal(page.url(), before, 'Rendered panel must not trigger navigation');
    assert.notEqual(await page.$eval('#tech-ai-assistant-drawer', node => node.style.width), '100vw');
    assert.ok(await page.$eval('.tech-ai-panel-highlight', (node, title) => node.textContent.includes(title), panel.title));
    await page.screenshot({ path: '/test-results/assistant-084-panel-link.png' });
    await page.waitForFunction(() => !document.querySelector('.tech-ai-panel-highlight'));
    await page.setViewport({ width: 360, height: 740 });
    assert.ok(await page.$eval('#tech-ai-assistant-drawer', node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; }));
    assert.ok(await page.$eval('[data-testid="tech-ai-user-turn"]', node => node.querySelector('button').textContent.includes('Изменить')));
    assert.ok(!errors.length, errors.join('\n'));
    console.log('release-084-test=ok; real panel title/id links, code exclusion, focus/highlight, fullscreen exit, mobile, quiet actions');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.stack); process.exit(1); });
