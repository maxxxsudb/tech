const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const name = process.argv[2];
if (!/^verify-[a-z0-9-]+\.js$/.test(name || '')) throw Error('Expected a verify-*.js case');
const filename = path.resolve(__dirname, '../test', name);
if (!fs.existsSync(filename)) throw Error('Unknown browser case: ' + name);
const root = process.env.GRAFANA_TEST_URL || 'http://localhost:3300/crf/dashboard';
const browser = process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const screenshots = path.resolve(__dirname, '../test-results/grafana-13.2.2').replace(/\\/g, '/');
fs.mkdirSync(screenshots, { recursive: true });
const source = fs.readFileSync(filename, 'utf8')
  .replaceAll("require('puppeteer')", "require('puppeteer-core')")
  .replaceAll('http://tech-ai-grafana-test:3000/crf/dashboard', root)
  .replaceAll('http://localhost:3000/crf/dashboard', root)
  .replaceAll("executablePath: '/usr/bin/chromium'", 'executablePath: ' + JSON.stringify(browser))
  .replaceAll('/test-results/', screenshots + '/')
  .replaceAll('/test/', screenshots + '/');
const loaded = new Module(filename);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(source, filename);
