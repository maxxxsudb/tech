(function (factory) {
  if (typeof define === "function") define([], factory);
  else if (typeof module === "object" && module.exports) module.exports = factory();
})(function () {
  "use strict";

  function ruleUid(pathname) {
    const match = /\/alerting\/grafana\/([^/]+)\/(?:view|edit)(?:\/|$)/.exec(pathname || "");
    if (!match) return undefined;
    try { return decodeURIComponent(match[1]); } catch (_) { return undefined; }
  }

  function normalizeRule(value) {
    const source = value.grafana_alert || value;
    return {
      uid: source.uid || value.uid,
      title: source.title || value.name || value.alert,
      folderUID: source.folderUID || source.namespace_uid,
      ruleGroup: source.ruleGroup || source.rule_group,
      condition: source.condition,
      for: value.for ?? source.for,
      keepFiringFor: source.keep_firing_for ?? source.keepFiringFor,
      missingSeriesEvalsToResolve: source.missingSeriesEvalsToResolve,
      notificationSettings: source.notification_settings || source.notificationSettings,
      record: source.record,
      noDataState: source.noDataState || source.no_data_state,
      execErrState: source.execErrState || source.exec_err_state,
      isPaused: source.isPaused ?? source.is_paused,
      provenance: source.provenance,
      labels: value.labels || source.labels || {},
      annotations: value.annotations || source.annotations || {},
      state: value.state,
      health: value.health,
      lastError: value.lastError,
      lastEvaluation: value.lastEvaluation,
      data: Array.isArray(source.data) ? source.data.map(query => ({
        refId: query.refId, datasourceUid: query.datasourceUid,
        relativeTimeRange: query.relativeTimeRange, queryType: query.queryType, model: query.model,
      })) : [],
    };
  }

  function stateRules(response) {
    if (!response || response.status !== "success" || !response.data || !Array.isArray(response.data.groups)) throw new Error("Некорректный ответ состояния правил");
    return response.data.groups.flatMap(group => (group.rules || []).map(value => Object.assign(normalizeRule(value), { group: group.name, interval: group.interval })));
  }

  function alertRuleUid(value) {
    const labels = value.labels || {};
    if (labels.__alert_rule_uid__) return labels.__alert_rule_uid__;
    if (labels.__rule_uid__) return labels.__rule_uid__;
    try { return ruleUid(new URL(value.generatorURL, "http://grafana.invalid").pathname); } catch (_) { return undefined; }
  }

  function normalizeAlert(value) {
    return {
      ruleUid: alertRuleUid(value), fingerprint: value.fingerprint,
      labels: value.labels || {}, annotations: value.annotations || {},
      startsAt: value.startsAt, endsAt: value.endsAt, updatedAt: value.updatedAt,
      receivers: Array.isArray(value.receivers) ? value.receivers.map(item => ({ name: item.name })) : undefined,
      status: value.status && { state: value.status.state, silencedBy: value.status.silencedBy, inhibitedBy: value.status.inhibitedBy, mutedBy: value.status.mutedBy },
    };
  }

  function summarizeAlerts(alerts, now) {
    const groups = new Map();
    for (const alert of alerts) {
      const service = alert.labels.service || "не указан";
      const severity = alert.labels.severity || "не указана";
      const key = JSON.stringify([service, severity]);
      const group = groups.get(key) || { service, severity, instances: 0, suppressed: 0, oldestAt: undefined, ruleUids: [] };
      group.instances++;
      if (alert.status && alert.status.state === "suppressed") group.suppressed++;
      const start = Date.parse(alert.startsAt);
      if (Number.isFinite(start) && start > 0 && start <= now && (!group.oldestAt || start < Date.parse(group.oldestAt))) group.oldestAt = alert.startsAt;
      if (alert.ruleUid && !group.ruleUids.includes(alert.ruleUid)) group.ruleUids.push(alert.ruleUid);
      groups.set(key, group);
    }
    return { instances: alerts.length, groups: Array.from(groups.values()).sort((a, b) => b.instances - a.instances) };
  }

  function linkedPanel(rule) {
    const annotations = rule && rule.annotations || {};
    const id = Number(annotations.__panelId__ || annotations.panelId);
    return {
      dashboardUid: annotations.__dashboardUid__ || annotations.dashboardUid,
      panelId: Number.isInteger(id) && id > 0 ? id : undefined,
    };
  }

  async function readContext(request, options) {
    options = options || {};
    const now = options.now || Date.now(), uid = options.uid;
    const endpoints = [
      ["rules", "/api/v1/provisioning/alert-rules" + (uid ? "/" + encodeURIComponent(uid) : "")],
      ["states", "/api/prometheus/grafana/api/v1/rules"],
      ["instances", "/api/alertmanager/grafana/api/v2/alerts"],
    ];
    const readStatus = {}, results = {};
    await Promise.all(endpoints.map(async ([name, path]) => {
      try {
        const response = await request(path, { signal: options.signal, timeoutMs: 10000 });
        if (name === "rules") {
          if (uid ? !response || typeof response !== "object" || Array.isArray(response) || response.uid !== uid : !Array.isArray(response)) throw new Error("Некорректный ответ правил");
          results.rules = (uid ? [response] : response).map(normalizeRule);
        } else if (name === "states") results.states = stateRules(response);
        else {
          if (!Array.isArray(response)) throw new Error("Некорректный ответ экземпляров алертов");
          results.instances = response.map(normalizeAlert);
        }
        readStatus[name] = { ok: true };
      } catch (reason) {
        if (options.signal && options.signal.aborted) throw reason;
        const status = Number(reason && reason.status);
        readStatus[name] = { ok: false, status: status || undefined, error: status === 403 ? "Нет права чтения" : status === 404 ? "Не найдено или API недоступен" : String(reason && reason.message || "Ошибка чтения Alerting API").slice(0, 300) };
      }
    }));
    if (options.signal && options.signal.aborted) throw new DOMException("Aborted", "AbortError");
    const states = results.states || [];
    const rules = (results.rules || states).filter(rule => !uid || rule.uid === uid).map(rule => {
      const state = states.find(item => item.uid === rule.uid);
      return state ? Object.assign({}, rule, { state: state.state, health: state.health, lastError: state.lastError, lastEvaluation: state.lastEvaluation, group: state.group, interval: state.interval }) : rule;
    });
    const instances = (results.instances || []).filter(alert => !uid || alert.ruleUid === uid);
    const unmatchedInstances = uid ? (results.instances || []).filter(alert => !alert.ruleUid).length : 0;
    const summary = readStatus.instances.ok ? summarizeAlerts(instances, now) : undefined;
    const starts = instances.map(alert => Date.parse(alert.startsAt)).filter(at => Number.isFinite(at) && at > 0 && at <= now);
    const rule = uid ? rules.find(item => item.uid === uid) : undefined;
    return {
      mode: uid ? "rule" : "overview", ruleUid: uid, rule,
      rules: uid ? undefined : rules.slice(0, 100), totalRules: rules.length,
      instances: instances.slice(0, 50), totalInstances: readStatus.instances.ok ? instances.length : undefined,
      unmatchedInstances,
      truncated: rules.length > 100 || instances.length > 50,
      summary, readStatus, loadedAt: new Date(now).toISOString(),
      linkedPanel: linkedPanel(rule || instances[0]),
      timeRange: { from: Math.max(now - 24 * 3600000, starts.length ? starts.reduce((oldest, at) => Math.min(oldest, at), now) - 30 * 60000 : now - 3600000), to: now },
    };
  }

  function rulePanels(rule, resolveDatasource) {
    if (!rule) return [];
    const targets = (rule.data || []).filter(query => query.datasourceUid && query.datasourceUid !== "__expr__" && query.datasourceUid !== "-100").map(query => {
      const source = resolveDatasource(query.datasourceUid);
      return Object.assign({}, query.model, { refId: query.refId, datasource: { uid: query.datasourceUid, type: source && source.type }, alertRelativeTimeRange: query.relativeTimeRange });
    });
    return targets.length ? [{ id: 1, title: rule.title || rule.uid, type: "alert-query", targets }] : [];
  }

  function durationSeconds(value) {
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
    if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d|w))+$/.test(String(value || ""))) return undefined;
    return Array.from(value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g)).reduce((sum, part) => sum + Number(part[1]) * ({ ms: .001, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[part[2]]), 0);
  }

  function timingActive(timing, now) {
    const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    try {
      let unknown = false;
      for (const interval of timing.time_intervals || []) {
        const fields = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: interval.location || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "long", hourCycle: "h23" }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
        const year = Number(fields.year), month = Number(fields.month), day = Number(fields.day), lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const ranges = (values, actual, names, negative) => !values?.length || values.some(value => {
          const parts = String(value).toLowerCase().split(":");
          if (parts.length > 2) throw Error("Неизвестный диапазон времени");
          const parse = text => { let n = names ? names === months && /^\d+$/.test(text) ? Number(text) - 1 : names.indexOf(text) : Number(text); if (names && (n < 0 || n >= names.length) || !Number.isInteger(n)) throw Error("Неизвестное значение времени"); if (negative && n < 0) n = lastDay + 1 + n; return n; };
          const start = parse(parts[0]), end = parse(parts[1] ?? parts[0]);
          return actual >= start && actual <= end;
        });
        const minute = Number(fields.hour) * 60 + Number(fields.minute);
        const time = text => { if (!/^\d\d:\d\d$/.test(text)) throw Error("Неизвестное время"); const [h, m] = text.split(":").map(Number); if (h > 24 || m > 59 || h === 24 && m) throw Error("Некорректное время"); return h * 60 + m; };
        const active = (!interval.times?.length || interval.times.some(range => minute >= time(range.start_time) && minute < time(range.end_time))) && ranges(interval.weekdays, weekdays.indexOf(fields.weekday.toLowerCase()), weekdays) && ranges(interval.months, month - 1, months) && ranges(interval.days_of_month, day, undefined, true) && ranges(interval.years, year);
        if (Object.keys(interval).some(key => !["location", "times", "weekdays", "months", "days_of_month", "years"].includes(key))) unknown = true;
        else if (active) return true;
      }
      return unknown ? undefined : false;
    } catch (_) { return undefined; }
  }

  function routePreview(policy, labels, contacts, timings, now, unknownLabels) {
    const routes = [], limitations = [], trace = [];
    const unknown = text => { if (!limitations.includes(text)) limitations.push(text); return undefined; };
    function matches(route) {
      const textual = [];
      for (const text of route.matchers || []) {
        const match = /^\s*([a-zA-Z_][a-zA-Z_0-9]*)\s*(=~|!~|!=|=)\s*("(?:\\.|[^"\\])*"|[a-zA-Z0-9_.:-]+)\s*$/.exec(text);
        if (!match) return unknown("Текстовый matcher требует проверки в Grafana");
        try { textual.push([match[1], match[2], match[3].startsWith('"') ? JSON.parse(match[3]) : match[3]]); } catch (_) { return unknown("Неизвестное экранирование matcher"); }
      }
      const matchers = (route.object_matchers || []).concat(textual, Object.entries(route.match || {}).map(([name, value]) => [name, "=", value]), Object.entries(route.match_re || {}).map(([name, value]) => [name, "=~", value]));
      let uncertain = false;
      for (const [name, operator, value] of matchers) {
        if (unknownLabels?.includes(name)) { uncertain = true; continue; }
        const actual = String(labels[name] ?? ""); let equal;
        if (operator === "=" || operator === "!=") equal = actual === String(value);
        else if (operator === "=~" || operator === "!~") {
          if (String(value).length > 200 || actual.length > 512 || /[(){}]|\\[1-9]|\\[pP]/.test(value) || (String(value).match(/[*+?]/g) || []).length > 1) { uncertain = true; continue; }
          try { const match = new RegExp("^(?:" + value + ")$").exec(actual); equal = !!match && match[0].length === actual.length; } catch (_) { uncertain = true; continue; }
        } else { uncertain = true; continue; }
        if (operator === "!=" || operator === "!~") equal = !equal;
        if (!equal) return false;
      }
      return uncertain ? unknown("Не удалось точно сопоставить matcher или labels") : true;
    }
    function visit(route, parent, path, depth) {
      if (depth > 20) { unknown("Слишком глубокое дерево policies"); return; }
      const effective = Object.assign({}, parent, route);
      let childMatched = false;
      for (const [i, child] of (route.routes || []).entries()) {
        const match = matches(child);
        trace.push({ path: path + "." + i, match: match ?? "unknown", matchers: child.object_matchers || child.matchers || child.match || child.match_re || [], continue: child.continue === true });
        if (match === undefined) { childMatched = true; break; }
        if (!match) continue;
        childMatched = true; visit(child, effective, path + "." + i, depth + 1);
        if (!child.continue) break;
      }
      if (childMatched) return;
      const named = names => (names || []).map(name => {
        const timing = timings?.find(item => item.name === name);
        return { name, active: timing ? timingActive(timing, now) : undefined };
      });
      const mute = named(effective.mute_time_intervals), active = named(effective.active_time_intervals);
      const muted = mute.some(item => item.active === true) || active.length > 0 && active.every(item => item.active === false);
      const timingUnknown = mute.some(item => item.active === undefined) || active.some(item => item.active === undefined);
      if (timingUnknown) unknown("Часть временных интервалов недоступна или не поддерживается");
      const receiver = effective.receiver;
      routes.push({ path, receiver, fallback: path === "root" || (route.routes || []).length > 0, groupBy: effective.group_by || [], groupWait: effective.group_wait || "30s", groupInterval: effective.group_interval || "5m", repeatInterval: effective.repeat_interval || "4h", contactExists: contacts ? contacts.some(item => item.name === receiver) : undefined, muted: timingUnknown && !muted ? undefined : muted, mute, active });
    }
    if (!policy) return { status: "unavailable", routes, limitations: ["Notification policies недоступны"], deliveryVerified: false };
    if (!contacts) unknown("Contact points недоступны");
    visit(policy, {}, "root", 0);
    return { status: limitations.length ? "partial" : "known", routes, trace, limitations, deliveryVerified: false };
  }

  async function readNotificationEvidence(request, options) {
    options = options || {}; const resources = {}, readStatus = {};
    const paths = [["instances", "/api/alertmanager/grafana/api/v2/alerts"], ["silences", "/api/alertmanager/grafana/api/v2/silences"], ["groups", "/api/alertmanager/grafana/api/v2/alerts/groups"], ["status", "/api/alertmanager/grafana/api/v2/status"], ["policies", "/api/v1/provisioning/policies"], ["contacts", "/api/v1/provisioning/contact-points"], ["timings", "/api/v1/provisioning/mute-timings"]];
    await Promise.all(paths.map(async ([name, path]) => {
      try {
        const value = await request(path, { signal: options.signal, timeoutMs: 10000 });
        if (["instances", "silences", "groups", "contacts", "timings"].includes(name) && !Array.isArray(value)) throw Error("Некорректный ответ " + name);
        if (name === "policies" && (!value || typeof value.receiver !== "string")) throw Error("Некорректный ответ policies");
        if (name === "instances" && value.some(item => typeof item?.fingerprint !== "string" || !item.labels || Array.isArray(item.labels))) throw Error("Не получены fingerprint/labels экземпляра");
        if (name === "contacts" && value.some(item => typeof item?.name !== "string")) throw Error("Не получены имена contact points");
        if (name === "status") {
          if (typeof value?.config?.route?.receiver !== "string" || !Array.isArray(value.config.receivers) || value.config.receivers.some(item => typeof item?.name !== "string")) throw Error("Не получена effective-конфигурация Alertmanager");
          resources.effective = { route: value.config.route, contacts: value.config.receivers.map(item => ({ name: item.name })), timings: (value.config.time_intervals || []).concat(value.config.mute_time_intervals || []) };
        } else if (name === "contacts") resources.contacts = value.map(item => ({ name: item.name, type: item.type }));
        else if (name === "instances") resources.instances = value.map(normalizeAlert);
        else if (name === "groups") resources.groups = value.map(group => ({ labels: group.labels, receiver: { name: group.receiver?.name }, fingerprints: (group.alerts || []).map(alert => alert.fingerprint) }));
        else if (name === "silences") resources.silences = value.map(item => ({ id: item.id, matchers: item.matchers, startsAt: item.startsAt, endsAt: item.endsAt, comment: item.comment, createdBy: item.createdBy, state: item.status?.state }));
        else resources[name] = value;
        readStatus[name] = { ok: true };
      } catch (error) { if (options.signal?.aborted) throw error; readStatus[name] = { ok: false, status: error.status, error: error.status === 403 ? "Нет права чтения" : String(error.message || "API недоступен").slice(0, 200) }; }
    }));
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return { resources, readStatus, loadedAt: new Date(options.now || Date.now()).toISOString() };
  }

  function notificationReport(evidence, fingerprint, options) {
    options = options || {}; const now = options.now || Date.now(), snapshotAt = Date.parse(evidence.loadedAt), r = evidence.resources, instance = r.instances?.find(item => item.fingerprint === fingerprint);
    if (!Number.isFinite(snapshotAt) || now - snapshotAt > 5 * 60000) throw Error("Снимок устарел; заново загрузите Alertmanager");
    if (!instance) throw Error(evidence.readStatus.instances?.ok ? "Экземпляр уже отсутствует; обновите список. Историческая доставка неизвестна." : "Экземпляры недоступны; отсутствие срабатывания не подтверждено.");
    if (!fingerprint || r.instances.filter(item => item.fingerprint === fingerprint).length !== 1) throw Error("Неоднозначный fingerprint экземпляра");
    const route = r.effective?.route || r.policies;
    const timings = evidence.readStatus.timings?.ok ? (r.effective?.timings || []).concat(r.timings) : r.effective?.timings?.length ? r.effective.timings : undefined;
    const routing = routePreview(route, instance.labels, r.effective?.contacts || r.contacts, timings, snapshotAt);
    const observed = Array.from(new Set((instance.receivers || []).map(item => item.name).concat((r.groups || []).filter(group => group.fingerprints.includes(fingerprint)).map(group => group.receiver.name)).filter(Boolean)));
    const silences = (instance.status?.silencedBy || []).map(id => ({ id, source: "Alertmanager status.silencedBy", detail: r.silences?.find(item => item.id === id) || null }));
    const inhibitions = (instance.status?.inhibitedBy || []).map(id => ({ fingerprint: id, source: "Alertmanager status.inhibitedBy", alert: r.instances?.find(item => item.fingerprint === id) || null }));
    const findings = [];
    if (instance.status?.state === "unprocessed") findings.push({ kind: "unknown", text: "Alertmanager ещё не обработал экземпляр" });
    if (silences.length) findings.push({ kind: "confirmed", text: "Alertmanager сообщает silence-подавление", evidence: silences.map(item => item.id) });
    if (inhibitions.length) findings.push({ kind: "confirmed", text: "Alertmanager сообщает inhibition", evidence: inhibitions.map(item => item.fingerprint) });
    if (instance.status?.mutedBy?.length) findings.push({ kind: "confirmed", text: "Alertmanager сообщает временное подавление", evidence: instance.status.mutedBy });
    for (const path of routing.routes) {
      if (path.muted === true) findings.push({ kind: "calculated", text: "Текущий временной интервал подавляет маршрут " + path.path, evidence: { receiver: path.receiver, mute: path.mute, active: path.active } });
      if (path.contactExists === false) findings.push({ kind: "calculated", text: "Получатель отсутствует в прочитанной конфигурации", evidence: { receiver: path.receiver } });
    }
    const limitations = ["Снимки API получены не атомарно; временные расчёты относятся к loadedAt, это не история доставки", "Receivers и маршрут не доказывают отправку/получение; журнал доставки и ошибки каналов не прочитаны", "group_wait/group_interval/repeat_interval показаны как настройки, фактическая очередь и момент отправки неизвестны", "Проверяется встроенный Grafana Alertmanager; внешние Alertmanager не проверялись"];
    if (!r.effective) limitations.push("Effective-конфигурация недоступна: расчёт по provisioning policies может не учитывать сгенерированные маршруты");
    if (!silences.length && !inhibitions.length && !instance.status?.mutedBy?.length && !routing.routes.some(path => path.muted === true)) findings.push({ kind: "unknown", text: "В снимке не найдена подтверждённая причина недоставки. Это не подтверждение отправки." });
    if (routing.status !== "known") limitations.push(...routing.limitations);
    return { fingerprint, instance, routing, observedReceivers: observed, silences, inhibitions, findings, readStatus: evidence.readStatus, loadedAt: evidence.loadedAt, routingSource: r.effective ? "Alertmanager effective config" : "provisioning policies", delivery: "unknown", deliveryVerified: false, limitations };
  }

  function queryVariables(model) {
    let expr = String(model.expr || '');
    // Named capture references in label_replace's replacement are PromQL, not dashboard variables.
    const pattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|#[^\n]*|\blabel_replace\s*\(/g;
    let match;
    while ((match = pattern.exec(expr))) {
      if (!match[0].startsWith('label_replace')) continue;
      const start = pattern.lastIndex, args = []; let depth = 0, quote, begin = start, end;
      for (let i = start; i < expr.length; i++) {
        const c = expr[i];
        if (quote) { if (c === '\\' && quote !== '`') i++; else if (c === quote) quote = undefined; continue; }
        if (['"', "'", '`'].includes(c)) { quote = c; continue; }
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) {
          if (c === ')' && depth === 0) { args.push([begin, i]); end = i; break; }
          depth--;
        } else if (c === ',' && depth === 0) { args.push([begin, i]); begin = i + 1; }
      }
      if (end && args.length === 5) {
        const [from, to] = args[2], value = expr.slice(from, to).trim();
        if (/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`)$/.test(value)) expr = expr.slice(0, from) + ' '.repeat(to - from) + expr.slice(to);
      }
    }
    const variables = text => String(text || '').match(/\$(?!__)[a-zA-Z_][a-zA-Z_0-9]*|\$\{(?!__)[^}]+\}/g) || [];
    return { sql: [...new Set(variables(model.rawSql))], expr: [...new Set(variables(expr))] };
  }
  const thresholdOperators = ['gt', 'lt', 'gte', 'lte'];
  function thresholdBreach(value, threshold, operator) {
    if (!thresholdOperators.includes(operator)) throw Error('Неподдерживаемый оператор порога');
    return operator === 'gte' ? value >= threshold : operator === 'lte' ? value <= threshold : operator === 'lt' ? value < threshold : value > threshold;
  }
  function auditRules(rules, resources, now) {
    resources = resources || {}; now = now || Date.now();
    const stable = value => value && typeof value === "object" ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    const fingerprints = new Map();
    for (const rule of rules) {
      const key = JSON.stringify(stable({ condition: rule.condition, data: rule.data, labels: rule.labels }));
      const values = fingerprints.get(key) || []; values.push(rule.uid); fingerprints.set(key, values);
    }
    const results = rules.map(rule => {
      const issues = [];
      const issue = (code, severity, message, evidence, suggestion) => issues.push({ code, severity, message, evidence, suggestion });
      if (rule.record) return { uid: rule.uid, title: rule.title, score: null, issues: [{ code: "recording_rule", severity: "info", message: "Recording rule: alert-проверки неприменимы", evidence: { record: rule.record } }] };
      const interval = durationSeconds(rule.interval), pending = durationSeconds(rule.for);
      if (pending === undefined || pending === 0 || interval && pending < interval * 2) issue("pending", "warning", "Проверьте выдержку перед срабатыванием", { for: rule.for ?? null, intervalSeconds: interval ?? null }, "Выберите for под скорость реакции и допустимый шум; короткий for может быть намеренным.");
      for (const [field, state] of [["noDataState", rule.noDataState], ["execErrState", rule.execErrState]]) {
        if (["OK", "Normal"].includes(state)) issue(field, "warning", "Отсутствие данных или ошибка переводит правило в Normal", { [field]: state }, "Проверьте, допустимо ли скрывать этот отказ для данного правила.");
        else if (!state) issue(field, "info", "Политика состояния не получена", { [field]: null });
      }
      for (const name of ["summary", "description", "runbook_url"]) if (!String(rule.annotations?.[name] || "").trim()) issue("annotation_" + name, "warning", "Не заполнено " + name, { annotation: name, value: rule.annotations?.[name] ?? null }, "Добавьте понятное описание или ссылку для дежурного.");
      for (const name of ["team", "service", "severity"]) if (!String(rule.labels?.[name] || "").trim()) issue("label_" + name, "warning", "Не указан label " + name, { label: name, value: rule.labels?.[name] ?? null }, "Укажите владельца, сервис и важность для маршрутизации.");
      const link = linkedPanel(rule);
      if (!link.dashboardUid || !link.panelId) issue("panel_link", "warning", "Нет полной ссылки на dashboard/panel", link, "Свяжите правило с диагностической панелью.");
      if (rule.isPaused) issue("paused", "info", "Правило приостановлено", { isPaused: true });
      if (rule.lastError || rule.health === "error") issue("evaluation_error", "error", "Grafana сообщает ошибку evaluation", { health: rule.health, lastError: rule.lastError, lastEvaluation: rule.lastEvaluation }, "Исправьте запрос по фактической ошибке; проверьте datasource и схему.");
      if (rule.provenance) issue("provenance", "info", "Правило управляется provisioning", { provenance: rule.provenance }, "Изменения готовьте для исходной конфигурации.");
      if (!interval) issue("interval_unknown", "info", "Интервал evaluation не получен", { ruleGroup: rule.ruleGroup, interval: rule.interval ?? null });
      for (const query of rule.data || []) {
        if (["__expr__", "-100"].includes(query.datasourceUid)) continue;
        const range = Number(query.relativeTimeRange?.from) - Number(query.relativeTimeRange?.to || 0);
        if (interval && range > 0 && range < interval) issue("query_range", "warning", "Окно запроса короче интервала оценки", { refId: query.refId, rangeSeconds: range, intervalSeconds: interval });
        const variables = queryVariables(query.model || {});
        for (const field of ['sql', 'expr']) if (variables[field].length) issue(field === 'sql' ? 'sql_variables' : 'query_variables', 'error', `В ${field === 'sql' ? 'SQL' : 'PromQL/LogQL'} правила есть переменные дашборда`, { refId: query.refId, variables: variables[field] }, 'Alert evaluation не использует переменные дашборда; задайте явные условия.');
      }
      const duplicates = fingerprints.get(JSON.stringify(stable({ condition: rule.condition, data: rule.data, labels: rule.labels }))).filter(uid => uid !== rule.uid);
      if (duplicates.length) issue("duplicate", "warning", "Совпадают запросы, condition и labels", { otherRuleUids: duplicates }, "Проверьте необходимость дублей; разные for и окна работы могут быть намеренными.");
      const folder = resources.folders?.find(item => item.uid === rule.folderUID);
      const labels = Object.assign({ alertname: rule.title }, folder ? { grafana_folder: folder.title } : {}, rule.labels);
      const direct = rule.notificationSettings?.receiver;
      const unknownLabels = Object.keys(labels).filter(name => /\{\{/.test(String(labels[name])));
      if (!folder && !labels.grafana_folder) unknownLabels.push("grafana_folder");
      const collectUnknown = (route, depth) => {
        if (!route || depth > 20) return;
        for (const name of (route.object_matchers || []).map(item => item[0]).concat((route.matchers || []).map(text => /^\s*([a-zA-Z_][a-zA-Z_0-9]*)/.exec(text)?.[1]).filter(Boolean), Object.keys(route.match || {}), Object.keys(route.match_re || {}))) if (!Object.hasOwn(labels, name) && !unknownLabels.includes(name)) unknownLabels.push(name);
        for (const child of route.routes || []) collectUnknown(child, depth + 1);
      };
      collectUnknown(resources.policies, 0);
      const routing = routePreview(direct ? Object.assign({}, rule.notificationSettings, { receiver: direct }) : resources.policies, labels, resources.contacts, resources.timings, now, unknownLabels);
      if (routing.status !== "known") issue("routing_unknown", "info", "Маршрут проверен не полностью", { status: routing.status, limitations: routing.limitations });
      for (const route of routing.routes) if (route.contactExists === false || !route.receiver) issue("receiver_missing", "error", "Получатель маршрута не найден", route, "Проверьте notification policies и contact point в Grafana.");
      const score = Math.max(0, 100 - issues.reduce((sum, item) => sum + (item.severity === "error" ? 20 : item.severity === "warning" ? 5 : 0), 0));
      return { uid: rule.uid, title: rule.title, folderUID: rule.folderUID, ruleGroup: rule.ruleGroup, score, issues, routing };
    });
    return { loadedAt: new Date(now).toISOString(), totalRules: rules.length, rules: results, scoreMethod: "100 − 20 за error − 5 за warning; info не снижает оценку. Эвристический checklist, не вероятность надёжности.", deliveryVerified: false };
  }

  async function readAudit(request, options) {
    options = options || {};
    const resources = {}, readStatus = {};
    const endpoints = [["rules", "/api/v1/provisioning/alert-rules"], ["states", "/api/prometheus/grafana/api/v1/rules"], ["policies", "/api/v1/provisioning/policies"], ["contacts", "/api/v1/provisioning/contact-points"], ["timings", "/api/v1/provisioning/mute-timings"], ["folders", "/api/folders?limit=1000"]];
    await Promise.all(endpoints.map(async ([name, endpoint]) => {
      try {
        const response = await request(endpoint, { signal: options.signal, timeoutMs: 10000 });
        if (name === "policies") { if (!response || typeof response.receiver !== "string") throw Error("Некорректный ответ policies"); resources[name] = response; }
        else if (name === "states") resources[name] = stateRules(response);
        else {
          if (!Array.isArray(response)) throw Error("Некорректный ответ " + name);
          resources[name] = name === "contacts" ? response.map(item => ({ name: item.name, type: item.type })) : name === "rules" ? response.map(normalizeRule) : response;
        }
        readStatus[name] = { ok: true };
      } catch (reason) {
        if (options.signal?.aborted) throw reason;
        readStatus[name] = { ok: false, status: reason.status, error: reason.status === 403 ? "Нет права чтения" : String(reason.message || "Ошибка Alerting API").slice(0, 200) };
      }
    }));
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!readStatus.rules.ok) return { loadedAt: new Date().toISOString(), unavailable: true, rules: [], readStatus };
    const states = new Map((resources.states || []).map(rule => [rule.uid, rule]));
    const rules = resources.rules.map(rule => { const state = states.get(rule.uid); return Object.assign({}, rule, { interval: state?.interval, health: state?.health, lastError: state?.lastError, lastEvaluation: state?.lastEvaluation }); });
    return Object.assign(auditRules(rules, resources, options.now), { readStatus });
  }

  function canonical(value) {
    return JSON.stringify(value && typeof value === "object" ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, JSON.parse(canonical(value[key]))])) : value);
  }

  function validateDraft(draft) {
    const errors = [];
    if (!draft || typeof draft !== "object") return ["Черновик отсутствует"];
    for (const name of ["title", "folderUID", "ruleGroup"]) if (typeof draft[name] !== "string" || !draft[name].trim() || draft[name].length > 190) errors.push("Заполните " + name);
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(draft.uid || "")) errors.push("Некорректный uid нового правила");
    if (!draft.source?.datasource?.uid || !["grafana-postgresql-datasource", "prometheus", "loki"].includes(draft.source.datasource.type)) errors.push("Нужен PostgreSQL, Prometheus или Loki datasource панели");
    if (!["last", "mean", "min", "max", "sum"].includes(draft.reducer)) errors.push("Неподдерживаемый reducer");
    if (!thresholdOperators.includes(draft.operator)) errors.push("Поддерживаются условия gt/lt/gte/lte");
    if (draft.threshold === "" || draft.threshold == null || !Number.isFinite(Number(draft.threshold))) errors.push("Укажите числовой порог");
    if (!Number.isInteger(Number(draft.intervalSeconds)) || Number(draft.intervalSeconds) < 10 || Number(draft.intervalSeconds) > 86400) errors.push("Интервал группы должен быть 10–86400 секунд");
    if (!Number.isInteger(Number(draft.lookbackSeconds)) || Number(draft.lookbackSeconds) < 1 || Number(draft.lookbackSeconds) > 86400) errors.push("Окно запроса должно быть 1–86400 секунд");
    const pending = durationSeconds(draft.for);
    if (pending === undefined || pending > 7 * 86400) errors.push("Некорректный for (не больше 7 дней)");
    for (const name of ["labels", "annotations"]) {
      if (draft[name] != null && (typeof draft[name] !== "object" || Array.isArray(draft[name]))) errors.push(name + " должен быть объектом");
      else for (const [key, value] of Object.entries(draft[name] || {})) if (typeof value !== "string" || value.length > 2000 || !key || key.length > 190) errors.push("Некорректное поле " + name + "." + key);
    }
    if (Object.keys(draft.labels || {}).some(key => !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(key) || key.startsWith("__"))) errors.push("Некорректное имя label");
    if (Object.values(draft.labels || {}).some(value => /\{\{/.test(value))) errors.push("В первом builder поддержаны только статические labels");
    if (draft.provenance || draft.isPaused === false || draft.keepFiringFor && durationSeconds(draft.keepFiringFor) !== 0) errors.push("Builder создаёт только новое paused-правило без keepFiringFor");
    return errors;
  }

  function buildRule(draft, validateSql) {
    const errors = validateDraft(draft); if (errors.length) throw Error(errors.join("; "));
    const source = draft.source, datasource = { uid: source.datasource.uid, type: source.datasource.type };
    let model;
    if (datasource.type === "grafana-postgresql-datasource") {
      if (typeof validateSql !== "function") throw Error("SQL-валидатор недоступен");
      validateSql(source.rawSql);
      if (/\$(?!__)[a-zA-Z_][a-zA-Z_0-9]*|\$\{(?!__)[^}]+\}/.test(source.rawSql)) throw Error("Сначала подставьте переменные дашборда в SQL");
      model = { rawSql: source.rawSql, format: "time_series", rawQuery: true, editorMode: "code" };
    } else {
      if (typeof source.expr !== "string" || !source.expr.trim() || source.expr.length > 20000 || queryVariables({ expr: source.expr }).expr.length) throw Error("Нужен запрос панели без переменных дашборда");
      model = { expr: source.expr, instant: false, range: true };
    }
    Object.assign(model, { refId: "A", datasource, intervalMs: Number(draft.intervalSeconds) * 1000, maxDataPoints: 1000 });
    const expressionSource = { uid: "__expr__", type: "__expr__" };
    return {
      uid: draft.uid, title: draft.title.trim(), folderUID: draft.folderUID, ruleGroup: draft.ruleGroup, condition: "C", for: draft.for,
      noDataState: "NoData", execErrState: "Error", isPaused: true,
      labels: Object.assign({}, draft.labels), annotations: Object.assign({}, draft.annotations),
      data: [
        { refId: "A", queryType: "", datasourceUid: datasource.uid, relativeTimeRange: { from: Number(draft.lookbackSeconds), to: 0 }, model },
        { refId: "B", queryType: "", datasourceUid: "__expr__", relativeTimeRange: { from: 0, to: 0 }, model: { refId: "B", datasource: expressionSource, type: "reduce", expression: "A", reducer: draft.reducer, intervalMs: 1000, maxDataPoints: 43200 } },
        { refId: "C", queryType: "", datasourceUid: "__expr__", relativeTimeRange: { from: 0, to: 0 }, model: { refId: "C", datasource: expressionSource, type: "threshold", expression: "B", intervalMs: 1000, maxDataPoints: 43200, conditions: [{ evaluator: { type: draft.operator, params: [Number(draft.threshold)] } }] } },
      ],
    };
  }

  function evaluateFrames(response) {
    const results = response?.results;
    if (!results) return { status: "error", error: "Grafana не вернула results" };
    const errors = Object.entries(results).filter(([, result]) => result.error || Number(result.status) >= 400).map(([refId, result]) => refId + ": " + (result.error || "HTTP " + result.status));
    if (errors.length) return { status: "error", error: errors.join("; ").slice(0, 1000) };
    const numbers = refId => (results[refId]?.frames || []).flatMap(frame => (frame.schema?.fields || []).flatMap((field, index) => {
      if (field.type !== "number") return [];
      const values = frame.data?.values?.[index] || [];
      if (values.length !== 1) throw Error("Expression вернул не одно число на label set");
      return [{ key: canonical(field.labels || {}), labels: field.labels || {}, value: values[0] }];
    }));
    try {
      const values = numbers("B"), conditions = numbers("C"), seen = new Set();
      if (!values.length) return { status: "noData", samples: [] };
      if (values.length > 100) throw Error("Больше 100 alert instances на одном шаге");
      const samples = values.map(item => {
        if (seen.has(item.key)) throw Error("Неоднозначные одинаковые labels в reduce"); seen.add(item.key);
        const matching = conditions.filter(condition => condition.key === item.key);
        if (matching.length !== 1) throw Error("Не удалось сопоставить reduce и threshold по labels");
        const condition = matching[0].value;
        return Object.assign({}, item, { status: typeof item.value === "number" && Number.isFinite(item.value) && (condition === 0 || condition === 1) ? "ok" : "noData", condition: condition === 1 });
      });
      return { status: samples.some(sample => sample.status !== "ok") ? "noData" : "ok", samples };
    } catch (error) { return { status: "unsupported", error: error.message }; }
  }

  async function previewRule(request, rule, options) {
    options = options || {};
    const at = options.at ?? Date.now();
    const response = await request("/api/v1/eval", { method: "POST", body: { condition: rule.condition, data: rule.data, now: new Date(at).toISOString() }, signal: options.signal, timeoutMs: 15000, queryResults: true });
    return Object.assign(evaluateFrames(response), { at, fingerprint: canonical(rule) });
  }

  function assertBuilderCondition(rule) {
    if (rule.condition !== "C" || rule.data?.length !== 3 || rule.data[1].model?.type !== "reduce" || rule.data[2].model?.type !== "threshold" || rule.data[1].model?.expression !== "A" || rule.data[2].model?.expression !== "B") throw Error("Replay поддерживает только builder query → reduce → threshold");
    const evaluator = rule.data[2].model.conditions;
    if (rule.data.map(query => query.refId).join(",") !== "A,B,C" || !["last", "mean", "min", "max", "sum"].includes(rule.data[1].model.reducer) || evaluator?.length !== 1 || !thresholdOperators.includes(evaluator[0].evaluator?.type) || evaluator[0].evaluator.params?.length !== 1 || !Number.isFinite(evaluator[0].evaluator.params[0]) || !Number.isFinite(durationSeconds(rule.for)) || rule.keepFiringFor && durationSeconds(rule.keepFiringFor) !== 0) throw Error("Неподдерживаемое условие или recovery в replay");
  }

  function planReplay(rule, intervalSeconds, from, to, options) {
    options = options || {};
    assertBuilderCondition(rule);
    const source = rule.data[0].model, sql = source.rawSql;
    if (sql) {
      // SQL literals cannot safely be inspected with a keyword regexp: replay deliberately rejects doubtful queries.
      if (/\b(?:now|current_timestamp|current_date|localtimestamp|localtime|clock_timestamp|statement_timestamp|transaction_timestamp|random)\b|\$\{?__(?:from|to)\}?\b/i.test(sql)) throw Error("SQL replay не поддерживает текущее время/случайные значения; используйте SQL timeFilter/timeFrom/timeTo macros");
      if (!/\$__(?:timeFilter|unixEpochFilter)\s*\(/i.test(sql) && !(/\$__timeFrom\s*\(/i.test(sql) && /\$__timeTo\s*\(/i.test(sql))) throw Error("SQL replay требует движущегося окна через timeFilter или timeFrom/timeTo");
    }
    const stepMs = Number(intervalSeconds) * 1000;
    if (!Number.isInteger(stepMs) || stepMs < 10000 || stepMs > 86400000 || !Number.isFinite(from) || !Number.isFinite(to) || from >= to || to > (options.now ?? Date.now()) + 5000 || to - from > 30 * 86400000) throw Error("Некорректный период или шаг replay (не больше 30 дней)");
    const start = Math.ceil(from / stepMs) * stepMs, end = Math.floor(to / stepMs) * stepMs;
    const evaluations = Math.max(0, Math.floor((end - start) / stepMs) + 1);
    if (!evaluations || evaluations > 500) throw Error(`План требует ${evaluations} eval-запросов; лимит 500. Сократите период; шаг группы не увеличивается автоматически.`);
    return { from: start, to: end, stepMs, evaluations, sqlQueries: evaluations, lookbackSeconds: rule.data[0].relativeTimeRange.from, fingerprint: canonical(rule), intervalSeconds: Number(intervalSeconds), maxDurationMs: 120000 };
  }

  function replayStatistics(points, threshold, pendingSeconds, operator, stepMs) {
    const states = new Map(), episodes = [], seenKeys = new Set();
    let valid = 0, unknown = 0, transitions = 0;
    const close = (state, at, uncertain) => { if (state.episode) { state.episode.end = uncertain ? null : at; state.episode.rightCensored = !!uncertain; state.episode.observedDurationMs = Math.max(0, (uncertain ? state.lastKnownAt || state.episode.start : at) - state.episode.start); state.episode = undefined; } state.pendingAt = undefined; if (uncertain) state.seenKnown = false; };
    for (const point of points) {
      const samples = point.result.samples || [], present = new Set();
      for (const sample of samples) {
        present.add(sample.key); seenKeys.add(sample.key);
        const state = states.get(sample.key) || { labels: sample.labels };
        states.set(sample.key, state);
        if (point.result.status === "error" || sample.status !== "ok") { unknown++; close(state, point.at, true); continue; }
        valid++;
        state.lastKnownAt = point.at;
        const breach = thresholdBreach(sample.value, threshold, operator);
        if (!breach) { if (state.episode) transitions++; close(state, point.at, false); state.seenKnown = true; continue; }
        if (state.pendingAt === undefined) { state.pendingAt = point.at; state.pendingLeftCensored = !state.seenKnown; }
        if (!state.episode && point.at - state.pendingAt >= pendingSeconds * 1000) {
          state.episode = { labels: sample.labels, start: point.at, conditionSince: state.pendingAt, end: null, leftCensored: state.pendingLeftCensored, rightCensored: true, observedDurationMs: 0 };
          episodes.push(state.episode); transitions++;
        }
        if (state.episode) state.episode.observedDurationMs = point.at - state.episode.start;
      }
      for (const [key, state] of states) if (!present.has(key)) { unknown++; close(state, point.at, true); }
      if (!samples.length && !states.size) unknown++;
    }
    return { firingEpisodes: episodes.length, transitions, longestObservedMs: Math.max(0, ...episodes.map(episode => episode.observedDurationMs)), validInstanceEvaluations: valid, unknownInstanceEvaluations: unknown, instances: seenKeys.size, episodes: episodes.slice(0, 100), episodesTruncated: episodes.length > 100, stepMs, initialState: "Normal assumed; pending before the first evaluation is unknown", flapping: "Use transitions and episode count; no universal flapping threshold" };
  }

  async function replayRule(request, rule, plan, options) {
    options = options || {};
    if (canonical(rule) !== plan.fingerprint) throw Error("Черновик изменён после плана");
    plan = planReplay(rule, plan.intervalSeconds, plan.from, plan.to);
    const model = rule.data[2].model.conditions[0].evaluator;
    const baseFor = durationSeconds(rule.for), thresholds = options.thresholds || [model.params[0]], pending = options.pending || [baseFor];
    if (thresholds.length > 5 || pending.length > 5 || thresholds.some(value => !Number.isFinite(value)) || pending.some(value => !Number.isFinite(value) || value < 0 || value > 7 * 86400)) throw Error("Sweep: не больше 5 порогов × 5 for");
    const started = Date.now(), points = [];
    for (let at = plan.from; at <= plan.to; at += plan.stepMs) {
      if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (Date.now() - started > plan.maxDurationMs) break;
      let result;
      try { result = await previewRule(request, rule, { at, signal: options.signal }); }
      catch (error) { if (options.signal?.aborted) throw error; if (error.status === 403) throw error; result = { status: "error", error: String(error.message || error.data?.message || "Ошибка eval").slice(0, 500) }; }
      if (result.status === "unsupported") throw Error(result.error);
      if ((result.samples || []).some(sample => sample.status === "ok" && sample.condition !== thresholdBreach(sample.value, model.params[0], model.type))) throw Error("Backend condition отличается от threshold; локальный sweep не поддержан");
      points.push({ at, result });
      if (options.onProgress) options.onProgress({ completed: points.length, total: plan.evaluations });
    }
    const variants = thresholds.flatMap(threshold => pending.map(forSeconds => ({ threshold, forSeconds, statistics: replayStatistics(points, threshold, forSeconds, model.type, plan.stepMs) })));
    const errors = points.filter(point => point.result.status === "error").length, noData = points.filter(point => point.result.status === "noData").length;
    return { fingerprint: plan.fingerprint, checkedAt: Date.now(), plan, complete: points.length === plan.evaluations, evaluations: points.length, errors, noData, coverage: points.length ? (points.length - errors - noData) / points.length : 0, statistics: replayStatistics(points, model.params[0], baseFor, model.type, plan.stepMs), variants, points, limitations: ["Выбранная сетка evaluation; фактическая история scheduler/state и доставка уведомлений не восстановлены", "NoData/Error и исчезновение series остаются неизвестными; состояние до начала периода неизвестно", "Стоимость SQL scan не ограничена числом возвращаемых строк"] };
  }

  async function readCreationContext(request, options) {
    options = options || {}; const context = { readStatus: {} };
    await Promise.all([["folders", "/api/folders?limit=1000"], ["rules", "/api/v1/provisioning/alert-rules"], ["policies", "/api/v1/provisioning/policies"], ["contacts", "/api/v1/provisioning/contact-points"], ["timings", "/api/v1/provisioning/mute-timings"]].map(async ([name, path]) => {
      try { const value = await request(path, { signal: options.signal }); if (name !== "policies" && !Array.isArray(value)) throw Error("Некорректный ответ " + name); context[name] = name === "contacts" ? value.map(item => ({ name: item.name, type: item.type })) : value; context.readStatus[name] = { ok: true }; }
      catch (error) { if (options.signal?.aborted) throw error; context.readStatus[name] = { ok: false, error: error.status === 403 ? "Нет права чтения" : String(error.message || "API недоступен") }; }
    }));
    context.groups = Array.from(new Map((context.rules || []).map(rule => [canonical([rule.folderUID, rule.ruleGroup]), { folderUID: rule.folderUID, name: rule.ruleGroup }])).values());
    return context;
  }

  async function verifyGroup(request, rule, intervalSeconds, options) {
    const group = await request(`/api/v1/provisioning/folder/${encodeURIComponent(rule.folderUID)}/rule-groups/${encodeURIComponent(rule.ruleGroup)}`, options);
    if (Number(group.interval) !== Number(intervalSeconds)) throw Error("Интервал evaluation группы изменился; загрузите группу и повторите проверки");
    return { interval: Number(group.interval), rules: Array.isArray(group.rules) ? group.rules.length : undefined };
  }

  async function createPaused(request, rule, checks, options) {
    options = options || {};
    if (!options.confirmed || !["Editor", "Admin"].includes(options.role)) throw Error("Создание требует подтверждения и роли Editor/Admin; окончательные права проверяет API");
    if (rule.isPaused !== true || rule.provenance) throw Error("Разрешено только создание нового paused-правила");
    const fingerprint = canonical(rule), fresh = Date.now() - 10 * 60000;
    if (!checks?.preview || checks.preview.status !== "ok" || checks.preview.fingerprint !== fingerprint || checks.preview.at < fresh || !checks.replay?.complete || checks.replay.fingerprint !== fingerprint || checks.replay.checkedAt < fresh || checks.replay.errors || checks.replay.noData || checks.replay.coverage !== 1) throw Error("Нужны свежий успешный preview и полный replay без NoData/Error для текущего черновика");
    const projection = value => ({ uid: value.uid, title: value.title, folderUID: value.folderUID, ruleGroup: value.ruleGroup, condition: value.condition, forSeconds: durationSeconds(value.for), noDataState: value.noDataState, execErrState: value.execErrState, isPaused: value.isPaused, labels: value.labels || {}, annotations: value.annotations || {}, data: value.data, notificationSettings: value.notification_settings || value.notificationSettings || null, keepFiringSeconds: durationSeconds(value.keep_firing_for || value.keepFiringFor || "0s") });
    try { const existing = await request("/api/v1/provisioning/alert-rules/" + encodeURIComponent(rule.uid), { signal: options.signal }); if (canonical(projection(existing)) !== canonical(projection(rule))) throw Error("UID занят другим или изменённым правилом; перезапись запрещена"); return { rule: existing, alreadyCreated: true }; }
    catch (error) { if (error.status !== 404) throw error; }
    const group = await verifyGroup(request, rule, checks.replay.plan.intervalSeconds, { signal: options.signal });
    if (!Number.isInteger(checks.groupCount) || checks.groupCount !== group.rules) throw Error("Состав группы изменился; заново загрузите группу и проверьте план");
    const created = await request("/api/v1/provisioning/alert-rules", { method: "POST", body: rule, signal: options.signal });
    if (created.isPaused !== true || created.uid !== rule.uid) throw Error("Ответ создания не подтверждает paused/uid; проверьте правило в Grafana, не повторяйте запись");
    return { rule: created, alreadyCreated: false };
  }

  function appendCreationAudit(storage, key, event) {
    try { const previous = JSON.parse(storage.getItem(key) || "[]"); const events = (Array.isArray(previous) ? previous : []).slice(-49); events.push(event); const value = JSON.stringify(events); if (value.length > 500000) throw Error("Локальный журнал переполнен"); storage.setItem(key, value); return { ok: true }; }
    catch (error) { return { ok: false, error: String(error.message || "Локальный журнал недоступен") }; }
  }

  function ruleResourcePath(namespace, uid) {
    if (!namespace || !uid) throw Error("Не получены namespace/UID правила");
    return "/apis/rules.alerting.grafana.app/v0alpha1/namespaces/" + encodeURIComponent(namespace) + "/alertrules/" + encodeURIComponent(uid);
  }

  function resourceRule(resource) {
    if (resource?.kind !== "AlertRule" || resource.apiVersion !== "rules.alerting.grafana.app/v0alpha1" || !resource.spec || !resource.metadata?.name) throw Error("Неизвестный формат AlertRule");
    const spec = resource.spec, metadata = resource.metadata;
    const data = Object.entries(spec.expressions || {}).map(([refId, query]) => ({ refId, datasourceUid: query.datasourceUID || query.model?.datasource?.uid || "__expr__", queryType: query.queryType || "", relativeTimeRange: { from: durationSeconds(query.relativeTimeRange?.from || "0s"), to: durationSeconds(query.relativeTimeRange?.to || "0s") }, model: query.model }));
    const condition = Object.entries(spec.expressions || {}).filter(([, query]) => query.source);
    if (condition.length !== 1) throw Error("Не получено единственное условие правила");
    return { uid: metadata.name, title: spec.title, folderUID: metadata.annotations?.["grafana.app/folder"] || metadata.labels?.["grafana.app/folder"], ruleGroup: metadata.labels?.["grafana.com/group"], condition: condition[0][0], for: spec.for || "0s", keepFiringFor: spec.keepFiringFor, noDataState: spec.noDataState, execErrState: spec.execErrState, isPaused: spec.paused === true, labels: spec.labels || {}, annotations: Object.assign({}, spec.annotations, spec.panelRef ? { __dashboardUid__: spec.panelRef.dashboardUID, __panelId__: String(spec.panelRef.panelID) } : {}), notificationSettings: spec.notificationSettings, data };
  }

  async function readManagedRule(request, namespace, uid, options) {
    const values = await Promise.all([request(ruleResourcePath(namespace, uid), options), request("/api/v1/provisioning/alert-rules/" + encodeURIComponent(uid), options)]);
    const resource = values[0], rule = values[1]; resourceRule(resource);
    if (rule.uid !== uid || resource.metadata.name !== uid || resource.metadata.namespace !== namespace || !resource.metadata.uid || !resource.metadata.resourceVersion) throw Error("Не подтверждена идентичность правила");
    const provenance = rule.provenance || resource.metadata.annotations?.["grafana.com/provenance"] || resource.metadata.annotations?.["grafana.app/managedBy"];
    return { resource, rule, provenance: provenance || "", loadedAt: Date.now() };
  }

  function lifecycleCandidate(snapshot, action, fields) {
    const next = JSON.parse(JSON.stringify(snapshot.resource));
    fields = fields || {};
    if (action === "update") {
      const title = String(fields.title || "").trim();
      if (!title || title.length > 190 || durationSeconds(fields.for) === undefined || durationSeconds(fields.for) > 7 * 86400) throw Error("Проверьте title и for (до 7 дней)");
      next.spec.title = title; next.spec.for = fields.for;
      if (fields.threshold !== undefined && fields.threshold !== "") {
        const rule = resourceRule(next), condition = next.spec.expressions[rule.condition]?.model;
        if (condition?.type !== "threshold" || condition.conditions?.length !== 1 || condition.conditions[0].evaluator?.params?.length !== 1 || !thresholdOperators.includes(condition.conditions[0].evaluator?.type) || !Number.isFinite(Number(fields.threshold))) throw Error("Порог доступен только для простого threshold gt/lt/gte/lte");
        condition.conditions[0].evaluator.params = [Number(fields.threshold)];
      }
      next.spec.paused = true;
    } else if (action === "pause") next.spec.paused = true;
    else if (action === "enable") next.spec.paused = false;
    else if (action === "rollback") {
      if (!fields.before?.spec || canonical(fields.after?.spec) !== canonical(snapshot.resource.spec) || fields.after?.metadata?.uid !== next.metadata.uid) throw Error("Правило изменилось после записи журнала; откат запрещён");
      next.spec = JSON.parse(JSON.stringify(fields.before.spec)); next.spec.paused = true;
    } else if (action !== "delete") throw Error("Неизвестное действие");
    return next;
  }

  function lifecyclePlan(snapshot, action, fields) {
    const next = lifecycleCandidate(snapshot, action, fields);
    return { action, before: snapshot.resource, after: action === "delete" ? null : next, provenance: snapshot.provenance, at: Date.now(), limitations: ["Проверка версии и spec в PATCH выполняется сервером; атомарность с хранилищем не гарантирована Grafana", "DELETE preconditions не соблюдаются Grafana 13.2.2: после повторного чтения остаётся окно гонки", "Изменение и откат сохраняются на паузе; доставка уведомлений не проверяется"] };
  }

  function lifecyclePatch(plan) {
    if (!plan.after) throw Error("Удаление не является PATCH");
    return [{ op: "test", path: "/metadata/uid", value: plan.before.metadata.uid }, { op: "test", path: "/metadata/resourceVersion", value: plan.before.metadata.resourceVersion }, { op: "test", path: "/spec", value: plan.before.spec }, { op: "replace", path: "/spec", value: plan.after.spec }];
  }

  function comparableSpec(spec) {
    const value = JSON.parse(JSON.stringify(spec));
    value.paused = value.paused === true;
    for (const name of ["for", "keepFiringFor"]) value[name] = durationSeconds(value[name] || "0s");
    value.labels = value.labels || {}; value.annotations = value.annotations || {};
    return canonical(value);
  }

  async function applyLifecycle(request, namespace, plan, options) {
    options = options || {};
    if (!options.confirmed || !["Editor", "Admin"].includes(options.role)) throw Error("Нужны подтверждение и роль Editor/Admin");
    if (Date.now() - plan.at > 10 * 60000) throw Error("План устарел; повторите preview");
    if (plan.provenance) throw Error("Provisioned rule: только экспорт/GitOps");
    const uid = plan.before.metadata.name, current = await readManagedRule(request, namespace, uid, { signal: options.signal });
    if (current.provenance) throw Error("Provisioned rule: изменение запрещено");
    if (canonical(current.resource.metadata) !== canonical(plan.before.metadata) || canonical(current.resource.spec) !== canonical(plan.before.spec)) throw Error("Правило изменилось; загрузите заново и повторите diff");
    if (plan.action === "delete" && (options.typedUid !== uid || options.acceptDeleteRace !== true)) throw Error("Введите UID и подтвердите окно гонки DELETE");
    if (["update", "rollback"].includes(plan.action) && plan.after?.spec.paused !== true || plan.action === "pause" && plan.after?.spec.paused !== true || plan.action === "enable" && plan.after?.spec.paused !== false) throw Error("Некорректное состояние плана");
    if (plan.action === "enable") {
      const fingerprint = canonical(current.resource.spec), proof = options.preview;
      if (proof?.fingerprint !== fingerprint || proof.status !== "ok" || Date.now() - proof.at > 10 * 60000 || !options.acceptEnable) throw Error("Включение требует свежего успешного eval и отдельного подтверждения доставки");
    }
    const path = ruleResourcePath(namespace, uid);
    if (plan.action === "delete") {
      await request(path, { method: "DELETE", body: { apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid: plan.before.metadata.uid, resourceVersion: plan.before.metadata.resourceVersion } }, signal: options.signal });
      try { await request(path, { signal: options.signal }); } catch (error) { if (error.status === 404) return { deleted: true }; throw error; }
      throw Error("Удаление не подтверждено; проверьте Grafana перед повтором");
    }
    await request(path, { method: "PATCH", contentType: "application/json-patch+json", body: lifecyclePatch(plan), signal: options.signal });
    const verified = await readManagedRule(request, namespace, uid, { signal: options.signal });
    if (verified.provenance || comparableSpec(verified.resource.spec) !== comparableSpec(plan.after.spec)) throw Error("Результат записи отличается от плана; проверьте Grafana перед повтором");
    return verified;
  }

  function importDraft(text, uid, validateSql) {
    if (typeof text !== "string" || text.length > 500000) throw Error("JSON: лимит 500 КБ");
    const parsed = JSON.parse(text), input = parsed.rule || parsed;
    const rule = input.kind === "AlertRule" ? resourceRule(input) : input;
    if (rule.notificationSettings || rule.notification_settings || rule.keepFiringFor && durationSeconds(rule.keepFiringFor) !== 0 || rule.keep_firing_for && durationSeconds(rule.keep_firing_for) !== 0 || rule.record || rule.missingSeriesEvalsToResolve) throw Error("Импорт специальных notification/recording/keepFiring настроек пока не поддержан");
    if (rule.condition !== "C" || rule.data?.length !== 3) throw Error("Импорт: поддержан только builder A → reduce B → threshold C");
    const [a, b, c] = ["A", "B", "C"].map(ref => rule.data.find(query => query.refId === ref));
    if (!a || b?.model.type !== "reduce" || b.model.expression !== "A" || c?.model.type !== "threshold" || c.model.expression !== "B" || c.model.conditions?.length !== 1 || a.relativeTimeRange?.to !== 0 || !["NoData"].includes(rule.noDataState) || rule.execErrState !== "Error") throw Error("Импорт изменил бы смысл правила; поддержана только простая схема с NoData/Error");
    const source = JSON.parse(JSON.stringify(a.model));
    if (!source.datasource?.type || source.datasource.uid !== a.datasourceUid) throw Error("Не получен точный datasource источника");
    if (a.queryType || b.queryType || c.queryType) throw Error("Импорт queryType пока не поддержан");
    const draft = { uid, title: rule.title, folderUID: rule.folderUID || "import", ruleGroup: rule.ruleGroup || "import", intervalSeconds: parsed.groupIntervalSeconds || 60, lookbackSeconds: a.relativeTimeRange.from, reducer: b.model.reducer, operator: c.model.conditions[0].evaluator?.type, threshold: c.model.conditions[0].evaluator?.params?.[0], for: rule.for || "0s", labels: rule.labels || {}, annotations: rule.annotations || {}, source };
    const rebuilt = buildRule(draft, validateSql);
    const modelShape = query => { const value = JSON.parse(JSON.stringify(query)); delete value.intervalMs; delete value.maxDataPoints; return value; };
    if ([a, b, c].some((query, index) => canonical(modelShape(query.model)) !== canonical(modelShape(rebuilt.data[index].model)))) throw Error("Импорт содержит дополнительные настройки expressions; используйте GitOps");
    return Object.assign({}, draft, { folderUID: "", ruleGroup: "" });
  }

  function yaml(value, depth) {
    depth = depth || 0; const pad = "  ".repeat(depth);
    if (!value || typeof value !== "object" || !Object.keys(value).length) return JSON.stringify(value);
    const scalar = child => !child || typeof child !== "object" || !Object.keys(child).length;
    return Object.entries(value).map(([key, child]) => {
      const prefix = Array.isArray(value) ? "-" : JSON.stringify(key) + ":";
      return pad + prefix + (scalar(child) ? " " + JSON.stringify(child) : "\n" + yaml(child, depth + 1));
    }).join("\n");
  }

  function silenceBody(fields, now) {
    now = now || Date.now();
    const matchers = fields.matchers;
    if (!Array.isArray(matchers) || !matchers.length || matchers.length > 20 || matchers.some(m => !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(m.name) || typeof m.value !== "string" || !m.value.trim() || m.value.length > 512 || m.isRegex || m.isEqual === false)) throw Error("Silence: от 1 до 20 непустых точных labels; regex/отрицания доступны в Grafana");
    if (new Set(matchers.map(m => m.name)).size !== matchers.length) throw Error("Повторяющиеся labels");
    const starts = Date.parse(fields.startsAt), ends = Date.parse(fields.endsAt);
    if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= now || ends <= starts || ends - Math.max(starts, now) > 7 * 86400000 || starts > now + 7 * 86400000) throw Error("Silence: срок до 7 дней, окончание в будущем");
    const comment = String(fields.comment || "").trim(), createdBy = String(fields.createdBy || "").trim();
    if (!comment || comment.length > 1000 || !createdBy) throw Error("Silence: укажите комментарий и автора");
    return Object.assign(fields.id ? { id: fields.id } : {}, { matchers: matchers.map(m => ({ name: m.name, value: m.value, isRegex: false, isEqual: true })), startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString(), comment, createdBy });
  }

  const silenceBase = "/api/alertmanager/grafana/api/v2/silences";
  async function previewSilence(request, fields, options) {
    const body = silenceBody(fields), alerts = await request("/api/alertmanager/grafana/api/v2/alerts", options);
    if (!Array.isArray(alerts)) throw Error("Не получены экземпляры Alertmanager");
    const affected = alerts.filter(alert => body.matchers.every(m => String(alert.labels?.[m.name] || "") === m.value)).map(normalizeAlert);
    return { body, affected, at: Date.now(), fingerprint: canonical(body), impact: canonical(affected.map(a => ({ fingerprint: a.fingerprint, labels: a.labels })).sort((a, b) => canonical(a).localeCompare(canonical(b)))), limitation: "Только текущие экземпляры; будущие с теми же labels тоже подавляются. Silence не останавливает evaluation." };
  }

  async function applySilence(request, preview, options) {
    options = options || {};
    if (!options.confirmed || !["Editor", "Admin"].includes(options.role)) throw Error("Silence требует подтверждения и роли Editor/Admin");
    if (Date.now() - preview.at > 5 * 60000 || canonical(preview.body) !== preview.fingerprint) throw Error("Silence preview устарел или изменился");
    if (preview.body.id) {
      const list = await request(silenceBase, { signal: options.signal });
      if (!Array.isArray(list) || canonical(list.find(item => item.id === preview.body.id)) !== canonical(options.before)) throw Error("Silence изменился; загрузите заново");
    }
    const fresh = await previewSilence(request, preview.body, { signal: options.signal });
    if (fresh.impact !== preview.impact) throw Error("Состав затронутых алертов изменился; повторите preview");
    if (preview.pendingWrite) throw Error("Сначала сверьте результат предыдущей записи silence");
    const pending = { at: Date.now(), body: JSON.parse(JSON.stringify(preview.body)), id: preview.body.id };
    preview.pendingWrite = pending; options.onPending?.(pending);
    let result;
    try { result = await request(silenceBase, { method: "POST", body: preview.body, signal: options.signal }); }
    catch (error) {
      if ([400, 401, 403, 404, 409, 422].includes(error.status)) { delete preview.pendingWrite; options.onPending?.(undefined); }
      throw error;
    }
    if (!result.silenceID) throw Error("Не получен silenceID; проверьте Grafana перед повтором");
    pending.id = result.silenceID; options.onPending?.(Object.assign({}, pending));
    const list = await request(silenceBase, { signal: options.signal }), saved = list.find(item => item.id === result.silenceID);
    if (!saved || canonical(silenceBody(saved)) !== canonical(Object.assign({}, preview.body, { id: result.silenceID }))) throw Error("Silence не подтверждён; проверьте Grafana перед повтором");
    delete preview.pendingWrite; options.onPending?.(undefined);
    return saved;
  }

  async function reconcileSilence(request, pending, options) {
    if (!pending?.body) throw Error("Нет незавершённой записи silence");
    const list = await request(silenceBase, options);
    if (!Array.isArray(list)) throw Error("Не получен список silences");
    const project = value => Object.fromEntries(['matchers', 'startsAt', 'endsAt', 'comment', 'createdBy'].map(key => [key, value[key]]));
    const expected = project(pending.body);
    const candidates = pending.id ? list.filter(item => item.id === pending.id) : list.filter(item => {
      const actual = project(item), start = Date.parse(item.startsAt);
      if (Date.parse(expected.startsAt) <= pending.at && start >= pending.at - 1000 && start <= Date.now()) actual.startsAt = expected.startsAt;
      return canonical(actual) === canonical(expected);
    });
    if (candidates.length !== 1) throw Error("Результат silence не определён однозначно. Проверьте Grafana; повторная запись заблокирована.");
    return { silence: candidates[0], matches: canonical(project(candidates[0])) === canonical(expected) };
  }

  async function expireSilence(request, before, options) {
    options = options || {};
    if (!options.confirmed || !["Editor", "Admin"].includes(options.role) || options.typedId !== before.id) throw Error("Завершение silence требует подтверждения его ID");
    const list = await request(silenceBase, { signal: options.signal });
    if (!Array.isArray(list) || canonical(list.find(item => item.id === before.id)) !== canonical(before)) throw Error("Silence изменился; загрузите заново");
    await request("/api/alertmanager/grafana/api/v2/silence/" + encodeURIComponent(before.id), { method: "DELETE", signal: options.signal });
    const verified = await request(silenceBase, { signal: options.signal }), current = verified.find(item => item.id === before.id);
    if (current && current.status?.state !== "expired") throw Error("Завершение silence не подтверждено; проверьте Grafana");
    return current || { id: before.id, status: { state: "expired" } };
  }

  function postgresTemplate(kind, fields) {
    const identifier = name => { if (typeof name !== "string" || !name || name.length > 128 || name.includes("\0")) throw Error("Укажите реальные имена schema/table/columns"); return '"' + name.replace(/"/g, '""') + '"'; };
    const table = identifier(fields.schema) + "." + identifier(fields.table), time = identifier(fields.timeColumn);
    const value = kind === "count" ? "count(*)::double precision" : kind === "mean" ? "avg(" + identifier(fields.valueColumn) + ")::double precision" : kind === "error_ratio" ? "100.0 * count(*) FILTER (WHERE " + identifier(fields.valueColumn) + " IS TRUE) / NULLIF(count(*), 0)" : undefined;
    if (!value) throw Error("Неизвестный PostgreSQL-шаблон");
    return `SELECT $__timeGroupAlias(${time},'1m'), ${value} AS value\nFROM ${table}\nWHERE $__timeFilter(${time})\nGROUP BY 1 ORDER BY 1`;
  }

  function auditMarkdown(report) {
    const lines = ["# Аудит правил Grafana", "", "Снимок: " + report.loadedAt, "", report.unavailable ? "Правила недоступны; это не пустой список." : report.scoreMethod, "", "Доставка уведомлений не проверялась."];
    const plain = value => String(value ?? "").replace(/[\r\n]/g, " ");
    for (const [name, status] of Object.entries(report.readStatus || {})) if (!status.ok) lines.push("", name + ": " + plain(status.error));
    for (const rule of report.rules || []) {
      lines.push("", "## " + plain(rule.title) + " (" + plain(rule.uid) + ")", "", "Checklist: " + (rule.score ?? "н/д") + "/100");
      for (const issue of rule.issues) lines.push("", "- [" + issue.severity + "] " + plain(issue.message) + "; evidence: " + JSON.stringify(issue.evidence) + (issue.suggestion ? "; " + issue.suggestion : ""));
      if (rule.routing) lines.push("", "Маршрут: " + JSON.stringify(rule.routing));
    }
    return lines.join("\n");
  }

  const triagePrompt = "Разбери выбранный алерт: что проверяет правило, состояние и экземпляры, когда началось срабатывание, какие факты доступны, гипотезы и следующие проверки. Отделяй условие от причины, а факт срабатывания от доставки уведомления. Если данные запросов ещё не получены, явно укажи это. Не изменяй правила и не создавай silence.";
  const overviewPrompt = "Дай короткую сводку активных экземпляров алертов по service/severity: количество, самые старые, что проверить первым. Отдельно укажи подавленные экземпляры и ограничения доступа/выборки. Не выдавай отсутствие доступа за отсутствие алертов. Не делай выводов об истории или доставке уведомлений без фактов.";

  return { assertBuilderCondition, reconcileSilence, queryVariables, thresholdBreach, ruleUid, normalizeRule, stateRules, normalizeAlert, summarizeAlerts, linkedPanel, readContext, rulePanels, durationSeconds, timingActive, routePreview, readNotificationEvidence, notificationReport, auditRules, readAudit, auditMarkdown, canonical, validateDraft, buildRule, evaluateFrames, previewRule, planReplay, replayStatistics, replayRule, readCreationContext, verifyGroup, createPaused, appendCreationAudit, ruleResourcePath, resourceRule, readManagedRule, lifecycleCandidate, lifecyclePlan, lifecyclePatch, applyLifecycle, importDraft, yaml, silenceBody, previewSilence, applySilence, expireSilence, postgresTemplate, triagePrompt, overviewPrompt };
});
