#!/usr/bin/env node
/**
 * Audita y normaliza SOLO IDs de {% include step_label.html id="sNNN" %}.
 * Inserta id="sNNN" cuando el include no declara ninguno.
 *
 * --check: falla con exit code 1 si un Lab presenta IDs fuera de secuencia.
 * (sin argumentos): dry-run sin escrituras.
 * --apply: reescribe únicamente el atributo id, de s001 a sNNN por Lab.
 *
 * IMPORTANTE: cambiar IDs afecta referencias históricas de progreso en Lab Control.
 * No ejecutar --apply ni publicar cambios sin revisar el diff y las sesiones del curso.
 */
import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const STEP_INCLUDE = /{%\s*include\s+step_label\.html\b[\s\S]*?%}/g;
const ID_ATTRIBUTE = /\bid\s*=\s*(["'])([^"']*)\1/;
const LAB_FILE = /^lab([1-9]\d*)$/;
const FRONTMATTER_TRACKING_OFF = /^tracking:\s*(?:false|no|0)\s*$/m;
const FRONTMATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---/;

function maskedComments(source) {
  // Conservar offsets/longitud para reemplazos exactos del contenido original.
  return source.replace(/<!--[\s\S]*?-->/g, block => block.replace(/[^\r\n]/g, ' '));
}

function stepId(n) {
  if (n > 999) throw Error('Hay más de 999 Steps en un Lab; excede sNNN.');
  return 's' + String(n).padStart(3, '0');
}

export function auditLab(source, name = 'Lab') {
  const visible = maskedComments(source);
  const frontMatter = visible.match(FRONTMATTER);
  if (frontMatter && FRONTMATTER_TRACKING_OFF.test(frontMatter[1])) {
    return { name, skipped: true, changes: [], count: 0, source };
  }
  let match;
  let count = 0;
  const changes = [];
  const replacements = [];
  const seen = new Map();
  STEP_INCLUDE.lastIndex = 0;
  while ((match = STEP_INCLUDE.exec(visible)) !== null) {
    count++;
    const raw = source.slice(match.index, match.index + match[0].length);
    const attr = raw.match(ID_ATTRIBUTE);
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    if (!attr) {
      const wanted = stepId(count);
      changes.push({ line, from: '(sin id)', to: wanted, reason: 'ID faltante' });
      const begin = match.index + raw.lastIndexOf('%}');
      replacements.push({ begin, end: begin, text: ` id="${wanted}"` });
      continue;
    }
    const oldId = attr[2];
    if (!/^s\d{3}$/.test(oldId)) {
      throw Error(`${name} línea ${line}: ID inválido "${oldId}", esperado sNNN.`);
    }
    const wanted = stepId(count);
    if (oldId !== wanted) {
      const reason = seen.has(oldId) ? `duplicado (primera línea ${seen.get(oldId)})` : 'salto u orden incorrecto';
      changes.push({ line, from: oldId, to: wanted, reason });
      const begin = match.index + attr.index + attr[0].indexOf(oldId);
      replacements.push({ begin, end: begin + oldId.length, text: wanted });
    }
    if (!seen.has(oldId)) seen.set(oldId, line);
  }
  let updated = source;
  for (const r of replacements.reverse()) {
    updated = updated.slice(0, r.begin) + r.text + updated.slice(r.end);
  }
  return { name, skipped: false, count, changes, source: updated };
}

function usage() {
  return 'Uso: node scripts/repair_step_ids.mjs [--check | --apply] [--root /ruta/curso] [--lab lab1]\n' +
    'Sin flags usa dry-run. --apply modifica Markdown: revisar progreso histórico ANTES de usarlo.';
}

export async function run(args = process.argv.slice(2)) {
  let mode = 'dry-run';
  let root = process.cwd();
  let only = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help') { console.log(usage()); return 0; }
    if (a === '--check' || a === '--apply') {
      if (mode !== 'dry-run') throw Error('--check y --apply son mutuamente excluyentes.');
      mode = a.slice(2);
    } else if (a === '--root' || a === '--lab') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error('Falta valor para ' + a);
      if (a === '--root') root = resolve(value);
      else { if (!LAB_FILE.test(value)) throw Error('--lab exige labN.'); only = value; }
    } else throw Error('Argumento desconocido: ' + a);
  }
  const folder = join(root, 'labs');
  const dirs = (await readdir(folder, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && LAB_FILE.test(entry.name) && (!only || entry.name === only))
    .sort((a, b) => +a.name.slice(3) - +b.name.slice(3));
  if (!dirs.length) throw Error('No se localizaron Labs; revisar --root y --lab.');

  const updates = [];
  let issues = 0;
  for (const dir of dirs) {
    const filename = join(folder, dir.name, dir.name + '.md');
    const source = await readFile(filename, 'utf8');
    const result = auditLab(source, dir.name);
    if (result.skipped) { console.log(dir.name + ': tracking deshabilitado; omitido.'); continue; }
    if (!result.count) throw Error(dir.name + ': no contiene Steps rastreables.');
    console.log(`${dir.name}: ${result.count} Steps, ${result.changes.length} correcciones`);
    for (const c of result.changes) {
      console.log(`  línea ${c.line}: ${c.from} -> ${c.to} (${c.reason})`);
    }
    issues += result.changes.length;
    if (result.changes.length) updates.push({ filename, content: result.source });
  }
  if (mode === 'check') {
    if (issues) { console.error(`ERROR: ${issues} IDs desordenados/duplicados. Corrige con --apply tras revisar.`); return 1; }
    console.log('OK: todos los Step IDs son secuenciales y únicos dentro de su Lab.');
    return 0;
  }
  if (mode === 'apply') {
    if (!updates.length) return 0;
    // Prevalidar todos los Labs y guardar un respaldo de cada archivo original.
    // Nunca modificar el documento académico sin respaldar primero.
    const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
      + '-' + randomUUID().slice(0, 8);
    const backupRoot = join(root, '.step-id-backup', stamp);
    for (const update of updates) {
      const relativeLab = update.filename.slice(folder.length + 1);
      const backupPath = join(backupRoot, relativeLab);
      await mkdir(join(backupRoot, relativeLab.split(/[\\/]/)[0]), { recursive: true });
      await copyFile(update.filename, backupPath);
    }
    for (const update of updates) await writeFile(update.filename, update.content, 'utf8');
    console.log(`Actualizados ${updates.length} Labs; ${issues} Step IDs. Backup: ${backupRoot}`);
    console.log('Revisa git diff y regenera manifests; NO sincronizar automáticamente con Lab Control.');
  } else {
    console.log(`DRY-RUN: ${issues} cambios propuestos; no se modificó ningún archivo. Usar --apply tras revisar.`);
  }
  return 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  run().then(code => { process.exitCode = code; }).catch(error => {
    console.error('Error:', error.message);
    process.exitCode = 1;
  });
}
