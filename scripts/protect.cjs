const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const acorn = require('acorn');
const terser = require('terser');
const obfuscator = require('javascript-obfuscator');
const { bundle } = require('./bundle-private.cjs');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'plugin');
const finalDestination = path.join(root, 'protected/tech-ai-assistant-app');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const parse = code => acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
const privateKeys = new Set(['__test', '__features', '__context', '__launcher']);
function stripPrivateExports(code) {
  let found;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ObjectExpression') {
      const keys = node.properties.map(property => property.key && (property.key.name || property.key.value));
      if (keys.includes('plugin') && keys.includes('__test')) found = node;
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
  }
  walk(parse(code));
  if (!found) throw new Error('Cannot safely identify private test exports');
  const properties = found.properties.filter(property => !privateKeys.has(property.key.name || property.key.value));
  if (properties.length !== 1 || (properties[0].key.name || properties[0].key.value) !== 'plugin') throw new Error('Unexpected production export contract');
  return code.slice(0, found.start) + '{' + properties.map(property => code.slice(property.start, property.end)).join(',') + '}' + code.slice(found.end);
}
function run(program, args, env = {}) {
  const result = cp.spawnSync(program, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed (${result.status})`);
}
async function build() {
  process.chdir(root);
  const args = process.argv.slice(2);
  let seed = 904;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--grafana') continue;
    if (args[i] === '--seed') { seed = Number(args[++i]); continue; }
    throw new Error('Unknown option: ' + args[i]);
  }
  if (!Number.isInteger(seed) || seed < 1 || seed > 2147483647) throw new Error('Seed must be an integer from 1 to 2147483647');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'plugin.json')));
  if (manifest.id !== 'tech-ai-assistant-app') throw new Error('Unexpected plugin ID');
  if (!fs.readFileSync(path.join(source, 'module.js'), 'utf8').includes(`PLUGIN_VERSION = "${manifest.info.version}"`)) throw new Error('Source module and manifest versions differ');
  const originalHashes = Object.fromEntries(fs.readdirSync(source).map(name => [name, hash(fs.readFileSync(path.join(source, name)))]));
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  const stage = fs.mkdtempSync(path.join(root, 'work/protection-stage-'));
  const destination = path.join(stage, 'release/tech-ai-assistant-app'), testOutput = path.join(stage, 'unit');
  fs.mkdirSync(destination, { recursive: true }); fs.mkdirSync(testOutput, { recursive: true });
  const report = { version: manifest.info.version, seed, toolchain: { node: process.version, terser: require('terser/package.json').version, obfuscator: require('javascript-obfuscator/package.json').version }, files: [], sourceHashes: originalHashes };
  const names = fs.readdirSync(source).sort();
  if (names.some(name => !/\.(js|json|svg)$/.test(name))) throw new Error('Review new assets before adding them to protected delivery');
  for (const name of names) {
    const input = fs.readFileSync(path.join(source, name));
    if (!name.endsWith('.js')) { fs.writeFileSync(path.join(destination, name), input); continue; }
    console.log(`[protect] ${name}: Terser`);
    const prepared = name === 'module.js' ? bundle(input.toString('utf8'), source) : input.toString('utf8');
    const minified = await terser.minify(prepared, {
      ecma: 2020, module: false, compress: { passes: 2, unsafe: false },
      mangle: { toplevel: true, reserved: ['define', 'require', 'exports', 'module'] },
      format: { comments: false, ascii_only: true }, sourceMap: false,
    });
    console.log(`[protect] ${name}: control flow + string obfuscation`);
    const started = performance.now();
    const full = obfuscator.obfuscate(minified.code, {
      target: 'browser-no-eval', seed: report.seed, compact: true,
      identifierNamesGenerator: 'hexadecimal', identifiersPrefix: 't' + names.indexOf(name) + '_',
      renameGlobals: false, renameProperties: false, transformObjectKeys: false,
      controlFlowFlattening: true, controlFlowFlatteningThreshold: 0.2,
      stringArray: true, stringArrayThreshold: 0.65, stringArrayEncoding: ['rc4'],
      stringArrayRotate: true, stringArrayShuffle: true, stringArrayIndexShift: true,
      stringArrayCallsTransform: true, stringArrayCallsTransformThreshold: 0.5,
      stringArrayWrappersCount: 2, stringArrayWrappersChainedCalls: true,
      numbersToExpressions: true, splitStrings: true, splitStringsChunkLength: 12,
      deadCodeInjection: false, debugProtection: false, selfDefending: false,
      disableConsoleOutput: false, sourceMap: false,
      reservedNames: ['^define$', '^require$', '^module$', '^exports$'],
      reservedStrings: ['^plugin$', '^__test$', '^__features$', '^__context$', '^__launcher$'],
    }).getObfuscatedCode();
    parse(full); new vm.Script(full, { filename: name });
    fs.writeFileSync(path.join(testOutput, name), full);
    const shipped = name === 'module.js' ? stripPrivateExports(full) : full;
    parse(shipped); new vm.Script(shipped, { filename: name });
    if (name === 'module.js') fs.writeFileSync(path.join(destination, name), shipped);
    report.files.push({ name, inputBytes: input.length, outputBytes: Buffer.byteLength(shipped), sha256: hash(shipped), buildMs: Math.round(performance.now() - started) });
  }
  const deliveryNames = ['logo.svg', 'module.js', 'plugin.json'];
  if (JSON.stringify(fs.readdirSync(destination).sort()) !== JSON.stringify(deliveryNames)) throw new Error('Unexpected files in protected output');
  console.log('[protect] unit tests: source');
  const tests = fs.readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.js')).map(name => 'test/' + name);
  run(process.execPath, ['--test', '--test-isolation=none', ...tests]);
  console.log('[protect] unit tests: obfuscated modules (private test hooks only in work/)');
  run(process.execPath, ['--require', './scripts/protected-test-register.cjs', '--test', '--test-isolation=none', ...tests], { PROTECTED_TEST_DIR: testOutput });
  report.initialization = require('./verify-protected.cjs').verify(source, destination);
  for (const [name, expected] of Object.entries(originalHashes)) if (hash(fs.readFileSync(path.join(source, name))) !== expected) throw new Error('Source changed: ' + name);
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  console.log('[protect] ZIP packaging');
  const stageOutput = path.join(stage, 'zip');
  run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', './scripts/package.ps1', '-PluginPath', destination, '-OutputSuffix', '-protected', '-OutputDirectory', stageOutput]);
  fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
  if (process.argv.includes('--grafana')) run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', './scripts/test-protected-grafana.ps1', '-PluginPath', destination]);
  fs.mkdirSync(finalDestination, { recursive: true });
  if (path.relative(fs.realpathSync(root), fs.realpathSync(finalDestination)) !== path.join('protected', 'tech-ai-assistant-app')) throw new Error('Protected output resolves outside its expected directory');
  const known = new Set(names);
  if (fs.readdirSync(finalDestination).some(name => !known.has(name))) throw new Error('Unexpected files in final protected directory');
  for (const name of fs.readdirSync(finalDestination)) {
    const stat = fs.lstatSync(path.join(finalDestination, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('Protected output contains a link/non-file: ' + name);
  }
  for (const name of names) if (!deliveryNames.includes(name) && fs.existsSync(path.join(finalDestination, name))) fs.unlinkSync(path.join(finalDestination, name));
  for (const name of deliveryNames) fs.copyFileSync(path.join(destination, name), path.join(finalDestination, name));
  const archiveName = `${manifest.id}-${manifest.info.version}-protected.zip`;
  const finalArchive = path.join(root, 'output', archiveName);
  fs.copyFileSync(path.join(stageOutput, archiveName), finalArchive + '.tmp');
  fs.renameSync(finalArchive + '.tmp', finalArchive);
  report.archiveSha256 = hash(fs.readFileSync(finalArchive));
  report.grafanaTested = args.includes('--grafana');
  fs.writeFileSync(path.join(root, 'test-results/protection-report.json'), JSON.stringify(report, null, 2));
  const stageReal = fs.realpathSync(stage);
  if (!stageReal.startsWith(fs.realpathSync(path.join(root, 'work')) + path.sep) || !path.basename(stageReal).startsWith('protection-stage-')) throw new Error('Unsafe staging cleanup');
  fs.rmSync(stageReal, { recursive: true });
  console.log(`[protect] PASS: protected/${manifest.id}; output/${manifest.id}-${manifest.info.version}-protected.zip`);
}
if (require.main === module) build().catch(error => { console.error('[protect] FAILED:', error.stack); process.exitCode = 1; });
module.exports = { stripPrivateExports };
