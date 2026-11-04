#!/usr/bin/env node
/**
 * Publica el proof efímero de vinculación emitido por Lab Control.
 * Nunca contiene el token del usuario/authoring; es una prueba PUBLICABLE.
 */
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const root = resolve(process.env.COURSE_ROOT || '.');
const output = join(root, '.well-known', 'labcontrol-course-link.txt');
const apply = args.includes('--apply');
const replace = args.includes('--replace');
if (args.some(x => !['--stdin', '--apply', '--replace', '--help'].includes(x))) {
  throw Error('Argumento desconocido; usa --stdin [--apply] [--replace].');
}
if (args.includes('--help')) {
  console.log('Uso: [printf proof |] node scripts/write_course_link_proof.mjs --stdin [--apply] [--replace]');
} else {
  if (!args.includes('--stdin')) throw Error('Requiere --stdin para no exponer proof en argumentos/history.');
  let proof = '';
  for await (const chunk of process.stdin) proof += chunk.toString('utf8');
  proof = proof.trim();
  if (!/^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/.test(proof)) {
    throw Error('Proof inválido: espera exactamente dos segmentos base64url; obtener uno nuevo de Lab Control.');
  }
  // Solo se publica el proof de la URL declarada por la aplicación;
  // el sistema verificará criptográficamente el vínculo y su caducidad.
  let exists = false;
  try {
    const s = await lstat(output);
    if (!s.isFile() || s.isSymbolicLink()) throw Error('La ruta de proof no es un archivo regular.');
    exists = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (exists && !replace && (await readFile(output, 'utf8')).trim() !== proof) {
    throw Error('Ya existe proof: añade --replace explícitamente para actualizarlo.');
  }
  console.log('Archivo:', output);
  console.log('Estado:', exists ? 'revisar/reemplazar proof existente' : 'crear proof');
  if (!apply) console.log('DRY RUN: sin cambios; usa --apply.');
  else {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, proof + '\n', { encoding: 'utf8', mode: 0o644 });
    console.log('Proof público escrito. Publica Pages y luego confirma el vínculo desde Lab Control.');
  }
}
