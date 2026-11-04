#!/usr/bin/env node
/**
 * Adopta un curso Jekyll existente desde la plantilla central.
 * Dry-run por defecto. Nunca modifica instrucciones fuera de los metadatos
 * de seguimiento que inserta migrate_existing_course.py.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const template = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = flag => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};
const targetArg = option('--target');
const trackingId = option('--tracking-id') ?? option('--course-id');
const apply = args.includes('--apply');
const allowed = new Set(['--target', '--tracking-id', '--course-id', '--apply', '--help']);
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw Error('Argumento desconocido: ' + args[i]);
  if (args[i] !== '--apply' && args[i] !== '--help') i++;
}

function run(bin, argv, cwd = template) {
  const output = spawnSync(bin, argv, { cwd, encoding: 'utf8', stdio: 'inherit', shell: false });
  if (output.error) throw output.error;
  if (output.status !== 0) throw Error(bin + ' falló (exit ' + output.status + ')');
}

async function exists(path) {
  return stat(path).then(s => s.isFile()).catch(e => {
    if (e.code === 'ENOENT') return false;
    throw e;
  });
}

async function main() {
  if (args.includes('--help')) {
    console.log('Uso: node scripts/onboard_existing_course.mjs --target /ruta/curso --tracking-id ckapriv [--apply]');
    return;
  }
  if (!targetArg || !trackingId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trackingId))
    throw Error('Se requieren --target y --tracking-id (minúsculas, números o guiones).');
  const target = resolve(targetArg);
  if (target === template || !relative(template, target)) throw Error('No migrar la plantilla sobre sí misma.');
  for (const path of ['_config.yml', '_data/courses.yml', '_layouts/default.html']) {
    if (!await exists(join(target, path))) throw Error('No existe ' + path + ' en destino.');
  }
  const courseCatalog = await readFile(join(target, '_data/courses.yml'), 'utf8');
  if (!new RegExp('^' + trackingId + ':\\s*$', 'm').test(courseCatalog)) {
    throw Error('Tracking ID no encontrado en el catálogo existente; no modificarlo automáticamente.');
  }
  const migration = join(template, 'scripts/migrate_existing_course.py');
  const migrationArgs = [migration, '--template', template, '--target', target, '--course-id', trackingId];
  console.log('Curso:', target, 'Tracking ID:', trackingId);
  console.log('Modo:', apply ? 'APPLY' : 'DRY RUN');
  // El migrador valida TODOS los Labs antes de escribir cualquiera.
  run(process.platform === 'win32' ? 'python' : 'python3', migrationArgs);
  const include = '_includes/step_label.html';
  const current = join(target, include);
  if (!await exists(current)) throw Error('Falta el include step_label en el destino.');
  const source = join(template, include);
  const differs = !(await readFile(current)).equals(await readFile(source));
  console.log('Include estable:', differs ? 'requiere actualizar ' + include : 'ya actualizado');
  console.log('Runtime: ejecutar update_existing_course_runtime.mjs después de migrar.');
  console.log('Workflow Pages existente: NO se reemplaza automáticamente.');
  console.log('Identidad administrativa: verificar antes de registrar en LabControl.');
  if (!apply) return console.log('Sin modificaciones. Repetir con --apply después de revisar el reporte.');
  // Nunca aplicar sobre un directorio con cambios sin registrar.
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8' });
  if (status.status !== 0 || status.stdout.trim()) throw Error('El repositorio destino debe tener git status limpio.');
  // Verificación completa antes de cualquier escritura.
  run(process.platform === 'win32' ? 'python' : 'python3', [...migrationArgs, '--apply']);
  if (differs) {
    const backup = join(target, '.labcontrol-template-backup/initial-adoption', include);
    await mkdir(dirname(backup), { recursive: true });
    await copyFile(current, backup);
    await copyFile(source, current);
  }
  run(process.execPath, [join(template, 'scripts/update_existing_course_runtime.mjs'), '--target', target, '--apply']);
  run(process.execPath, [join(template, 'scripts/update_existing_course_layouts.mjs'), '--target', target, '--apply']);
  const ignorePath = join(target, '.gitignore');
  const ignore = await readFile(ignorePath, 'utf8').catch(e => e.code === 'ENOENT' ? '' : Promise.reject(e));
  const needed = ['.migration-backup-labcontrol/', '.labcontrol-template-backup/'];
  const missing = needed.filter(line => !ignore.split(/\r?\n/).includes(line));
  if (missing.length) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(ignorePath, '\n# Backups locales de migración LabControl\n' + missing.join('\n') + '\n');
  }
  run(process.execPath, ['scripts/generate_lab_manifest.mjs', '--all'], target);
  run(process.execPath, ['scripts/generate_course_catalog.mjs'], target);
  run(process.execPath, ['scripts/test_lab_manifest.mjs'], target);
  run(process.execPath, ['scripts/test_course_catalog.mjs'], target);
  run(process.platform === 'win32' ? 'python' : 'python3', ['scripts/verify_academic_integrity.py'], target);
  run(process.execPath, ['scripts/repair_step_ids.mjs', '--check'], target);
  run(process.execPath, [join(template, 'scripts/verify_course_runtime.mjs'), target]);
  console.log('Migración técnica aplicada y catálogo generado.');
  console.log('SIGUIENTE: revisar git diff, crear course.identity.json, actualizar workflow y validar Jekyll antes del push.');
}

main().catch(e => { console.error('ERROR:', e.message); process.exitCode = 1; });
