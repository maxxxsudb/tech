const test = require('node:test');
const assert = require('node:assert/strict');
const queryTools = require('../plugin/query-tools');
let factory;
global.define = (_, fn) => { factory = fn; };
delete require.cache[require.resolve('../plugin/module.js')]; require('../plugin/module.js'); delete global.define;
class AppPlugin { constructor() { const p = new Proxy(this, { get: () => () => p }); return p; } }
const pg = { uid: 'pg', type: 'grafana-postgresql-datasource' };
const api = factory({ AppPlugin, BusEventWithPayload: class {} }, { config: { appSubUrl: '/grafana' } }, { createElement() {} }, {}, require('../plugin/attachments'), require('../plugin/conversation'), queryTools, {}, require('../plugin/alerting'));
const settings = api.__test.defaults;
const context = { panels: [{ id: 1, datasource: pg }], timeRange: { from: 1790000000000, to: 1790000600000 } };
const fetchBefore = global.fetch;
test.after(() => { global.fetch = fetchBefore; });
const frame = rows => ({ schema: { fields: [{ name: 'amount', type: 'number' }] }, data: { values: [rows] } });

test('bounded SQL accepts read CTE, macro, quotes and comments without treating string contents as commands', () => {
  const result = queryTools.boundedSql("/* nested /* ok */ */ WITH t AS (SELECT 1234.56789 amount, 'delete; update' label) SELECT amount FROM t WHERE $__timeFilter(created_at);", 2);
  assert.match(result.rawSql, /LIMIT 3$/); assert.equal(result.rowLimit, 2);
  assert.match(queryTools.boundedSql('SELECT $$delete; pg_sleep(1)$$ AS message').rawSql, /LIMIT 101$/);
  assert.match(queryTools.boundedSql('SELECT pg_catalog.count(*) FROM orders').rawSql, /count/);
  assert.match(queryTools.boundedSql('SELECT count(CASE WHEN (amount > 0) THEN 1 END) FROM orders').rawSql, /LIMIT 101$/);
  assert.throws(() => queryTools.boundedSql('SELECT "SUM"(amount) FROM orders'));
  assert.throws(() => queryTools.boundedSql('SELECT * FROM orders FOR SHARE'));
});
test('SQL tool rejects writes, chained statements, writing CTE and unreviewed functions', () => {
  for (const sql of ['UPDATE orders SET amount=0', 'SELECT 1; DROP TABLE orders', 'WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x', 'SELECT * INTO new_table FROM orders', 'SELECT pg_sleep(1)', 'SELECT "pg_sleep"(1)', 'SELECT public.sum(amount) FROM orders', 'SELECT custom_side_effect()', 'SELECT "as"()', 'SELECT "опасная"()', 'SELECT опасная()', 'WITH RECURSIVE x AS (SELECT 1) SELECT * FROM x', "SELECT E'bad\\'quote'", 'EXPLAIN ANALYZE SELECT * FROM orders']) assert.throws(() => queryTools.boundedSql(sql), undefined, sql);
});
test('schema SQL escapes identifiers as literals and does not accept arbitrary SQL actions', () => {
  const sql = queryTools.postgresSchemaQuery({ action: 'columns', schema: "x'; DROP DATABASE postgres;--", table: 'Orders' });
  assert.match(sql, /x''; DROP DATABASE postgres;--/); assert.match(sql, /LIMIT 101$/);
  assert.throws(() => queryTools.postgresSchemaQuery({ action: 'query', query: 'DROP TABLE x' }));
  assert.throws(() => queryTools.postgresSchemaQuery({ action: 'indexes', schema: 'public' }));
});
test('SQL tool caps actual SQL, keeps decimal values and reports truncation without sentinel data', async () => {
  let sent;
  global.fetch = async (_, options) => { sent = JSON.parse(options.body); return new Response(JSON.stringify({ results: { AI: { frames: [frame([1234.56789, 999.99, 777])] } } })); };
  const result = await api.__features.executeQueryTool(settings, context, { datasourceUid: 'pg', rowLimit: 2, query: { rawSql: 'SELECT amount FROM orders ORDER BY amount DESC', format: 'table' } });
  assert.match(sent.queries[0].rawSql, /LIMIT 3$/); assert.equal(sent.queries[0].format, 'table');
  const summary = result.results[0].result;
  assert.deepEqual(summary.tables[0].rows, [[1234.56789], [999.99]]); assert.equal(summary.sqlRows.truncated, true); assert.equal(summary.sqlRows.totalUnknown, true);
  assert.equal(summary.tables[0].totalRows, 2);
});
test('SQL errors yield schema feedback and permissions are not retried', async () => {
  global.fetch = async () => new Response(JSON.stringify({ results: { AI: { error: 'column missing does not exist (SQLSTATE 42703)' } } }), { status: 400 });
  const result = await api.__features.executeQueryTool(settings, context, { datasourceUid: 'pg', query: { rawSql: 'SELECT missing FROM orders' } });
  assert.equal(result.sqlFeedback.sqlState, '42703'); assert.match(result.sqlFeedback.hint, /columns/);
  assert.match(queryTools.sqlFeedback({ A: { error: 'permission denied (SQLSTATE 42501)' } }).hint, /не повторяйте/);
});
test('schema reads metadata as objects and all datasource/settings gates apply before requests', async () => {
  let calls = 0;
  global.fetch = async (_, options) => { calls++; const q = JSON.parse(options.body).queries[0]; assert.equal(q.refId, 'SCHEMA'); return new Response(JSON.stringify({ results: { SCHEMA: { frames: [{ schema: { fields: [{ name: 'table_name', type: 'string' }] }, data: { values: [['orders']] } }] } } })); };
  const result = await api.__features.executeSchemaTool(settings, context, { datasourceUid: 'pg', action: 'tables' });
  assert.deepEqual(result.items, [{ table_name: 'orders' }]); assert.equal(calls, 1);
  for (const args of [{ datasourceUid: 'unknown', action: 'tables' }, { datasourceUid: 'pg', action: 'query' }]) await assert.rejects(api.__features.executeSchemaTool(settings, context, args));
  await assert.rejects(api.__features.executeSchemaTool({ ...settings, schemaDiscoveryEnabled: false }, context, { datasourceUid: 'pg', action: 'tables' }));
  await assert.rejects(api.__features.executeQueryTool({ ...settings, investigationDatasourceTypes: 'loki' }, context, { datasourceUid: 'pg', query: { rawSql: 'SELECT 1' } }));
  await assert.rejects(api.__features.executeQueryTool({ ...settings, allowedDatasourceUids: 'other' }, context, { datasourceUid: 'pg', query: { rawSql: 'SELECT 1' } }));
  await assert.rejects(api.__features.executeQueryTool(settings, context, { datasourceUid: 'pg', query: { rawSql: 'DELETE FROM orders' } }));
  assert.equal(calls, 1);
});
test('SQL Explore uses rawSql and refuses to guess between multiple PostgreSQL sources', () => {
  const source = api.__features.datasourceForLanguage(context, 'sql'); assert.deepEqual(source, pg);
  const query = api.__features.exploreQueryFor('sql', 'SELECT 1'); assert.equal(query.rawSql, 'SELECT 1'); assert.equal(query.format, 'table');
  const url = new URL(api.__test.exploreUrl(context, source, query), 'http://localhost');
  assert.equal(JSON.parse(url.searchParams.get('panes')).a.queries[0].rawSql, 'SELECT 1');
  assert.equal(api.__features.datasourceForLanguage({ ...context, relatedDatasources: [{ uid: 'second', type: pg.type }] }, 'sql'), undefined);
});
