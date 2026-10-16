const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripPrivateExports } = require('../scripts/protect.cjs');
const { bundle } = require('../scripts/bundle-private.cjs');
test('поставка удаляет только private hooks, сохраняя plugin и исполняемый код', () => {
  const input = 'const n=2;({plugin:n,__test:{n},__features:{x:1},__context:{},__launcher:{}})';
  const output = stripPrivateExports(input);
  assert.equal(vm.runInNewContext(output).plugin, 2);
  assert.deepEqual(Object.keys(vm.runInNewContext(output)), ['plugin']);
  assert.ok(!output.includes('__test'));
});
test('неизвестная структура экспортов не выпускается как якобы защищённая сборка', () => {
  assert.throws(() => stripPrivateExports('({plugin:1})'), /Cannot safely/);
  assert.throws(() => stripPrivateExports('({plugin:1,__test:{},unexpected:2})'), /Unexpected production/);
});
test('объединение удаляет только внутренние AMD-зависимости и не меняет исходник', () => {
  const directory = path.resolve(__dirname, '../plugin');
  const filename = path.join(directory, 'module.js'), source = fs.readFileSync(filename, 'utf8');
  const result = bundle(source, directory);
  let dependencies;
  vm.runInNewContext(result, { define: deps => { dependencies = [...deps]; } });
  assert.deepEqual(dependencies, ['@grafana/data', '@grafana/runtime', 'react', 'react-dom', 'react-dom/client']);
  assert.equal(fs.readFileSync(filename, 'utf8'), source);
});
test('внутренние свойства переименованы только в аудированных helper-контрактах', () => {
  const directory = path.resolve(__dirname, '../plugin');
  const source = fs.readFileSync(path.join(directory, 'module.js'), 'utf8');
  const result = bundle(source, directory);
  assert.ok(!result.includes('attachmentTools.readAttachment'));
  assert.ok(result.includes('attachmentTools._h'));
  assert.throws(() => bundle(source.replace('attachmentTools.readAttachment', 'attachmentTools[unknown]'), directory), /dynamic\/unknown/);
});
