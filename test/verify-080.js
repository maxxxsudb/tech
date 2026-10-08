const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, timeout: 60000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  let originalSettings;
  let page;
  try {
    page = await browser.newPage();
    page.setDefaultTimeout(60000);
    await page.setViewport({ width: 1280, height: 650 });
    const requests = [];
    let datasourceCalls = 0;
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/api/ds/query') && !new URL(request.url()).search) datasourceCalls++;
      if (!request.url().includes('/api/plugin-proxy/tech-ai-assistant-app/')) return request.continue();
      requests.push(JSON.parse(request.postData()));
      request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: `RELEASE080-${requests.length}\n` + 'Длинный ответ для проверки прокрутки.\n'.repeat(35) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }) });
    });
    await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      const login = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) });
      if (!login.ok) throw new Error(`Login failed: ${login.status}`);
    });
    originalSettings = await page.evaluate(async () => {
      const url = '/crf/dashboard/api/plugins/tech-ai-assistant-app/settings';
      const original = await (await fetch(url)).json();
      const changed = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, jsonData: { ...original.jsonData, streaming: false, imageTransport: 'openaiDataUri' } }) });
      if (!changed.ok) throw new Error(`Plugin setup failed: ${changed.status}`);
      return { enabled: original.enabled, pinned: original.pinned, jsonData: original.jsonData };
    });
    await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/d/tech/tech-stand?from=now-6h&to=now', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tech-ai-assistant-launcher', { visible: true });
    await page.click('#tech-ai-assistant-launcher');
    await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])', { visible: true });
    await page.waitForNetworkIdle({ idleTime: 750, timeout: 30000 });
    const clickText = async (text) => page.evaluate((text) => {
      const button = [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find((button) => button.textContent.trim() === text);
      if (!button) throw new Error(`No button ${text}`);
      button.click();
    }, text);
    const waitAnswer = async (number) => {
      await page.waitForFunction((number) => document.querySelector('[data-testid="tech-ai-history"]')?.innerText.includes(`RELEASE080-${number}`), {}, number);
      await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])');
    };
    const confirmSend = async () => {
      await page.waitForSelector('[data-testid="tech-ai-send-preview"]', { visible: true });
      await page.$eval('[data-testid="tech-ai-send-preview"] button', (node) => node.click());
    };
    const contextOf = (body) => {
      const strings = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === 'text').map((part) => part.text) : [message.content || '']);
      for (const text of strings) {
        const document = /Файл: grafana-context.json\n```json\n([\s\S]*?)\n```/.exec(text);
        if (document) return JSON.parse(document[1]);
        const inline = /Текущий контекст Grafana:\n([\s\S]+)$/.exec(text);
        if (inline) return JSON.parse(inline[1]);
      }
      throw new Error('Context missing');
    };
    await page.$eval('[data-testid="tech-ai-actions-panel"]', (node) => { node.open = true; });
    await clickText('Объяснить');
    await page.waitForSelector('[data-testid="tech-ai-send-preview"]');
    assert.ok((await page.$eval('[data-testid="tech-ai-send-preview"]', (node) => node.textContent)).includes('HTTP-запросов'));
    await page.select('[data-testid="tech-ai-data-mode"]', 'structure');
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['SAMPLE_LOG_080\nline2'], 'sample.log', { type: 'text/plain' }));
      const input = document.querySelector('[data-testid="tech-ai-file-input"]');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForSelector('[data-testid="tech-ai-attachments"]');
    await clickText('Объяснить');
    await page.select('[data-testid="tech-ai-data-mode"]', 'structure');
    const beforeStructure = datasourceCalls;
    await confirmSend();
    await waitAnswer(1);
    assert.ok(JSON.stringify(requests[0]).includes('SAMPLE_LOG_080'));
    assert.equal(contextOf(requests[0]).panelData, undefined);
    assert.equal(datasourceCalls, beforeStructure);
    assert.equal(requests[0].stream, false);
    await page.$eval('[data-testid="tech-ai-edit-message"]', (node) => node.click());
    await page.$eval('#tech-ai-assistant-drawer textarea', (node) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(node, 'EDITED_080'); node.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickText('Отправить');
    await confirmSend();
    await waitAnswer(2);
    assert.ok(JSON.stringify(requests[1]).includes('EDITED_080') && JSON.stringify(requests[1]).includes('SAMPLE_LOG_080'));
    assert.ok(!JSON.stringify(requests[1]).includes('RELEASE080-1'));
    await page.$eval('[data-testid="tech-ai-regenerate"]', (node) => node.click());
    await confirmSend();
    await waitAnswer(3);
    assert.ok(!JSON.stringify(requests[2]).includes('RELEASE080-2'));
    await page.$eval('[data-testid="tech-ai-continue"]', (node) => node.click());
    await confirmSend();
    await waitAnswer(4);
    assert.ok(JSON.stringify(requests[3]).includes('RELEASE080-3'));
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 120, 80);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'chart.png', { type: 'image/png' }));
      document.querySelector('#tech-ai-assistant-drawer textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    await page.waitForSelector('[data-testid="tech-ai-attachments"] img');
    await page.type('#tech-ai-assistant-drawer textarea', 'IMAGE_080');
    await clickText('Отправить');
    await confirmSend();
    await waitAnswer(5);
    const final = requests[4].messages.at(-1);
    assert.ok(Array.isArray(final.content) && final.content.some((part) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/jpeg;base64,')));
    assert.ok(final.content.some((part) => part.type === 'text' && part.text.includes('IMAGE_080')));
    const saved = await page.evaluate(() => sessionStorage.getItem('tech-ai-chat:tech'));
    assert.ok(!saved.includes('data:image/'));
    await page.evaluate(() => document.querySelector('[data-testid="tech-ai-actions-panel"]').open = true);
    await clickText('Сравнить периоды');
    await page.waitForSelector('[data-testid="tech-ai-investigation-setup"]');
    const setupText = await page.$eval('[data-testid="tech-ai-investigation-setup"]', (node) => node.textContent);
    assert.ok(setupText.includes('Предыдущий период:') && setupText.includes('6 HTTP'));
    await clickText('Начать расследование');
    await waitAnswer(6);
    const compared = contextOf(requests[5]);
    assert.ok(compared.panelData.length && compared.comparisonPanelData.length);
    assert.equal(compared.comparisonPanelDataRange.to, compared.panelDataRange.from);
    assert.equal(Date.parse(compared.comparisonPanelDataRange.to) - Date.parse(compared.comparisonPanelDataRange.from), Date.parse(compared.panelDataRange.to) - Date.parse(compared.panelDataRange.from));
    for (const light of [false, true]) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: light ? 'light' : 'dark' }]);
      const layout = await page.evaluate(() => {
        const history = document.querySelector('[data-testid="tech-ai-history"]'); history.scrollTop = 0; history.scrollTop = history.scrollHeight;
        const drawer = document.querySelector('#tech-ai-assistant-drawer').getBoundingClientRect();
        const close = document.querySelector('#tech-ai-assistant-drawer button[title^="Закрыть"]').getBoundingClientRect();
        const composer = document.querySelector('#tech-ai-assistant-drawer textarea').getBoundingClientRect();
        return { inside: drawer.right <= innerWidth && drawer.left >= 0 && close.right <= innerWidth && composer.bottom <= innerHeight, scroll: history.scrollTop > 0, height: history.clientHeight };
      });
      assert.ok(layout.inside && layout.scroll && layout.height > 30, JSON.stringify(layout));
    }
    await page.evaluate(() => {
      const controls = document.querySelector('[data-testid="tech-ai-controls"]'); controls.scrollTop = controls.scrollHeight;
    });
    await page.screenshot({ path: '/test-results/assistant-080-ui.png' });
    assert.ok(!pageErrors.some((text) => /attachments|conversation|query-tools|TypeError/.test(text)), pageErrors.join('\n'));
    console.log(`release-080-test=ok; modelRequests=${requests.length}; verified structure, text/image files, edit, regenerate, continue, comparison, scrolling`);
  } finally {
    if (originalSettings && page && !page.isClosed()) await page.evaluate((settings) => fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) }), originalSettings);
    await browser.close();
  }
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
