const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const attachments = require("../plugin/attachments.js");

test("attachments loads through AMD without CommonJS globals", () => {
  let exported;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../plugin/attachments.js"), "utf8"), {
    define(deps, factory) { assert.equal(deps.length, 0); exported = factory(); },
  });
  assert.equal(exported.limits.maxFiles, 4);
  assert.equal(typeof exported.readAttachment, "function");
});

test("text attachments preserve filenames and content, and have unique ids", async () => {
  const file = { name: "ошибка.LOG", type: "", size: 12, text: async () => "line one\nline two" };
  const first = await attachments.readAttachment(file);
  const second = await attachments.readAttachment(file);
  assert.equal(first.name, file.name);
  assert.equal(first.content, "line one\nline two");
  assert.equal(first.kind, "text");
  assert.equal(first.mime, "text/plain");
  assert.equal(first.originalBytes, 12);
  assert.notEqual(first.id, second.id);
});

test("unsupported files and input sizes are rejected before reading", async () => {
  let reads = 0;
  const file = { name: "report.txt", type: "text/plain", text: async () => { reads++; return ""; } };
  await assert.rejects(attachments.readAttachment({ ...file, name: "report.pdf", size: 12 }), /Поддерживаются/);
  await assert.rejects(attachments.readAttachment({ ...file, size: attachments.limits.maxTextBytes + 1 }), /1 МБ/);
  await assert.rejects(attachments.readAttachment({ ...file, name: "screen.png", type: "image/png", size: attachments.limits.maxImageBytes + 1 }), /10 МБ/);
  await assert.rejects(attachments.readAttachment({ ...file, size: -1 }), /размер/);
  assert.equal(reads, 0);
});

test("text fallback uses FileReader with UTF-8", async () => {
  const previous = global.FileReader;
  global.FileReader = class {
    readAsText(file, encoding) {
      assert.equal(encoding, "UTF-8");
      this.result = "старый браузер";
      queueMicrotask(() => this.onload());
    }
  };
  try {
    assert.equal((await attachments.readAttachment({ name: "report.md", size: 12 })).content, "старый браузер");
  } finally {
    if (previous === undefined) delete global.FileReader;
    else global.FileReader = previous;
  }
});

test("image processing fits dimensions and compresses adaptively without changing the filename", async () => {
  const previous = { FileReader: global.FileReader, Image: global.Image, document: global.document };
  const qualities = [];
  const draws = [];
  const largeData = "data:image/jpeg;base64," + "A".repeat(Math.ceil(attachments.limits.maxEncodedImageBytes * 4 / 3) + 4);
  global.FileReader = class {
    readAsDataURL() { this.result = "data:image/png;base64,AAAA"; queueMicrotask(() => this.onload()); }
  };
  global.Image = class {
    constructor() { this.naturalWidth = 3200; this.naturalHeight = 2400; }
    set src(value) { queueMicrotask(() => this.onload()); }
  };
  global.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return {
        getContext: () => ({ fillRect() {}, drawImage(_image, _x, _y, width, height) { draws.push([width, height]); } }),
        toDataURL(mime, quality) { assert.equal(mime, "image/jpeg"); qualities.push(quality); return quality > 0.6 ? largeData : "data:image/jpeg;base64,AAAA"; },
      };
    },
  };
  try {
    const image = await attachments.readAttachment({ name: "снимок.PNG", type: "image/png", size: 100 });
    assert.equal(image.name, "снимок.PNG");
    assert.equal(image.mime, "image/jpeg");
    assert.deepEqual([image.width, image.height], [1600, 1200]);
    assert.equal(image.bytes, 3);
    assert.equal(image.originalBytes, 100);
    assert.equal(qualities.length, 3);
    assert.ok(draws.every(([width, height]) => width <= 1600 && height <= 1200));
  } finally {
    Object.keys(previous).forEach((key) => { if (previous[key] === undefined) delete global[key]; else global[key] = previous[key]; });
  }
});

test("composeText includes text only and encloses embedded Markdown fences", () => {
  const text = attachments.composeText([
    { name: "trace.log", kind: "text", content: "before\n```\nafter" },
    { name: "image.png", kind: "image", dataUrl: "SECRET_IMAGE" },
    { name: "data.json", kind: "text", content: '{"count":1}' },
  ]);
  assert.match(text, /### Вложение: trace\.log\n````text\nbefore\n```\nafter\n````/);
  assert.match(text, /### Вложение: data\.json/);
  assert.ok(!text.includes("SECRET_IMAGE"));
  assert.equal(attachments.composeText([]), "");
});

test("summaries exclude all file content and base64 from history metadata", () => {
  const summary = attachments.summaries([
    { id: "a1", name: "image.png", kind: "image", mime: "image/jpeg", bytes: 42, originalBytes: 84, width: 800, height: 600, dataUrl: "SECRET_IMAGE", content: "SECRET_TEXT" },
    { id: "a2", name: "trace.log", kind: "text", mime: "text/plain", bytes: 10, content: "SECRET_TEXT" },
  ]);
  assert.deepEqual(summary[0], { id: "a1", name: "image.png", kind: "image", mime: "image/jpeg", bytes: 42, originalBytes: 84, width: 800, height: 600 });
  assert.ok(!JSON.stringify(summary).includes("SECRET"));
});

function imageUserMessage(prompt, image, transport) {
  if (transport === "ollamaImages") return { role: "user", content: prompt, images: [image.dataUrl.split(",")[1]] };
  const part = transport === "openaiFileData"
    ? { type: "file", file: { filename: "vision-test.jpg", file_data: image.dataUrl } }
    : { type: "image_url", image_url: { url: image.dataUrl } };
  return { role: "user", content: [{ type: "text", text: prompt }, part] };
}
const images = [{ name: "first.png", dataUrl: "data:image/jpeg;base64,AAAA" }, { name: "second.jpg", dataUrl: "data:image/jpeg;base64,BBBB" }];

test("multiple multimodal images share one prompt and one user message", () => {
  const message = attachments.buildUserMessage("Question", images, "openaiDataUri", imageUserMessage);
  assert.equal(message.role, "user");
  assert.equal(message.content.length, 3);
  assert.equal(message.content.filter((part) => part.type === "text").length, 1);
  assert.deepEqual(message.content.slice(1).map((part) => part.image_url.url), images.map((item) => item.dataUrl));
  assert.deepEqual(attachments.buildUserMessage("Question", [], "openaiDataUri", imageUserMessage), { role: "user", content: "Question" });
});

test("multiple Ollama images merge in one message.images array", () => {
  assert.deepEqual(attachments.buildUserMessage("Question", images, "ollamaImages", imageUserMessage), { role: "user", content: "Question", images: ["AAAA", "BBBB"] });
});

test("file transport preserves original attachment filenames", () => {
  const message = attachments.buildUserMessage("Question", images, "openaiFileData", imageUserMessage);
  assert.deepEqual(message.content.filter((part) => part.type === "file").map((part) => part.file.filename), ["first.png", "second.jpg"]);
});
