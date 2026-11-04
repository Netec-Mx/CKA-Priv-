import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/write_course_link_proof.mjs');
const proofA = 'a'.repeat(24) + '.' + 'b'.repeat(24);
const proofB = 'c'.repeat(24) + '.' + 'd'.repeat(24);
const run = (cwd, token, ...args) => spawnSync(process.execPath, [script, '--stdin', ...args], {
  cwd, env: { ...process.env, COURSE_ROOT: cwd }, input: token, encoding: 'utf8'
});

test('proof de vinculación: dry-run, escritura, no-reemplazo accidental y reemplazo explícito', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'well-known-proof-'));
  try {
    const path = join(dir, '.well-known/labcontrol-course-link.txt');
    const dry = run(dir, proofA);
    assert.equal(dry.status, 0, dry.stderr);
    await assert.rejects(readFile(path), /ENOENT/);
    const applied = run(dir, proofA, '--apply');
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal((await readFile(path, 'utf8')).trim(), proofA);
    const blocked = run(dir, proofB, '--apply');
    assert.notEqual(blocked.status, 0);
    assert.equal((await readFile(path, 'utf8')).trim(), proofA);
    const replaced = run(dir, proofB, '--apply', '--replace');
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.equal((await readFile(path, 'utf8')).trim(), proofB);
    assert.ok(!(applied.stdout + applied.stderr).includes(proofA));
    assert.deepEqual(await readdir(join(dir, '.well-known')), ['labcontrol-course-link.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rechaza credenciales y cadenas inválidas', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'well-known-invalid-'));
  try {
    assert.notEqual(run(dir, 'secret-token', '--apply').status, 0);
    assert.notEqual(run(dir, 'https://example.test', '--apply').status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
