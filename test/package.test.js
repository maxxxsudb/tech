const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const manifest = require('../plugin/plugin.json');
const pluginRoot = path.join(__dirname, '../plugin');
const archive = fs.readFileSync(path.join(__dirname, `../output/${manifest.id}-${manifest.info.version}.zip`));

function entries() {
  let end = archive.length - 22;
  while (end >= Math.max(0, archive.length - 65557) && archive.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'ZIP end record missing');
  const count = archive.readUInt16LE(end + 10), result = [];
  let offset = archive.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50);
    const nameLength = archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const local = archive.readUInt32LE(offset + 42), method = archive.readUInt16LE(offset + 10);
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const compressed = archive.subarray(start, start + archive.readUInt32LE(offset + 20));
    assert.ok(method === 0 || method === 8, 'Unsupported compression');
    result.push({ name, data: method === 8 ? zlib.inflateRawSync(compressed) : compressed });
    offset += 46 + nameLength + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32);
  }
  return result;
}

test('релизный ZIP содержит только папку plugin ID, без плоских файлов и двойного вложения', () => {
  const files = entries();
  assert.equal(new Set(files.map(file => file.name)).size, files.length);
  assert.ok(files.every(file => file.name.startsWith(manifest.id + '/') && !file.name.includes('..') && !file.name.includes('\\')));
  const actual = files.map(file => file.name.substring(manifest.id.length + 1)).sort();
  assert.deepEqual(actual, fs.readdirSync(pluginRoot).sort());
  assert.ok(files.some(file => file.name === manifest.id + '/plugin.json'));
});

test('все файлы релизного ZIP побайтово совпадают с plugin/, включая manifest и версию', () => {
  for (const file of entries()) assert.deepEqual(file.data, fs.readFileSync(path.join(pluginRoot, file.name.substring(manifest.id.length + 1))), file.name);
  const packagedManifest = JSON.parse(entries().find(file => file.name === manifest.id + '/plugin.json').data.toString('utf8'));
  assert.equal(packagedManifest.info.version, manifest.info.version);
  assert.ok(fs.readFileSync(path.join(pluginRoot, 'module.js'), 'utf8').includes(`PLUGIN_VERSION = "${manifest.info.version}"`));
});
