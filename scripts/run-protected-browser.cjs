const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const allowed = new Set(['verify-088.js', 'verify-090.js', 'verify-092.js']);
const name = process.argv[2];
if (!allowed.has(name)) throw new Error('Unknown browser case');
const filename = path.resolve(__dirname, '../test', name);
const browser = process.env.BROWSER_EXECUTABLE || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : '/usr/bin/chromium');
const screenshots = path.resolve(__dirname, '../test-results/protected').replace(/\\/g, '/');
fs.mkdirSync(screenshots, { recursive: true });
const source = fs.readFileSync(filename, 'utf8')
  .replace("require('puppeteer')", "require('puppeteer-core')")
  .replaceAll('http://tech-ai-grafana-test:3000/crf/dashboard', 'http://localhost:3300/crf/dashboard')
  .replace("executablePath: '/usr/bin/chromium'", 'executablePath: ' + JSON.stringify(browser))
  .replaceAll('/test-results/', screenshots + '/');
const loaded = new Module(filename);
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(source, filename);
