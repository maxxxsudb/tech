const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const acorn = require('acorn');
const files = ['attachments.js', 'conversation.js', 'query-tools.js', 'module.js'];
function load(directory) {
  const modules = {}, dependencies = {}, records = [];
  class AppPlugin {}
  for (const method of ['setRootPage', 'addConfigPage', 'addComponent', 'addLink']) AppPlugin.prototype[method] = function (...args) { records.push({ method, args }); return this; };
  const context = vm.createContext({ console, URL, URLSearchParams, AbortController, TextDecoder, TextEncoder });
  const imports = {
    '@grafana/data': { AppPlugin, BusEventWithPayload: class {} },
    '@grafana/runtime': { config: { appSubUrl: '/crf/dashboard', bootData: { user: { orgId: 1, orgRole: 'Admin' } } } },
    react: { createElement: () => null, memo: component => component },
    'react-dom': {}, 'react-dom/client': {},
  };
  for (const name of files.filter(name => fs.existsSync(path.join(directory, name)))) {
    let registration;
    context.define = (deps, factory) => { registration = { deps, factory }; };
    const code = fs.readFileSync(path.join(directory, name), 'utf8');
    new vm.Script(code, { filename: name }).runInContext(context, { timeout: 10000 });
    assert.ok(registration, 'Missing AMD registration: ' + name);
    dependencies[name] = [...registration.deps];
    modules[name] = registration.factory(...registration.deps.map(dependency => {
      if (dependency.startsWith('./')) return modules[dependency.slice(2) + '.js'];
      assert.ok(dependency in imports, 'Unknown external dependency: ' + dependency);
      return imports[dependency];
    }));
  }
  return { modules, dependencies, registration: JSON.parse(JSON.stringify(records, (_key, value) => typeof value === 'function' ? '<function>' : value)) };
}
function verify(source, output) {
  const baseline = load(source), result = load(output);
  assert.deepEqual(result.dependencies['module.js'], baseline.dependencies['module.js'].filter(name => !name.startsWith('./')), 'External AMD dependencies changed');
  assert.deepEqual(result.registration, baseline.registration, 'Grafana registration changed');
  assert.deepEqual(Object.keys(result.modules['module.js']), ['plugin'], 'Test hooks leaked into delivery');
  for (const name of ['module.js']) {
    const code = fs.readFileSync(path.join(output, name), 'utf8');
    assert.ok(!/sourceMappingURL|sourceURL=/.test(code), 'Source map/source URL leaked: ' + name);
    const ast = acorn.parse(code, { ecmaVersion: 'latest' });
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (['CallExpression', 'NewExpression'].includes(node.type) && node.callee.type === 'Identifier') assert.ok(!['eval', 'Function'].includes(node.callee.name), 'Unsafe dynamic evaluation: ' + name);
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
    }
    walk(ast);
  }
  const median = directory => {
    const times = [];
    for (let i = 0; i < 5; i++) { const start = performance.now(); load(directory); times.push(performance.now() - start); }
    return times.sort((a, b) => a - b)[2];
  };
  const plainMs = median(source), protectedMs = median(output);
  console.log(`[protect] AMD/contracts/exports/CSP checks: PASS; cold VM median source=${plainMs.toFixed(1)}ms, protected=${protectedMs.toFixed(1)}ms`);
  assert.ok(protectedMs < Math.max(plainMs * 15, 500), 'Protected module initialization exceeds local performance budget');
  return { plainMs, protectedMs };
}
module.exports = { verify, load };
