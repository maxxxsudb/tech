const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  let proxyCalls = 0;
  let toolResultReturned = false;
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (!request.url().includes('/api/plugin-proxy/tech-ai-assistant-app/')) return request.continue();
    proxyCalls += 1;
    const body = JSON.parse(request.postData() || '{}');
    if (proxyCalls === 1) {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_test', type: 'function', function: { name: 'query_grafana_datasource', arguments: JSON.stringify({ datasourceUid: 'loki', reason: 'Проверить наличие логов', query: { expr: '{service_name="keycloak"}', refId: 'AI' } }) } }] } }] }),
      });
    } else {
      toolResultReturned = body.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_test' && message.content.includes('datasource'));
      request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'TOOL RESULT RECEIVED' } }] }) });
    }
  });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const response = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) });
    if (!response.ok) throw new Error(`Login failed: ${response.status}`);
  });
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/d/tech/tech-stand?orgId=1&from=now-1h&to=now', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tech-ai-assistant-launcher', { visible: true, timeout: 30000 });
  await page.click('#tech-ai-assistant-launcher');
  await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])', { visible: true, timeout: 30000 });
  await page.evaluate(() => {
    const drawer = document.querySelector('#tech-ai-assistant-drawer');
    [...drawer.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Расследовать').click();
  });
  await page.waitForFunction(() => document.querySelector('#tech-ai-assistant-drawer').innerText.includes('TOOL RESULT RECEIVED'), { timeout: 60000 });
  if (proxyCalls !== 2 || !toolResultReturned) throw new Error(`Tool loop failed: calls=${proxyCalls}, returned=${toolResultReturned}`);
  console.log('investigation-tool-test=ok');
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
