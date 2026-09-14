import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const repo = 'rj-liukaiwen/Ruizhi-Codex';
const version = (process.env.RELEASE_VERSION || '').replace(/^v/, '');
assert(/^\d+\.\d+\.\d+$/.test(version), 'Expected a three-part version');
if (process.env.GITHUB_REPOSITORY) assert.equal(process.env.GITHUB_REPOSITORY, repo);
const dir = 'dist/github-release';
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
async function api(route, method = 'GET', body) {
  const response = await fetch(`https://api.github.com/repos/${repo}${route}`, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  if (response.status === 404) return null;
  const data = await response.json(); assert(response.ok, `GitHub ${method} ${route}: ${response.status}`); return data;
}
async function digest(file, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm); for await (const part of createReadStream(file)) hash.update(part); return hash.digest(encoding);
}
const step = process.argv[2];
if (step === 'prepare') {
  assert(!await api(`/releases/tags/v${version}`), 'Release already exists; choose a new version');
  assert(!await api(`/git/ref/tags/v${version}`), 'Tag already exists; choose a new version');
  for (const file of ['config/rj-codex.json', 'package.json', 'package-lock.json']) {
    const data = JSON.parse(readFileSync(file)); data.version = version;
    if (data.packages?.['']) data.packages[''].version = version;
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  }
} else if (step === 'verify') {
  const yaml = require('js-yaml');
  const names = [`Ruizhi-Setup-${version}.exe`, `Ruizhi-Setup-${version}.exe.blockmap`, `ruizhi-windows-${version}.zip`, 'latest.yml', `latest-${version}.yml`];
  mkdirSync(dir, { recursive: true }); const artifacts = [];
  for (const name of names) {
    const file = path.join('dist/installer', name); assert(statSync(file).size > 0);
    artifacts.push({ name, bytes: statSync(file).size, sha256: await digest(file) }); copyFileSync(file, path.join(dir, name));
  }
  const feed = yaml.load(readFileSync(path.join(dir, 'latest.yml'), 'utf8'));
  assert.equal(String(feed.version), version);
  for (const item of feed.files) {
    assert.equal(path.basename(item.url), item.url);
    assert.equal(statSync(path.join(dir, item.url)).size, item.size);
    assert.equal(await digest(path.join(dir, item.url), 'sha512', 'base64'), item.sha512);
  }
  const config = JSON.parse(readFileSync('config/rj-codex.json'));
  assert.equal(config.updates.manifestUrl, `https://github.com/${repo}/releases/latest/download/latest.yml`);
  const inherited = readFileSync('inherited-tests.tap', 'utf8');
  const inheritedTests = { passed: Number(/^# pass (\d+)/m.exec(inherited)?.[1]), failed: Number(/^# fail (\d+)/m.exec(inherited)?.[1]) };
  assert(Number.isFinite(inheritedTests.passed) && Number.isFinite(inheritedTests.failed), 'Missing inherited test results');
  const report = { version, sourceSha: sha, runId: process.env.GITHUB_RUN_ID, signing: 'unsigned installer', artifacts, inheritedTests, accountAuthorization: 'not tested' };
  writeFileSync(path.join(dir, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(path.join(dir, 'SHA256SUMS.txt'), artifacts.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n');
  console.log(`Verified ${artifacts.length} Windows files and update feed hashes.`);
} else if (step === 'publish') {
  const report = JSON.parse(readFileSync(path.join(dir, 'build-report.json')));
  assert.equal(report.version, version); assert.equal(report.sourceSha, sha);
  const startup = JSON.parse(readFileSync('dist/startup-report.json', 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(startup.startup, 'passed');
  const body = `锐捷 Codex ${version} · Windows x64\n\n基于用户提供的 0910-d5fbc05 固定快照构建。\n\n- Ruizhi-Setup-${version}.exe：未签名 Windows 安装程序。\n- ruizhi-windows-${version}.zip：便携目录包。\n- 包含 SHA256SUMS、更新清单及构建记录。\n- 构建、Windows 打包回归、文件摘要与应用启动检查通过；真实账号登录、远端插件与模型服务未做授权验收。\n- 原快照历史测试：${report.inheritedTests.passed} 通过、${report.inheritedTests.failed} 失败（包含缺失的旧覆盖层路径及旧配置断言）。不代表全量源码回归通过，原始报告见 Actions diagnostics。\n- 非 OpenAI 官方发行版。第三方软件保留各自许可。\n\n源码提交：${sha}\n`;
  const release = await api('/releases', 'POST', { tag_name: `v${version}`, target_commitish: sha, name: `锐捷 Codex v${version} · Windows`, body, draft: true });
  const url = release.upload_url.replace(/\{.*$/, ''); assert.equal(new URL(url).hostname, 'uploads.github.com');
  const names = [...report.artifacts.map(a => a.name), 'build-report.json', 'SHA256SUMS.txt'];
  assert.deepEqual(readdirSync(dir).sort(), [...names].sort());
  for (const name of names) {
    const file = path.join(dir, name); const bytes = statSync(file).size;
    const response = await fetch(`${url}?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes) }, body: createReadStream(file), duplex: 'half' });
    assert(response.ok, `Upload failed: ${name} (${response.status})`); const asset = await response.json();
    assert.equal(asset.digest, `sha256:${await digest(file)}`); console.log(`Uploaded and verified ${name}`);
  }
  const complete = await api(`/releases/${release.id}`); assert.equal(complete.assets.length, names.length);
  const published = await api(`/releases/${release.id}`, 'PATCH', { draft: false, prerelease: false, make_latest: 'true' });
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Release: ${published.html_url}\n\nWindows x64, unsigned installer.\n`);
} else { throw new Error('Expected prepare, verify or publish'); }
