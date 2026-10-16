const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const source = path.resolve(__dirname, '../plugin');
const target = process.env.PROTECTED_TEST_DIR;
if (!target) throw new Error('PROTECTED_TEST_DIR is required');
const original = Module._extensions['.js'];
Module._extensions['.js'] = (module, filename) => {
  if (path.dirname(filename) === source) {
    const originalDefine = global.define;
    if (path.basename(filename) === 'module.js' && originalDefine) {
      const originalDeps = ['@grafana/data', '@grafana/runtime', 'react', 'react-dom', './attachments', './conversation', './query-tools', 'react-dom/client'];
      global.define = (deps, factory) => originalDefine(originalDeps, (...args) => factory(...deps.map(dependency => args[originalDeps.indexOf(dependency)])));
    }
    try { return module._compile(fs.readFileSync(path.join(target, path.basename(filename)), 'utf8'), filename); }
    finally { if (originalDefine) global.define = originalDefine; }
  }
  return original(module, filename);
};
