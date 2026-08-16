#!/usr/bin/env node
// 生成 version.js：把当前 git 提交号（短号+完整号+提交时间+工作区是否干净）写成面板设置区显示用的版本信息。
// 由 .githooks/post-commit / post-checkout / post-merge 在提交/切换/合并后自动调用，也可手动运行：
//   node scripts/gen-version.js
// version.js 被 .gitignore 忽略（不入库）：入库会让每次提交后它都比 HEAD 新，产生永远"有未提交改动"的脏标记。
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8' }).trim(); }
  catch (e) { return null; }
}

const root = run('git rev-parse --show-toplevel');
if (!root) {
  // 非 git 仓库：写 dev 占位，面板显示"dev"
  fs.writeFileSync(path.join(__dirname, '..', 'version.js'),
    "// 自动生成：scripts/gen-version.js（非 git 仓库占位）\nwindow.EXT_VERSION = { short: 'dev', full: '', dirty: false, date: '' };\n");
  console.log('version.js → dev（非 git 仓库）');
  process.exit(0);
}

const short = run('git rev-parse --short HEAD') || 'dev';
const full = run('git rev-parse HEAD') || '';
const dirty = run('git status --porcelain') !== '';
const rawDate = run('git log -1 --format=%cI') || '';
const date = rawDate ? rawDate.replace('T', ' ').slice(0, 16) : '';

const content = `// 本文件由 scripts/gen-version.js 自动生成（提交/切换/合并后自动刷新），勿手改
window.EXT_VERSION = {
  short: ${JSON.stringify(short + (dirty ? '*' : ''))},
  full: ${JSON.stringify(full)},
  dirty: ${JSON.stringify(dirty)},
  date: ${JSON.stringify(date)}
};
`;
fs.writeFileSync(path.join(root, 'version.js'), content);
console.log('version.js → ' + short + (dirty ? '（有未提交改动）' : ''));
