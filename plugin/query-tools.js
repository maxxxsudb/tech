(function (factory) {
  if (typeof define === "function") define([], factory);
  else if (typeof module === "object" && module.exports) module.exports = factory();
})(function () {
  "use strict";
  function expression(target) {
    if (!target) return "";
    for (const key of ["expr", "query", "rawSql"]) if (typeof (target || {})[key] === "string") return target[key];
    return JSON.stringify(target || {}, null, 2);
  }
  function targetId(target, index) { return String(target.refId || "__target_" + index); }
  function diffLines(before, after) {
    const a = String(before || "").split("\n");
    const b = String(after || "").split("\n");
    if (a.length * b.length > 160000) return a.map((text) => ({ type: "remove", text })).concat(b.map((text) => ({ type: "add", text })));
    const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    const result = [];
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { result.push({ type: "equal", text: a[i++] }); j++; }
      else if (i < a.length && (j >= b.length || table[i + 1][j] >= table[i][j + 1])) result.push({ type: "remove", text: a[i++] });
      else result.push({ type: "add", text: b[j++] });
    }
    return result;
  }
  function foldDiff(lines) {
    const result = [];
    for (let i = 0; i < lines.length;) {
      let end = i + 1;
      if (lines[i].type === 'equal') while (end < lines.length && lines[end].type === 'equal') end++;
      if (lines[i].type === 'equal' && end - i > 4) result.push(...lines.slice(i, i + 2), { type: 'fold', lines: lines.slice(i + 2, end - 2) }, ...lines.slice(end - 2, end));
      else result.push(...lines.slice(i, end));
      i = end;
    }
    return result;
  }
  function targetDiff(before, proposed) {
    const after = Object.assign({}, before, proposed);
    const stable = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])])) : value;
    const primary = ['expr', 'query', 'rawSql'].find(key => typeof before?.[key] === 'string') || ['expr', 'query', 'rawSql'].find(key => typeof after[key] === 'string');
    const metadata = value => stable(Object.fromEntries(Object.entries(value || {}).filter(([key]) => key !== primary)));
    return JSON.stringify(metadata(before)) === JSON.stringify(metadata(after)) ? diffLines(expression(before), expression(after)) : diffLines(JSON.stringify(stable(before || {}), null, 2), JSON.stringify(stable(after), null, 2));
  }
  function localDateTime(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function localDateTimeIso(value) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(value)) return '';
    const d = new Date(value), normalized = value.length === 16 ? value + ':00' : value;
    return Number.isFinite(d.getTime()) && localDateTime(d) === normalized ? d.toISOString() : '';
  }
  function uniqueId(cryptoApi = globalThis.crypto) {
    if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
    if (typeof cryptoApi?.getRandomValues !== 'function') throw Error('Браузер не поддерживает генерацию случайных ID');
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  function localTimeError(raw, badInput, required) {
    if (badInput) return 'Введите дату и время полностью.';
    if (!raw) return required ? 'Укажите дату и время.' : '';
    return localDateTimeIso(raw) ? '' : 'Это время не существует в часовом поясе браузера или дата некорректна.';
  }
  function mergeSelectedTargets(current, proposed, selected) {
    const ids = new Set(selected);
    const result = current.slice();
    proposed.forEach((target, index) => {
      if (!ids.has(targetId(target, index))) return;
      const found = target.refId ? result.findIndex((item) => item.refId === target.refId) : index < result.length ? index : -1;
      const merged = Object.assign({}, found >= 0 ? result[found] : {}, target);
      if (found >= 0) result[found] = merged;
      else result.push(merged);
    });
    return result;
  }
  function diffTargetsList(previous, current) {
    previous = previous || [];
    current = current || [];
    const ids = new Set(previous.map(targetId).concat(current.map(targetId)));
    return Array.from(ids).flatMap(refId => {
      const before = previous.find((target, index) => targetId(target, index) === refId);
      const after = current.find((target, index) => targetId(target, index) === refId);
      if (JSON.stringify(before) === JSON.stringify(after)) return [];
      const changedExpression = expression(before) !== expression(after);
      return [{ refId, before: changedExpression ? expression(before) : JSON.stringify(before || {}), after: changedExpression ? expression(after) : JSON.stringify(after || {}) }];
    });
  }
  function selectedMergedTargets(current, proposed, selected) {
    const ids = new Set(selected);
    return proposed.flatMap((target, index) => {
      if (!ids.has(targetId(target, index))) return [];
      const before = target.refId ? current.find(item => item.refId === target.refId) : current[index];
      return [Object.assign({}, before, target)];
    });
  }
  function sqlTokens(text) {
    const tokens = [];
    for (let i = 0; i < text.length;) {
      if (/\s/.test(text[i])) { i++; continue; }
      if (text.slice(i, i + 2) === '--') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
      if (text.slice(i, i + 2) === '/*') {
        let depth = 1; i += 2;
        while (i < text.length && depth) { if (text.slice(i, i + 2) === '/*') { depth++; i += 2; } else if (text.slice(i, i + 2) === '*/') { depth--; i += 2; } else i++; }
        if (depth) throw new Error('Незакрытый комментарий SQL');
        continue;
      }
      const dollar = /^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/.exec(text.slice(i));
      if (dollar) { const end = text.indexOf(dollar[0], i + dollar[0].length); if (end < 0) throw new Error('Незакрытая dollar-строка SQL'); i = end + dollar[0].length; tokens.push({ value: '<string>' }); continue; }
      if (text[i] === "'" || text[i] === '"') {
        const quote = text[i++]; let value = '', closed = false;
        while (i < text.length) { if (text[i] === '\\') throw new Error('Для SQL-инструмента используйте SQL-экранирование кавычек без backslash'); if (text[i] === quote) { if (text[i + 1] === quote) { value += quote; i += 2; } else { i++; closed = true; break; } } else value += text[i++]; }
        if (!closed) throw new Error('Незакрытая строка или идентификатор SQL');
        tokens.push({ value: quote === '"' ? value : '<string>', quoted: quote === '"' }); continue;
      }
      const word = /^[\p{L}_][\p{L}\p{N}_$]*/u.exec(text.slice(i));
      if (word) { tokens.push({ value: word[0].toLowerCase() }); i += word[0].length; }
      else tokens.push({ value: text[i++] });
    }
    return tokens;
  }

  function boundedSql(rawSql, rowLimit) {
    if (typeof rawSql !== 'string' || !rawSql.trim() || rawSql.length > 20000) throw new Error('SQL должен содержать от 1 до 20000 символов');
    const text = rawSql.trim().replace(/;\s*$/, '');
    const tokens = sqlTokens(text);
    if (!['select', 'with'].includes(tokens[0]?.value) || tokens[0].quoted) throw new Error('SQL-инструмент выполняет только SELECT или читающий WITH');
    const forbidden = new Set(['insert', 'update', 'delete', 'merge', 'into', 'copy', 'call', 'do', 'create', 'alter', 'drop', 'truncate', 'grant', 'revoke', 'vacuum', 'analyze', 'explain', 'set', 'reset', 'lock', 'listen', 'notify', 'unlisten', 'execute', 'prepare', 'deallocate', 'refresh', 'recursive', 'for']);
    const functions = new Set(('to_json to_jsonb json_build_array jsonb_build_array json_object_agg jsonb_object_agg json_object_keys jsonb_object_keys json_each jsonb_each json_each_text jsonb_each_text json_array_elements jsonb_array_elements json_array_elements_text jsonb_array_elements_text jsonb_path_query jsonb_path_query_array jsonb_path_query_first jsonb_path_exists jsonb_path_match json_typeof jsonb_typeof array_length array_ndims array_dims cardinality array_position array_positions array_remove array_replace array_to_string string_to_array regexp_split_to_array regexp_split_to_table format initcap left right reverse repeat translate ascii chr octet_length bit_length encode decode md5 date_trunc isfinite count sum avg min max abs round floor ceil ceiling trunc sqrt power mod coalesce nullif greatest least cast extract date_part date_trunc date_bin to_timestamp to_char to_date now current_timestamp timezone age make_interval lower upper length char_length substring substr trim btrim ltrim rtrim replace concat concat_ws split_part strpos position regexp_replace regexp_match regexp_matches bool_and bool_or every array_agg string_agg json_agg jsonb_agg json_build_object jsonb_build_object json_extract_path_text jsonb_extract_path_text json_array_length jsonb_array_length unnest generate_series percentile_cont percentile_disc mode stddev stddev_pop stddev_samp variance var_pop var_samp row_number rank dense_rank lag lead first_value last_value nth_value ntile numeric decimal varchar char text date timestamp timestamptz time interval smallint integer bigint int float float4 float8 boolean __timefrom __timeto __unixepochfrom __unixepochto __timefilter __timegroup __timegroupalias __time __timeepoch __unixepochfilter __unixepochgroup __unixepochgroupalias').split(' '));
    const syntax = new Set(['as', 'in', 'not', 'over', 'filter', 'within', 'group', 'by', 'case', 'between', 'like', 'ilike', 'is', 'values', 'distinct', 'select', 'from', 'where', 'and', 'or', 'on', 'having', 'exists', 'any', 'all', 'when', 'then', 'else', 'join', 'lateral', 'using', 'union', 'intersect', 'except']);
    for (let i = 0; i < tokens.length; i++) {
      const { value, quoted } = tokens[i];
      if (value === ';' || (!quoted && forbidden.has(value))) throw new Error('SQL-инструмент отклонил команду: ' + value);
      if (quoted && tokens[i + 1]?.value === '(') throw new Error('Quoted function требует ручной проверки: ' + value);
      if (tokens[i + 1]?.value === '(' && /^(?:pg_(?!catalog$)|dblink|lo_|set_config$|nextval$|setval$)/.test(value)) throw new Error('Функция SQL недоступна в инструменте: ' + value);
      if (tokens[i + 1]?.value === '(' && (quoted || /^[\p{L}_]/u.test(value)) && (quoted || !syntax.has(value))) {
        if (!functions.has(value) || (tokens[i - 1]?.value === '.' && tokens[i - 2]?.value !== 'pg_catalog')) throw new Error('Функция SQL требует ручной проверки: ' + value);
      }
    }
    const limit = Math.max(1, Math.min(500, Math.floor(Number(rowLimit) || 100)));
    return { rawSql: `SELECT * FROM (\n${text}\n) AS "__tech_ai_result" LIMIT ${limit + 1}`, rowLimit: limit };
  }

  function postgresSchemaQuery(args) {
    const literal = value => "'" + String(value).replace(/'/g, "''") + "'";
    const action = args.action;
    if (action === 'tables') {
      const match = String(args.match || '').slice(0, 100);
      return `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND position(lower(${literal(match)}) in lower(table_schema || '.' || table_name)) > 0 ORDER BY table_schema, table_name LIMIT 101`;
    }
    if (!['columns', 'foreign_keys', 'indexes'].includes(action)) throw new Error('PostgreSQL schema: используйте tables, columns, foreign_keys или indexes');
    if (![args.schema, args.table].every(value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('\0'))) throw new Error('Укажите schema и table из результата tables');
    const schema = literal(args.schema), table = literal(args.table);
    if (action === 'columns') return `SELECT column_name, data_type, udt_name, is_nullable, numeric_precision, numeric_scale, datetime_precision, ordinal_position FROM information_schema.columns WHERE table_schema=${schema} AND table_name=${table} ORDER BY ordinal_position LIMIT 101`;
    if (action === 'indexes') return `SELECT indexname, indexdef FROM pg_catalog.pg_indexes WHERE schemaname=${schema} AND tablename=${table} ORDER BY indexname LIMIT 101`;
    return `SELECT c.conname AS constraint_name, a.attname AS column_name, rn.nspname AS referenced_schema, rt.relname AS referenced_table, ra.attname AS referenced_column FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace JOIN pg_catalog.pg_class rt ON rt.oid=c.confrelid JOIN pg_catalog.pg_namespace rn ON rn.oid=rt.relnamespace JOIN LATERAL generate_subscripts(c.conkey,1) AS pos(i) ON true JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=c.conkey[pos.i] JOIN pg_catalog.pg_attribute ra ON ra.attrelid=rt.oid AND ra.attnum=c.confkey[pos.i] WHERE c.contype='f' AND n.nspname=${schema} AND t.relname=${table} AND has_table_privilege(t.oid,'SELECT') ORDER BY c.conname,pos.i LIMIT 101`;
  }

  function sqlFeedback(results) {
    const error = Object.values(results || {}).map(result => result.error).find(Boolean);
    if (!error) return undefined;
    const state = /SQLSTATE[\s:(]+([0-9A-Z]{5})/i.exec(error)?.[1];
    const hint = { '42703': 'Прочитайте columns для реальной таблицы; исправьте имя или quoted identifier.', '42P01': 'Прочитайте tables; проверьте schema и search_path.', '42883': 'Проверьте типы columns и сигнатуру функции.', '42501': 'Недостаточно прав: не повторяйте запрос и не пытайтесь обойти ограничения.', '57014': 'Запрос отменён: сузьте период и уменьшите объём чтения.' }[state];
    return { sqlState: state, hint: hint || 'Исправьте SQL по фактической ошибке; не выдумывайте имена таблиц и колонок.' };
  }
  function dashboardDiff(before, after) {
    const stable = value => value && typeof value === "object" ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    const text = value => JSON.stringify(stable(value === undefined ? null : value), null, 2);
    const flatten = panels => (panels || []).flatMap(panel => [panel].concat(flatten(panel.panels)));
    const indexed = panels => { const list = flatten(panels); if (list.some(panel => panel.id === undefined || panel.id === null) || new Set(list.map(panel => String(panel.id))).size !== list.length) throw Error("Панели без уникальных ID: достоверный diff невозможен"); return new Map(list.map(panel => [String(panel.id), panel])); };
    const old = indexed(before.panels), current = indexed(after.panels);
    const fields = ["title", "type", "datasource", "targets", "fieldConfig", "options", "transformations", "timeFrom", "timeShift", "interval", "maxDataPoints"];
    const project = panel => panel ? Object.fromEntries(fields.filter(key => panel[key] !== undefined).map(key => [key, panel[key]])) : {};
    const changed = Array.from(new Set([...old.keys(), ...current.keys()])).flatMap(id => {
      const prior = old.get(id), next = current.get(id), a = project(prior), b = project(next);
      if (text(a) === text(b)) return [];
      const changes = fields.filter(key => text(a[key]) !== text(b[key])).map(field => { const prev = text(a[field]), curr = text(b[field]); return { field, before: prev.slice(0, 2000), after: curr.slice(0, 2000), truncated: prev.length > 2000 || curr.length > 2000, lines: diffLines(prev.slice(0, 2000), curr.slice(0, 2000)).slice(0, 100) }; });
      const queries = diffTargetsList((prior?.targets || []).map(stable), (next?.targets || []).map(stable)).map(query => { const lines = diffLines(query.before.slice(0, 2000), query.after.slice(0, 2000)); return { refId: query.refId, before: query.before.slice(0, 2000), after: query.after.slice(0, 2000), truncated: query.before.length > 2000 || query.after.length > 2000 || lines.length > 100, lines: lines.slice(0, 100) }; });
      return [{ panelId: id, title: next?.title || prior?.title, kind: !prior ? "added" : !next ? "removed" : "modified", changes, queries }];
    });
    const vars = dashboard => (dashboard.templating?.list || []).map(item => Object.fromEntries(["name", "type", "query", "datasource", "regex", "multi", "includeAll", "allValue", "current"].filter(key => item[key] !== undefined).map(key => [key, item[key]])));
    const prev = text(vars(before)), curr = text(vars(after));
    return { panels: changed.slice(0, 50), totalChangedPanels: changed.length, truncated: changed.length > 50 || prev.length > 4000 || curr.length > 4000 || changed.some(panel => panel.changes.some(change => change.truncated) || panel.queries.some(query => query.truncated)), variables: prev === curr ? null : { before: prev.slice(0, 4000), after: curr.slice(0, 4000), truncated: prev.length > 4000 || curr.length > 4000 }, settings: ["title", "timezone", "time", "refresh"].filter(key => text(before[key]) !== text(after[key])).map(key => ({ field: key, before: before[key], after: after[key] })) };
  }
  return { targetDiff, expression, targetId, diffLines, foldDiff, localDateTime, localDateTimeIso, uniqueId, localTimeError, mergeSelectedTargets, diffTargetsList, selectedMergedTargets, boundedSql, postgresSchemaQuery, sqlFeedback, dashboardDiff };
});
