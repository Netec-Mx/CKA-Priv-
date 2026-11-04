import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditLab, run } from './repair_step_ids.mjs';

const make = ids => [
  '---', 'course_id: curso-demo', 'lab_id: l001', 'tracking: true', '---',
  '## Tarea 1', '{% assign tracking_task_id = "t001" %}',
  ...ids.map((id, i) => `- {% include step_label.html id="${id}" %} Paso académico ${i+1}.`),
  ''
].join('\n');

test('IDs duplicados y saltos se vuelven consecutivos; sólo cambia id de include', () => {
  const source = make(['s001','s002','s045','s045','s006']);
  const report = auditLab(source);
  assert.deepEqual(report.changes.map(c => [c.from,c.to]), [
    ['s045','s003'], ['s045','s004'], ['s006','s005']
  ]);
  assert.equal(report.changes[1].reason.startsWith('duplicado'), true);
  assert.deepEqual(auditLab(report.source).changes, []);
  assert.equal(report.source.replace(/id="s\d{3}"/g, 'id="STEP"'),
    source.replace(/id="s\d{3}"/g, 'id="STEP"'));
});

test('comentarios HTML no generan pasos y conservan texto', () => {
  const source = make(['s001','s045']) +
    '\n<!-- {% include step_label.html id="s009" %} -->\n';
  const report = auditLab(source);
  assert.equal(report.count, 2);
  assert.match(report.source, /id="s002".*Paso académico 2/);
  assert.match(report.source, /<!-- {% include step_label.html id="s009" %} -->/);
});

test('Lab con tracking false se omite', () => {
  const source = make(['s045']).replace('tracking: true','tracking: false');
  const result = auditLab(source);
  assert.equal(result.skipped,true);
  assert.equal(result.source,source);
});

test('IDs ausentes se insertan en orden sin alterar instrucciones; inválidos fallan', () => {
  const source = make(['s001','s002']).replace('id="s002"', '');
  const report = auditLab(source);
  assert.deepEqual(report.changes.map(c => [c.from,c.to]), [['(sin id)','s002']]);
  assert.equal(report.count,2);
  assert.match(report.source, /step_label\.html\s+id="s002"\s*%}/);
  assert.equal(auditLab(report.source).changes.length,0);
  const withoutId = value => value.replace(/step_label\.html\s+(?:id="s\d{3}"\s*)?%}/g, 'step_label.html %}');
  assert.equal(withoutId(report.source), withoutId(source));
  assert.throws(() => auditLab(make(['s001']).replace('id="s001"','id="abc"')), /ID inválido/);
});

test('dry-run y check no escriben; apply respalda y es idempotente', async () => {
  const root = await mkdtemp(join(tmpdir(), 'step-id-audit-'));
  try {
    const folder = join(root,'labs','lab1');
    await mkdir(folder,{recursive:true});
    const lab = join(folder,'lab1.md');
    const original = make(['s001','s045','s003']);
    await writeFile(lab,original,'utf8');
    assert.equal(await run(['--root',root]), 0);
    assert.equal(await readFile(lab,'utf8'),original);
    assert.equal(await run(['--root',root,'--check']), 1);
    assert.equal(await readFile(lab,'utf8'),original);
    assert.equal(await run(['--root',root,'--apply']), 0);
    assert.deepEqual(auditLab(await readFile(lab,'utf8')).changes,[]);
    const backups = await readdir(join(root,'.step-id-backup'));
    assert.equal(backups.length,1);
    assert.equal(await readFile(join(root,'.step-id-backup',backups[0],'lab1','lab1.md'),'utf8'),original);
    assert.equal(await run(['--root',root,'--check']),0);
    assert.equal(await run(['--root',root,'--apply']),0);
    assert.equal((await readdir(join(root,'.step-id-backup'))).length,1);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('error en otro Lab impide modificación parcial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'step-id-atomic-'));
  try {
    for (const labNum of [1,2]) await mkdir(join(root,'labs',`lab${labNum}`),{recursive:true});
    const lab1 = join(root,'labs','lab1','lab1.md');
    const lab2 = join(root,'labs','lab2','lab2.md');
    const original=make(['s001','s045']);
    await writeFile(lab1,original);
    await writeFile(lab2,make(['s001']).replace('id="s001"','id="???"'));
    await assert.rejects(run(['--root',root,'--apply']),/ID inválido/);
    assert.equal(await readFile(lab1,'utf8'),original);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});
