import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const archive = '.work/source-snapshot.zip';
const expected = '2a4e04da1e688af735eefd16c5e18c0241a4089a2dafd5e8e663b5a5b7ce808d';
const url = 'https://github.com/rj-liukaiwen/Ruizhi-Codex/releases/download/source-0.3.1442-0910-d5fbc05/Ruizhi-Codex-Source-0.3.1442-0910-d5fbc05.zip';
mkdirSync('.work', { recursive: true });
if (!existsSync(archive)) {
  const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
  assert(response.ok, `Snapshot HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(archive, { flags: 'wx' }));
}
const hash = createHash('sha256'); for await (const part of createReadStream(archive)) hash.update(part);
assert.equal(hash.digest('hex'), expected, 'Source archive checksum differs');
// Restore only the vendor tree; never overwrite the checked-out workflow/code.
execFileSync('tar.exe', ['-xf', archive, 'vendor/codex-desktop/windows/current/app'], { stdio: 'inherit', windowsHide: true });
const manifest = JSON.parse(readFileSync('vendor/codex-desktop/windows/current/source-manifest.json'));
for (const [file, spec] of Object.entries(manifest.files)) {
  const bytes = readFileSync(`vendor/codex-desktop/windows/current/app/${file}`);
  assert.equal(bytes.length, spec.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), spec.sha256, `Pinned source differs: ${file}`);
}
console.log('Source archive and pinned desktop executables verified.');
