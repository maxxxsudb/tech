const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
const answer = '## Краткий вывод\n\nДашборд помогает **сравнить нагрузку и состояние сервисов**. Здесь важны не только значения, но и их изменение во времени.\n\n### На что обратить внимание\n\n- Сопоставьте пики с журналом событий.\n- Проверьте единицы измерения и выбранный период.\n\n| Показатель | Наблюдение | Следующий шаг |\n| --- | --- | --- |\n| Нагрузка | Кратковременный пик | Сравнить с предыдущим периодом |\n| Ошибки | Требуется проверка | Открыть журнал событий |\n\n### Пример запроса\n\n```promql\nsum(rate(http_requests_total[5m]))\n' + '# long query: '.repeat(35) + '\n```\n\n### Следующий шаг\n\nНачните с панели, на которой виден пик. Не меняйте запрос до проверки данных.\n\n' + 'Дополнительное пояснение для проверки прокрутки.\n\n'.repeat(12);
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, timeout: 60000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  let originalSettings, preferences, pendingRequest, fail = false;
  const errors = [];
  try {
    page.setDefaultTimeout(60000);
    await page.setViewport({ width: 1280, height: 720 });
    await page.setRequestInterception(true);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (originalSettings && pathname.endsWith('/api/plugins/tech-ai-assistant-app/settings') && request.method() === 'GET') return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...originalSettings, enabled: true, jsonData: { provider: 'custom', model: 'UI test', apiUrl: 'http://unused', apiPath: '/v1/chat/completions', launcherMode: 'both', includePanelData: false, streaming: false, previewBeforeSend: 'always' } }) });
      if (pathname.includes('/api/plugin-proxy/tech-ai-assistant-app/')) {
        if (fail) return request.respond({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { message: 'DETAILED_BACKEND_ERROR_083' } }) });
        pendingRequest = request;
        return;
      }
      return request.continue();
    });
    await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => { const response = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) }); if (!response.ok) throw new Error('Login failed'); });
    originalSettings = await page.evaluate(async () => (await fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings')).json());
    preferences = await page.evaluate(async () => (await fetch('/crf/dashboard/api/user/preferences')).json());
    const dashboard = 'http://tech-ai-grafana-test:3000/crf/dashboard/d/tech/tech-stand?from=now-1h&to=now';
    await page.goto(dashboard, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tech-ai-assistant-launcher'); await page.click('#tech-ai-assistant-launcher');
    await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])');
    assert.equal(await page.$$eval('[data-testid="tech-ai-welcome"] button', nodes => nodes.length), 3);
    assert.equal(await page.$eval('[data-testid="tech-ai-history"]', node => node.scrollTop), 0);
    assert.ok((await page.$eval('[data-testid="tech-ai-context-strip"]', node => node.textContent)).includes('Последний час'));
    await page.screenshot({ path: '/test-results/assistant-083-start.png' });
    await page.$eval('[data-testid="tech-ai-welcome"] button:nth-of-type(2)', node => node.click());
    await page.waitForSelector('[data-testid="tech-ai-investigation-setup"]');
    const click = text => page.evaluate(text => { const button = [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find(node => node.textContent.trim() === text); if (!button) throw new Error('No button ' + text); button.click(); }, text);
    await click('Отмена');
    await page.$eval('[data-testid="tech-ai-welcome"] button', node => node.click());
    await page.waitForSelector('[data-testid="tech-ai-send-preview"]');
    await page.$eval('[data-testid="tech-ai-send-preview"] button', node => node.click());
    await page.waitForSelector('[data-testid="tech-ai-request-status"]');
    await page.waitForFunction(() => parseInt(document.querySelector('[data-testid="tech-ai-elapsed"]')?.textContent, 10) >= 1);
    assert.ok(await page.$eval('[data-testid="tech-ai-request-status"]', node => node.textContent.includes('Модель готовит ответ')));
    assert.equal(await page.$('[data-testid="tech-ai-welcome"]'), null);
    assert.ok(pendingRequest);
    await pendingRequest.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: answer } }] }) });
    await page.waitForSelector('[data-testid="tech-ai-answer"] table');
    await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])');
    assert.equal(await page.$('[data-testid="tech-ai-request-status"]'), null);
    assert.ok(await page.$('[data-testid="tech-ai-answer"] h2'));
    assert.ok(await page.$('[data-testid="tech-ai-answer"] li'));
    await page.click('[data-testid="tech-ai-copy-code"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-copy-code"]')?.textContent === 'Скопировано');
    const layout = () => page.evaluate(() => {
      const drawer = document.querySelector('#tech-ai-assistant-drawer').getBoundingClientRect();
      const input = document.querySelector('#tech-ai-assistant-drawer textarea').getBoundingClientRect();
      const history = document.querySelector('[data-testid="tech-ai-history"]');
      const pre = document.querySelector('[data-testid="tech-ai-code"] pre');
      return { inside: drawer.left >= 0 && drawer.right <= innerWidth && input.bottom <= innerHeight, scroll: history.scrollHeight > history.clientHeight, codeScroll: pre.scrollWidth > pre.clientWidth, width: drawer.width };
    });
    for (const viewport of [{ width: 1280, height: 720 }, { width: 1280, height: 650 }, { width: 360, height: 740 }]) {
      await page.setViewport(viewport);
      const state = await layout(); assert.ok(state.inside && state.scroll && state.codeScroll, JSON.stringify({ viewport, state }));
    }
    await page.setViewport({ width: 1280, height: 720 });
    await page.$eval('[data-testid="tech-ai-history"]', node => { node.scrollTop = 0; });
    await page.screenshot({ path: '/test-results/assistant-083-dark.png' });
    await page.evaluate(async () => { const result = await fetch('/crf/dashboard/api/user/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: 'light' }) }); if (!result.ok) throw new Error('Theme failed'); });
    await page.goto(dashboard, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tech-ai-assistant-launcher'); await page.click('#tech-ai-assistant-launcher');
    await page.waitForSelector('[data-testid="tech-ai-answer"] table');
    await page.$eval('[data-testid="tech-ai-history"]', node => { node.scrollTop = 0; });
    await page.screenshot({ path: '/test-results/assistant-083-light.png' });
    assert.ok((await layout()).inside);
    await click('Новый диалог'); fail = true;
    await page.type('#tech-ai-assistant-drawer textarea', 'Test error'); await click('Отправить');
    await page.waitForSelector('[data-testid="tech-ai-send-preview"]'); await page.$eval('[data-testid="tech-ai-send-preview"] button', node => node.click());
    await page.waitForSelector('[data-testid="tech-ai-error"]');
    assert.equal(await page.$eval('[data-testid="tech-ai-error-details"]', node => node.open), false);
    assert.ok((await page.$eval('[data-testid="tech-ai-error"]', node => node.textContent)).includes('API не ответил'));
    await page.$eval('[data-testid="tech-ai-error-details"]', node => { node.open = true; });
    assert.ok((await page.$eval('[data-testid="tech-ai-error-details"]', node => node.textContent)).includes('DETAILED_BACKEND_ERROR_083'));
    assert.ok(!errors.length, errors.join('\n'));
    console.log('release-083-test=ok; welcome, context, timer, Markdown/table/code copy, layout, light/dark, collapsed error');
  } finally {
    if (preferences && !page.isClosed()) await page.evaluate(preferences => fetch('/crf/dashboard/api/user/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(preferences) }), preferences);
    await browser.close();
  }
})().catch(error => { console.error(error.stack); process.exit(1); });
