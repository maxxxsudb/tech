const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.goto('http://tech-ai-grafana-test:3000/crf/dashboard/login', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const login = await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) });
    if (!login.ok) throw new Error(`Login failed: ${login.status}`);
    const settings = await fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings').then((item) => item.json());
    const json = settings.jsonData || {};
    const route = json.provider === 'groq' ? 'groq-chat' : (json.useAuth === false ? 'chat' : 'chat-auth');
    const model = json.provider === 'groq' ? json.groqModel : json.model;
    const started = performance.now();
    const response = await fetch(`/crf/dashboard/api/plugin-proxy/tech-ai-assistant-app/${route}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ model, stream: true, max_tokens: 1400, messages: [{ role: 'user', content: 'Напиши связный технический текст примерно на 900 слов о мониторинге распределённых систем. Не сокращай ответ.' }] }),
    });
    if (!response.ok) throw new Error(`Proxy failed: ${response.status} ${await response.text()}`);
    const reader = response.body.getReader();
    let chunks = 0;
    let bytes = 0;
    let text = '';
    let firstChunkMs;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      chunks += 1;
      bytes += item.value.length;
      text += new TextDecoder().decode(item.value);
      if (firstChunkMs === undefined) firstChunkMs = performance.now() - started;
    }
    const events = (text.match(/\ndata:\s*\{/g) || []).length + (text.startsWith('data: {') ? 1 : 0);
    return { chunks, events, bytes, firstChunkMs, totalMs: performance.now() - started, contentType: response.headers.get('content-type') };
  });
  console.log(JSON.stringify(result));
  if (!result.contentType.includes('text/event-stream')) throw new Error(`Not SSE: ${result.contentType}`);
  if (result.events < 2 || result.bytes < 20) throw new Error(`SSE response is empty: ${JSON.stringify(result)}`);
  if (result.chunks < 2 && result.totalMs - result.firstChunkMs > 100) throw new Error(`Stream was buffered: ${JSON.stringify(result)}`);
  await browser.close();
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
