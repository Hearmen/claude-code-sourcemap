#!/usr/bin/env node
/**
 * fix-deps.js
 *
 * 这个脚本用于修复 extract-src 的依赖环境。它执行以下操作：
 * 1. 从根目录的 cli.js.map 中提取 source map 里包含、但 npm install 没有安装的缺失文件
 * 2. 为缺失的包生成最小化的 package.json
 * 3. 修复 scoped 包的名字
 * 4. 修复包的 exports 字段，确保 Bun 能正确解析入口
 *
 * 用法：
 *   node fix-deps.js
 *
 * 建议工作流：
 *   1. 修改 package.json 的 dependencies
 *   2. rm -rf node_modules package-lock.json && npm install --legacy-peer-deps
 *   3. node fix-deps.js
 */

const fs = require('fs');
const path = require('path');

const MAP_PATH = path.join(__dirname, '..', 'cli.js.map');
const NODE_MODULES = path.join(__dirname, 'node_modules');

function main() {
  if (!fs.existsSync(MAP_PATH)) {
    console.error('Error: cli.js.map not found at', MAP_PATH);
    process.exit(1);
  }

  console.log('Parsing source map...');
  const map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  const { sources, sourcesContent } = map;

  if (!sources || !sourcesContent) {
    console.error('Error: source map is missing sources or sourcesContent');
    process.exit(1);
  }

  let extracted = 0;
  let skipped = 0;

  // Phase 1: Extract missing files from source map
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    if (!src.includes('node_modules')) continue;
    const content = sourcesContent[i];
    if (content == null) continue;

    const rel = src.replace(/^\.\.\//, '');
    const outPath = path.join(__dirname, rel);

    if (fs.existsSync(outPath)) {
      skipped++;
      continue;
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content);
    extracted++;
  }
  console.log(`Extracted ${extracted} files, skipped ${skipped}`);

  // Phase 2: Generate missing package.json files
  const pkgDirs = new Map();
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    if (!src.includes('node_modules')) continue;
    const rel = src.replace(/^\.\.\//, '');
    const parts = rel.split('/');
    if (parts.length < 3) continue;

    let pkgName, pkgDirParts;
    if (parts[1].startsWith('@')) {
      if (parts.length < 4) continue;
      pkgName = parts[1] + '/' + parts[2];
      pkgDirParts = parts.slice(0, 3);
    } else {
      pkgName = parts[1];
      pkgDirParts = parts.slice(0, 2);
    }

    const pkgDir = path.join(__dirname, ...pkgDirParts);
    if (!pkgDirs.has(pkgDir)) {
      pkgDirs.set(pkgDir, pkgName);
    }
  }

  let fixedPkgJson = 0;
  for (const [pkgDir, pkgName] of pkgDirs) {
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) continue;

    const candidates = [
      'index.js', 'index.mjs', 'index.ts', 'index.tsx',
      'source/index.js', 'source/index.mjs', 'source/index.ts',
      'dist/index.js', 'dist/index.mjs', 'dist/index.ts',
      'lib/index.js', 'lib/index.mjs', 'lib/index.ts',
      'cjs/index.js', 'cjs/react.development.js', 'cjs/react.production.js',
      'react.js', 'react.development.js',
      'src/index.ts', 'src/index.js'
    ];

    let main = null;
    for (const c of candidates) {
      if (fs.existsSync(path.join(pkgDir, c))) {
        main = c;
        break;
      }
    }

    const pkgJson = {
      name: pkgName,
      version: '0.0.0-sourcemap',
      type: 'module',
      exports: {
        './*': './*'
      }
    };
    if (main) pkgJson.main = main;

    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2));
    fixedPkgJson++;
  }
  console.log(`Generated ${fixedPkgJson} missing package.json files`);

  // Phase 3: Fix scoped package names
  let fixedNames = 0;
  for (const entry of fs.readdirSync(NODE_MODULES, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('@')) continue;
    const scopeDir = path.join(NODE_MODULES, entry.name);
    for (const sub of fs.readdirSync(scopeDir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const pkgDir = path.join(scopeDir, sub.name);
      const pkgJsonPath = path.join(pkgDir, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) continue;

      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const correctName = entry.name + '/' + sub.name;
      if (pkg.name !== correctName) {
        pkg.name = correctName;
        fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));
        fixedNames++;
      }
    }
  }
  console.log(`Fixed ${fixedNames} scoped package names`);

  // Phase 4: Fix exports for sourcemap-extracted packages
  let fixedExports = 0;
  for (const entry of fs.readdirSync(NODE_MODULES, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(NODE_MODULES, entry.name);
      for (const sub of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (sub.isDirectory()) {
          if (fixPackageExports(path.join(scopeDir, sub.name))) fixedExports++;
        }
      }
    } else {
      if (fixPackageExports(path.join(NODE_MODULES, entry.name))) fixedExports++;
    }
  }
  console.log(`Fixed ${fixedExports} package exports`);

  // Phase 5: Create essential stubs for missing private files
  const stubs = [
    { file: 'node_modules/@anthropic-ai/mcpb/dist/types.js', content: 'export {};\n' },
    { file: 'node_modules/@anthropic-ai/foundry-sdk/internal/utils/uuid.mjs', content: 'export function uuid() { return "stub-uuid"; }\n' },
    { file: 'node_modules/@anthropic-ai/foundry-sdk/internal/utils/sleep.mjs', content: 'export function sleep() { return Promise.resolve(); }\n' },
    { file: 'node_modules/@anthropic-ai/foundry-sdk/dist/utils/uuid.mjs', content: 'export function uuid() { return "stub-uuid"; }\n' },
    { file: 'node_modules/@anthropic-ai/foundry-sdk/dist/utils/sleep.mjs', content: 'export function sleep() { return Promise.resolve(); }\n' },
    { file: 'node_modules/@anthropic-ai/foundry-sdk/dist/utils/bytes.mjs', content: 'export function encodeUTF8() { return new Uint8Array(); }\n' },
    { file: 'node_modules/fs-extra/lib/index.js', content: `const noop = () => {};
module.exports = {
  readFileSync: noop, writeFileSync: noop, existsSync: () => false,
  ensureDirSync: noop, copySync: noop, removeSync: noop,
  mkdirsSync: noop, mkdirpSync: noop, outputFileSync: noop,
  readJsonSync: () => ({}), writeJsonSync: noop, pathExistsSync: () => false,
};\n` },
    { file: 'node_modules/fs-extra/package.json', content: '{"name":"fs-extra","version":"0.0.0-stub","main":"lib/index.js"}\n' },
  ];

  let createdStubs = 0;
  for (const stub of stubs) {
    const p = path.join(__dirname, stub.file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, stub.content);
      createdStubs++;
    }
  }
  console.log(`Created ${createdStubs} essential stubs`);

  console.log('\nDone! You can now run: bun run build');
}

function fixPackageExports(pkgDir) {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return false;

  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  if (pkg.version !== '0.0.0-sourcemap') return false;

  const candidates = [
    pkg.main,
    'index.js', 'index.mjs', 'index.ts', 'index.tsx',
    'source/index.js', 'source/index.mjs', 'source/index.ts',
    'dist/index.js', 'dist/index.mjs', 'dist/index.ts',
    'lib/index.js', 'lib/index.mjs', 'lib/index.ts',
    'cjs/index.js', 'main.js', 'main.mjs',
    'src/index.ts', 'src/index.js'
  ].filter(Boolean);

  let main = null;
  for (const c of candidates) {
    if (fs.existsSync(path.join(pkgDir, c))) {
      main = c;
      break;
    }
  }

  if (!main) return false;

  if (!pkg.exports) pkg.exports = {};
  if (!pkg.exports['.']) {
    pkg.exports['.'] = './' + main;
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));
    return true;
  }
  return false;
}

main();
