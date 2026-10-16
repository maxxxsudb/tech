const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
function bundle(code, directory) {
  const ast = acorn.parse(code, { ecmaVersion: 'latest' });
  const call = ast.body.find(node => node.type === 'ExpressionStatement' && node.expression.callee && node.expression.callee.name === 'define').expression;
  const [deps, factory] = call.arguments;
  const edits = [], declarations = [], external = [], parameters = [], contracts = new Map();
  deps.elements.forEach((dependency, index) => {
    if (!dependency.value.startsWith('./')) { external.push(dependency.value); parameters.push(factory.params[index].name); return; }
    const filename = dependency.value.slice(2) + '.js';
    if (!['attachments.js', 'conversation.js', 'query-tools.js'].includes(filename)) throw new Error('Review new private dependency: ' + filename);
    const helper = fs.readFileSync(path.join(directory, filename), 'utf8');
    const helperAst = acorn.parse(helper, { ecmaVersion: 'latest' });
    const body = helperAst.body[0].expression.arguments[0];
    if (body.type !== 'FunctionExpression') throw new Error('Unsupported private module wrapper: ' + filename);
    const exported = body.body.body.at(-1);
    if (exported.type !== 'ReturnStatement' || exported.argument.type !== 'ObjectExpression') throw new Error('Unsupported private exports: ' + filename);
    const aliases = new Map(), privateEdits = [];
    exported.argument.properties.forEach((property, ordinal) => {
      if (property.type !== 'Property' || property.computed || property.method) throw new Error('Review dynamic private export');
      const key = property.key.name || property.key.value, alias = `_h${index}_${ordinal}`;
      aliases.set(key, alias);
      privateEdits.push({ start: property.start, end: property.end, text: alias + ':' + helper.slice(property.value.start, property.value.end) });
    });
    let privateBody = helper.slice(body.start, body.end);
    for (const edit of privateEdits.sort((a, b) => b.start - a.start)) privateBody = privateBody.slice(0, edit.start - body.start) + edit.text + privateBody.slice(edit.end - body.start);
    contracts.set(factory.params[index].name, aliases);
    declarations.push(`const ${factory.params[index].name}=(${privateBody})();`);
  });
  function walk(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Identifier' && contracts.has(node.name)) {
      if (!parent || parent.type !== 'MemberExpression' || parent.object !== node) throw new Error('Private module escapes its audited scope: ' + node.name);
      const key = parent.computed ? parent.property.value : parent.property.name;
      const alias = contracts.get(node.name).get(key);
      if (!alias) throw new Error('Review dynamic/unknown private access: ' + node.name);
      edits.push({ start: parent.property.start, end: parent.property.end, text: parent.computed ? JSON.stringify(alias) : alias });
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(child => walk(child, node)); else if (value && typeof value === 'object') walk(value, node);
  }
  walk(factory.body);
  edits.push({ start: deps.start, end: deps.end, text: JSON.stringify(external) });
  edits.push({ start: factory.params[0].start, end: factory.params.at(-1).end, text: parameters.join(',') });
  const first = factory.body.body[0];
  const insert = first.directive === 'use strict' ? first.end : factory.body.start + 1;
  edits.push({ start: insert, end: insert, text: declarations.join('') });
  for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  acorn.parse(code, { ecmaVersion: 'latest' });
  return code;
}
module.exports = { bundle };
