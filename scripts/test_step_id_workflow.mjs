import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(resolve(root, '.github/workflows/pages.yml'), 'utf8');

test('push auto-repara con commit del bot antes de manifests y Pages', () => {
  const validation = workflow.indexOf('name: Validate LabControl tooling');
  const repair = workflow.indexOf('name: Repair Step IDs safely on push');
  const manifest = workflow.indexOf('name: Generate LabControl course catalog');
  const deployment = workflow.indexOf('name: Deploy to GitHub Pages');
  assert.ok(validation >= 0 && validation < repair);
  assert.ok(repair < manifest && manifest < deployment);
  assert.match(workflow, /node scripts\/repair_step_ids\.mjs --apply/);
  assert.match(workflow, /node scripts\/repair_step_ids\.mjs --check/);
  assert.match(workflow, /git commit -m "fix\(labcontrol\): normalizar Step IDs automáticamente"/);
  assert.match(workflow, /git push origin HEAD:main/);
  assert.match(workflow, /contents: write/);
});

test('proteger historial Lab Control y evitar sobrescribir otro push', () => {
  assert.match(workflow, /LABCONTROL_API_URL: \$\{\{ vars\.LABCONTROL_API_URL \}\}/);
  assert.match(workflow, /LABCONTROL_SYNC_TOKEN: \$\{\{ secrets\.LABCONTROL_SYNC_TOKEN \}\}/);
  assert.match(workflow, /if \[\[ -n "\$\{LABCONTROL_API_URL\}" \|\| -n "\$\{LABCONTROL_SYNC_TOKEN\}" \]\]/);
  assert.match(workflow, /git ls-remote origin refs\/heads\/main/);
  assert.match(workflow, /if \[\[ "\$\{remote_sha\}" != "\$\{GITHUB_SHA\}" \]\]/);
  assert.ok(workflow.indexOf('LABCONTROL_API_URL:') < workflow.indexOf('node scripts/repair_step_ids.mjs --apply'));
});

test('sin aplicación automática fuera del paso protegido', () => {
  assert.equal((workflow.match(/node scripts\/repair_step_ids\.mjs --apply/g) ?? []).length, 1);
  assert.match(workflow, /node --test scripts\/test_repair_step_ids\.mjs/);
  assert.match(workflow, /git diff --check/);
});
