const fs = require('node:fs');
const puppeteer = require('puppeteer');
const candidate = JSON.parse(fs.readFileSync(0, 'utf8'));
const root = 'http://tech-ai-grafana-test:3000/crf/dashboard';
const uid = `tech-ai-review-${Date.now().toString(36)}`;
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const setup = await browser.newPage();
  let created = false;
  try {
    await setup.goto(`${root}/login`);
    await setup.evaluate(async uid => {
      await fetch('/crf/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'admin' }) });
      const response = await fetch('/crf/dashboard/api/dashboards/db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dashboard: { uid, title: 'Candidate review', schemaVersion: 41, panels: [{ id: 1, title: 'CPU', type: 'text', targets: [], options: { mode: 'markdown', content: 'Test' }, gridPos: { x: 0, y: 0, w: 24, h: 8 } }] }, overwrite: false }) });
      if (!response.ok) throw new Error('Create failed');
    }, uid);
    created = true;
    const settings = await setup.evaluate(async () => (await fetch('/crf/dashboard/api/plugins/tech-ai-assistant-app/settings')).json());
    for (const version of ['0.8.8', '0.9.0']) {
      const page = await browser.newPage();
      page.setDefaultTimeout(30000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setRequestInterception(true);
      page.on('request', request => {
        const path = new URL(request.url()).pathname;
        const file = path.split('/').pop();
        if (version === '0.9.0' && path.includes('/public/plugins/tech-ai-assistant-app/') && candidate[file]) return request.respond({ status: 200, contentType: file.endsWith('.json') ? 'application/json' : 'application/javascript', body: candidate[file] });
        if (path.endsWith('/api/plugins/tech-ai-assistant-app/settings')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...settings, jsonData: { provider: 'custom', model: 'UI mock', includePanelData: false, screenshotEnabled: true, streaming: false, launcherMode: 'both', previewBeforeSend: 'always' } }) });
        if (path.includes('/api/plugin-proxy/tech-ai-assistant-app/')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '## Объяснение\n\n' + 'Одинаковый ответ для проверки места под текст.\n\n'.repeat(18) } }] }) });
        return request.continue();
      });
      await page.setViewport({ width: 1280, height: 650 });
      await page.goto(`${root}/d/${uid}/review?from=now-1h&to=now`, { waitUntil: 'networkidle2' });
      const runtime = await page.evaluate(async () => {
        const r = await System.import('@grafana/runtime');
        return { getDashboardSrv: typeof r.getDashboardSrv, getDataSourceSrv: typeof r.getDataSourceSrv };
      });
      console.log(JSON.stringify({ version, runtime }));
      await page.waitForSelector('#tech-ai-assistant-launcher');
      await page.click('#tech-ai-assistant-launcher');
      await page.waitForSelector('#tech-ai-assistant-drawer textarea:not([disabled])');
      await page.type('#tech-ai-assistant-drawer textarea', 'Объясни CPU');
      await page.evaluate(() => [...document.querySelectorAll('#tech-ai-assistant-drawer button')].find(node => node.textContent.trim() === 'Отправить').click());
      await page.waitForSelector('[data-testid="tech-ai-send-preview"]');
      await page.$eval('[data-testid="tech-ai-send-preview"] button', node => node.click());
      await page.waitForSelector('[data-testid="tech-ai-answer"]');
      for (const width of [1280, 360]) {
        await page.setViewport({ width, height: width === 1280 ? 650 : 740 });
        const dimensions = await page.evaluate(() => {
          const root = document.querySelector('.tech-ai-root');
          const history = document.querySelector('[data-testid="tech-ai-history"]');
          return { history: history.clientHeight, footer: Math.round(root.lastElementChild.getBoundingClientRect().height), overflow: root.scrollWidth > root.clientWidth + 2 };
        });
        console.log(JSON.stringify({ version, width, ...dimensions, errors }));
        await page.screenshot({ path: `/test-results/review-${version}-${width}.png` });
      }
      await page.close();
    }
  } finally {
    try { if (created) await setup.evaluate(uid => fetch(`/crf/dashboard/api/dashboards/uid/${uid}`, { method: 'DELETE' }), uid); }
    finally { await browser.close(); }
  }
})().catch(error => { console.error(error.stack); process.exit(1); });
