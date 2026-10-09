const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, timeout: 60000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    await page.setViewport({ width: 1280, height: 650 });
    let imageToTextEnabled = false, truncate = false, originalSettings;
    const requests = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', async request => {
      const pathname = new URL(request.url()).pathname;
      if (originalSettings && pathname.endsWith('/api/plugins/tech-ai-assistant-app/settings') && request.method() === 'GET') {
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...originalSettings, enabled: true, jsonData: { provider: 'custom', apiUrl: 'http://unused', apiPath: '/v1/chat/completions', model: 'test-082', streaming: false, launcherMode: 'both', includePanelData: false, previewBeforeSend: 'never', fileUploadsEnabled: true, imageToTextEnabled, maxTokens: 2048 } }) });
      }
      if (pathname.includes('/api/plugin-proxy/tech-ai-assistant-app/')) {
        const body = JSON.parse(request.postData()); requests.push(body);
        const ocr = body.messages.length === 1;
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: ocr ? 'IMAGE_TRANSCRIPT_082' : 'ANSWER_082' }, finish_reason: ocr && truncate ? 'length' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }) });
      }
      return request.continue();
    });
    await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      const result = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) });
      if (!result.ok) throw new Error('Login: ' + result.status);
    });
    originalSettings = await page.evaluate(async () => (await fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings')).json());
    await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/d/tech/tech-stand?from=now-1h&to=now', { waitUntil: 'domcontentloaded' });
    try { await page.waitForSelector('#tech-ai-assistant-launcher'); }
    catch (error) { console.error(JSON.stringify({ page: await page.title(), errors, body: (await page.$eval('body', node => node.textContent)).slice(0, 1500) })); await page.screenshot({ path: '/test-results/assistant-082-failure.png' }); throw error; }
    const click = async text => page.evaluate(text => {
      const node = [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find(node => node.textContent === text);
      if (!node) throw new Error('Button: ' + text);
      node.click();
    }, text);
    const open = async () => { await page.click('#tech-ai-assistant-launcher'); await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])'); };
    const attach = async () => {
      await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'graph.png', { type: 'image/png' }));
        const input = document.querySelector('[data-testid="tech-ai-file-input"]'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForSelector('[data-testid="tech-ai-attachments"] img');
    };
    const send = async () => { await page.type('#tech-ai-assistant-drawer textarea', 'Explain'); await click('Отправить'); };
    await open(); await attach();
    assert.equal(await page.$('[data-testid="tech-ai-attachment-as-text"]'), null);
    await send();
    await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-history"]')?.textContent.includes('ANSWER_082'));
    assert.equal(requests.length, 1);
    assert.ok(JSON.stringify(requests[0]).includes('data:image/jpeg;base64,'));
    await click('Новый диалог');
    await page.waitForFunction(() => !document.querySelector('[data-testid="tech-ai-history"]')?.textContent.includes('ANSWER_082'));
    await page.click('#tech-ai-assistant-drawer button[title^="Закрыть"]');
    imageToTextEnabled = true;
    await open(); await attach();
    await page.click('[data-testid="tech-ai-attachment-as-text"]');
    await send();
    await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])');
    assert.equal(requests.length, 3);
    assert.equal(requests[1].max_tokens, 2048);
    assert.ok(JSON.stringify(requests[2]).includes('IMAGE_TRANSCRIPT_082'));
    assert.ok(!JSON.stringify(requests[2]).includes('data:image/'));
    await page.click('[data-testid="tech-ai-tab-diag"]');
    assert.ok((await page.$eval('#tech-ai-assistant-drawer', node => node.textContent)).includes('200 ток. промпта, 40 ответа'));
    await click('Новый диалог');
    await page.click('[data-testid="tech-ai-tab-chat"]');
    truncate = true;
    await attach(); await page.click('[data-testid="tech-ai-attachment-as-text"]'); await send();
    await page.waitForFunction(() => document.querySelector('[data-testid="tech-ai-error"]')?.textContent.includes('обрезан лимитом токенов'));
    assert.equal(requests.length, 4);
    assert.ok(!errors.length, errors.join('\n'));
    await page.screenshot({ path: '/test-results/assistant-082.png' });
    console.log('release-082-test=ok; global toggle, original image, OCR usage, truncation, new dialog');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exit(1); });
