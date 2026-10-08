const test = require("node:test");
const assert = require("node:assert/strict");
const queries = require("../plugin/query-tools");
const dialog = require("../plugin/conversation");

test("semantic diff compares expressions, SQL and multiline changes", () => {
  assert.equal(queries.expression({ rawSql: "select 1", refId: "A" }), "select 1");
  assert.equal(queries.expression(undefined), "");
  assert.deepEqual(queries.diffLines("first\nold\nlast", "first\nnew\nlast"), [
    { type: "equal", text: "first" }, { type: "remove", text: "old" },
    { type: "add", text: "new" }, { type: "equal", text: "last" },
  ]);
});

test("selective targets preserve unselected queries and datasource options", () => {
  const current = [{ refId: "A", expr: "old A", legendFormat: "keep", datasource: { uid: "loki" } }, { refId: "B", expr: "old B" }];
  const proposed = [{ refId: "A", expr: "new A" }, { refId: "B", expr: "new B" }, { refId: "C", expr: "new C" }];
  const result = queries.mergeSelectedTargets(current, proposed, ["A", "C"]);
  assert.deepEqual(result, [{ ...current[0], expr: "new A" }, current[1], proposed[2]]);
  assert.equal(current[0].expr, "old A");
  assert.deepEqual(queries.mergeSelectedTargets(current, proposed, []), current);
});

test("targets without refId merge by index without removing the others", () => {
  assert.deepEqual(queries.mergeSelectedTargets([{ expr: "old" }, { refId: "B", expr: "keep" }], [{ expr: "new" }], ["__target_0"]), [{ expr: "new" }, { refId: "B", expr: "keep" }]);
});

test("regeneration returns the preceding user and excludes all later turns", () => {
  const history = [{ role: "user", content: "one" }, { role: "assistant", content: "first" }, { role: "user", content: "two", modelContent: "two + file" }, { role: "assistant", content: "second" }];
  const turn = dialog.turnAt(history, 3);
  assert.equal(turn.message.modelContent, "two + file");
  assert.equal(turn.index, 2);
  assert.deepEqual(turn.history, history.slice(0, 2));
  assert.equal(dialog.turnAt([], 0), undefined);
});

test("Markdown export contains panels, query, range and visible messages, not modelContent/base64", () => {
  const output = dialog.exportMarkdown([{ role: "user", content: "Question", modelContent: "hidden attachment bytes", attachments: [{ name: "image.jpg", kind: "image", bytes: 123 }] }, { role: "assistant", content: "Answer", reasoning: "private" }], {
    dashboardTitle: "Stand", dashboardUid: "tech", panel: { id: 1, title: "Logs", targets: [{ expr: "{app=\"test\"}" }] },
  }, { dataRange: { from: 1, to: 2 }, usage: { prompt: 30, completion: 40 } });
  ["# Stand", "### #1 Logs", "{app=\"test\"}", "Диапазон: 1 — 2", "Question", "Answer", "image.jpg", "вход 30"].forEach((value) => assert.ok(output.includes(value), value));
  assert.ok(!output.includes("private") && !output.includes("hidden attachment bytes"));
});

test("alert draft does not enable queries or automatic dashboard mutations", () => {
  const alert = dialog.playbooks.find((item) => item.label === "Подготовить алерт");
  assert.equal(alert.queries, undefined);
  assert.equal(alert.needsPanel, true);
  assert.ok(alert.prompt.includes("Не сохраняй алерт"));
  assert.equal(dialog.playbooks.find((item) => item.comparePeriods).investigation, true);
});
