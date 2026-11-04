#!/usr/bin/env node
/**
 * Actualiza solo el runtime de seguimiento de un curso Jekyll existente.
 * Dry-run por defecto. No toca contenido académico, identidades ni catálogos.
 */
import { readFile, writeFile, mkdir, copyFile, lstat, access } from 'node:fs/promises';
import { resolve, join, relative, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const templateRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowed = [
  'assets/js/lab-demo-context.js',
  'assets/js/lab-progress.js',
  'assets/js/lab-tracker.js'
];
const layoutPath = '_layouts/default.html';
const demoScript = '<script src="{{ site.baseurl }}/assets/js/lab-demo-context.js"></script>';
const progressScript = '<script src="{{ site.baseurl }}/assets/js/lab-progress.js"></script>';

export function prepareLayout(html) {
  if (html.includes(demoScript)) {
    const a = html.indexOf(demoScript);
    const b = html.indexOf(progressScript);
    if (b < 0 || a > b) throw Error('El contexto demo debe cargarse antes de lab-progress.js.');
    return html;
  }
  if (!html.includes(progressScript)) throw Error('Falta script lab-progress.js en layout; integrar manualmente.');
  return html.replace(progressScript, demoScript + '\n  ' + progressScript);
}

async function existingFile(path) {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink() || !st.isFile()) throw Error('Ruta no regular o enlace simbólico: ' + path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}
function flag(args, name) {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}
export async function run(args = process.argv.slice(2)) {
  const allowedArgs = new Set(['--target', '--apply', '--help']);
  for (let i = 0; i < args.length; i++) {
    if (!allowedArgs.has(args[i])) throw Error('Argumento desconocido: ' + args[i]);
    if (args[i] === '--target') i++;
  }
  if (args.includes('--help')) {
    console.log('Uso: node scripts/update_existing_course_runtime.mjs --target /ruta/curso [--apply]');
    return;
  }
  const targetArg = flag(args, '--target');
  if (!targetArg || targetArg.startsWith('--')) throw Error('Requiere --target /ruta/curso');
  const target = resolve(targetArg);
  if (target === templateRoot || relative(templateRoot, target) === '') {
    throw Error('No actualizar la plantilla sobre sí misma.');
  }
  if (!await existingFile(join(target, layoutPath))) throw Error('Falta layout original en destino.');
  await access(join(target, 'labs'));
  const currentLayout = await readFile(join(target, layoutPath), 'utf8');
  const newLayout = prepareLayout(currentLayout);
  const candidates = [];
  for (const rel of allowed) {
    const from = join(templateRoot, rel);
    const to = join(target, rel);
    if (!await existingFile(from)) throw Error('Runtime fuente no disponible: ' + rel);
    const exists = await existingFile(to);
    const same = exists && (await readFile(from)).equals(await readFile(to));
    if (!same) candidates.push({ rel, from, to, exists });
  }
  if (currentLayout !== newLayout) candidates.push({ rel: layoutPath, to: join(target, layoutPath), exists: true, content: newLayout });
  // Un curso antiguo puede no tener el ignore nuevo de la plantilla.
  const ignoreRel = '.gitignore';
  const ignoreTo = join(target, ignoreRel);
  const hasIgnore = await existingFile(ignoreTo);
  const originalIgnore = hasIgnore ? await readFile(ignoreTo, 'utf8') : '';
  if (!originalIgnore.split(/\r?\n/).some(line => line.trim() === '.labcontrol-template-backup/')) {
    const updatedIgnore = originalIgnore
      + (originalIgnore && !originalIgnore.endsWith('\n') ? '\n' : '')
      + '\n# Backups de actualización técnica de Lab Control\n.labcontrol-template-backup/\n';
    candidates.push({ rel: ignoreRel, to: ignoreTo, exists: hasIgnore, content: updatedIgnore });
  }

  console.log('Destino:', target);
  console.log('Modo:', args.includes('--apply') ? 'APPLY' : 'DRY RUN');
  for (const c of candidates) console.log((c.exists ? 'Actualizar ' : 'Agregar ') + c.rel);
  if (!candidates.length) return console.log('Runtime ya actualizado: sin cambios.');
  if (!args.includes('--apply')) return console.log('No se modificaron archivos. Usar --apply para confirmar.');
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0,14) + '-' + randomUUID().slice(0,8);
  const backup = join(target, '.labcontrol-template-backup', stamp);
  // Snapshot de todos los archivos que se reemplazarán ANTES de modificar uno solo.
  for (const c of candidates.filter(x => x.exists)) {
    const saved = join(backup, c.rel);
    await mkdir(dirname(saved), { recursive: true });
    await copyFile(c.to, saved);
  }
  for (const c of candidates) {
    await mkdir(dirname(c.to), { recursive: true });
    if (c.content !== undefined) await writeFile(c.to, c.content, 'utf8');
    else await copyFile(c.from, c.to);
  }
  console.log('Actualizados:', candidates.length);
  console.log('Respaldo local (NO subir a Git):', backup);
  console.log('Validar con tests, build Jekyll y git diff antes de publicar.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error('Error:', error.message); process.exitCode = 1; });
}
