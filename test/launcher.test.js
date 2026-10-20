const test = require('node:test');
const assert = require('node:assert/strict');

function setup(dom = {}, client = {}) {
  let factory, dependencies;
  global.define = (deps, fn) => { dependencies = deps; factory = fn; };
  delete require.cache[require.resolve('../plugin/module.js')];
  require('../plugin/module.js');
  delete global.define;
  const nodes = [], alerts = [], links = [];
  const makeNode = () => ({ style: {}, children: [], setAttribute() {}, addEventListener() {}, appendChild(child) { this.children.push(child); }, remove() { this.removed = true; } });
  global.document = {
    readyState: 'loading', addEventListener() {}, body: makeNode(),
    createTextNode: text => ({ text }),
    createElement() { const node = makeNode(); nodes.push(node); return node; },
    getElementById: id => nodes.find(node => node.id === id && !node.removed),
  };
  global.window = { alert: text => alerts.push(text) };
  class AppPlugin {
    setRootPage() { return this; } addConfigPage() { return this; } addComponent() { return this; }
    addLink(value) { links.push(value); return this; }
  }
  const api = factory({ AppPlugin }, { config: {} }, { createElement: (type, props) => ({ type, props }) }, dom, {}, {}, {}, client).__launcher;
  return { ...api, alerts, links, dependencies, document: global.document };
}
test.afterEach(() => { delete global.document; delete global.window; });

test('React 19: createRoot берётся из react-dom/client, не из legacy react-dom', () => {
  const calls = [];
  const api = setup({ createRoot() { throw new Error('Legacy export must not be used'); } }, { createRoot: container => ({ render: value => calls.push([container, value]), unmount: () => calls.push('unmount') }) });
  assert.ok(api.dependencies.includes('react-dom/client'));
  assert.equal(api.canMountReact(), true);
  const unmount = api.mountReact('container', 'assistant'); unmount();
  assert.deepEqual(calls, [['container', 'assistant'], 'unmount']);
});

test('старый renderer остаётся рабочим, если client-мок отсутствует', () => {
  const calls = [];
  const api = setup({ render: (element, container) => calls.push([element, container]), unmountComponentAtNode: container => calls.push(container) });
  assert.equal(api.canMountReact(), true);
  api.mountReact('container', 'assistant')();
  assert.deepEqual(calls, [['assistant', 'container'], 'container']);
});

test('drawer открывается один раз с контекстом и корректно размонтируется', () => {
  let roots = 0, unmounts = 0, rendered;
  const api = setup({}, { createRoot: () => { roots++; return { render: element => { rendered = element; }, unmount: () => unmounts++ }; } });
  const context = { panelId: 3 };
  api.openAssistant(context); api.openAssistant(context);
  assert.equal(roots, 1); assert.deepEqual(rendered.props.initialContext, context);
  assert.ok(api.document.getElementById('tech-ai-assistant-drawer'));
  api.closeDrawer(); assert.equal(unmounts, 1);
  assert.equal(api.document.getElementById('tech-ai-assistant-drawer'), undefined);
});

test('ошибка монтирования удаляет пустую панель, а отсутствие renderer видно пользователю', () => {
  const broken = setup({}, { createRoot() { throw new Error('Mount failed'); } });
  assert.throws(() => broken.openDrawer(), /Mount failed/);
  assert.equal(broken.document.getElementById('tech-ai-assistant-drawer'), undefined);
  const missing = setup(); const original = console.error; console.error = () => {};
  try { missing.openAssistant(); } finally { console.error = original; }
  assert.equal(missing.alerts.length, 1); assert.match(missing.alerts[0], /renderer/);
});

test('командная палитра и Explore открывают наш drawer, без приватного sidebar event', () => {
  let roots = 0;
  const api = setup({}, { createRoot: () => { roots++; return { render() {}, unmount() {} }; } });
  for (const target of ['grafana/commandpalette/action', 'grafana/explore/toolbar/action']) {
    api.links.find(link => link.targets.includes(target)).onClick(null, { context: { panelId: 1 } });
    assert.ok(api.document.getElementById('tech-ai-assistant-drawer'));
    api.closeDrawer();
  }
  assert.equal(roots, 2);
});

test('меню панели открывает общий drawer и обновляет контекст уже открытого drawer', () => {
  let roots = 0, unmounts = 0, rendered;
  const api = setup({}, { createRoot: () => { roots++; return { render(value) { rendered = value; }, unmount() { unmounts++; } }; } });
  api.openAssistant();
  const context = { panelId: 7 };
  const link = api.links.find(item => item.targets.includes('grafana/dashboard/panel/menu'));
  link.onClick(null, { context, openModal() { throw Error('must use drawer'); } });
  assert.equal(roots, 2); assert.equal(unmounts, 1); assert.equal(rendered.props.initialContext.panelId, 7);
  api.closeDrawer();
});
