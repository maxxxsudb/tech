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
  return { expression, targetId, diffLines, mergeSelectedTargets };
});
