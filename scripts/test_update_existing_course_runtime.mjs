import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, prepareLayout } from './update_existing_course_runtime.mjs';

const baseLayout = `<!doctype html>
<script src="{{ site.baseurl }}/assets/js/lab-progress.js"></script>
<script src="{{ site.baseurl }}/assets/js/lab-tracker.js"></script>`;

test('layout carga demo primero, es idempotente', () => {
  const updated = prepareLayout(baseLayout);
  assert.match(updated, /lab-demo-context\.js[\s\S]*lab-progress\.js/);
  assert.equal(prepareLayout(updated), updated);
  assert.throws(() => prepareLayout('<p>sin seguimiento</p>'), /Falta script/);
});

test('curso existente: dry-run no toca labs; apply guarda respaldo; repetir es idempotente', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webpages-course-runtime-'));
  try {
    await mkdir(join(dir, 'labs', 'lab1'), { recursive: true });
    await mkdir(join(dir, '_layouts'), { recursive: true });
    await mkdir(join(dir, 'assets', 'js'), { recursive: true });
    await writeFile(join(dir, 'labs/lab1/lab1.md'), '# Instrucciones existentes\n');
    await writeFile(join(dir, '_layouts/default.html'), baseLayout);
    await writeFile(join(dir, 'assets/js/lab-progress.js'), '/* OLD */');
    await writeFile(join(dir, 'assets/js/lab-tracker.js'), '/* OLD */');
    const original = await readFile(join(dir, 'labs/lab1/lab1.md'), 'utf8');
    await run(['--target', dir]);
    assert.equal(await readFile(join(dir, 'assets/js/lab-progress.js'), 'utf8'), '/* OLD */');
    await run(['--target', dir, '--apply']);
    const html = await readFile(join(dir, '_layouts/default.html'), 'utf8');
    assert.match(html, /lab-demo-context\.js[\s\S]*lab-progress\.js/);
    assert.notEqual(await readFile(join(dir, 'assets/js/lab-progress.js'), 'utf8'), '/* OLD */');
    assert.equal(await readFile(join(dir, 'labs/lab1/lab1.md'), 'utf8'), original);
    const folders = await readdir(join(dir, '.labcontrol-template-backup'));
    assert.equal(folders.length, 1);
    assert.equal(await readFile(join(dir, '.labcontrol-template-backup', folders[0], 'assets/js/lab-progress.js'), 'utf8'), '/* OLD */');
    await run(['--target', dir, '--apply']);
    assert.equal((await readdir(join(dir, '.labcontrol-template-backup'))).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
