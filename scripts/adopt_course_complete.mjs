#!/usr/bin/env node
/**
 * One-command adoption of an existing Jekyll course into the webpagesrepo
 * standard proven by TRFRM_GCP_INT. Dry-run by default.
 * Academic Lab Markdown is changed ONLY by migrate_existing_course.py,
 * which inserts tracking metadata; no text/commands are rewritten.
 */
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, copyFile, mkdir, stat, appendFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = new Map();
const flags = new Set(['--apply', '--help']);
const values = new Set(['--target', '--tracking-id', '--code', '--name', '--description']);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (flags.has(a)) { options.set(a, true); continue; }
  if (!values.has(a) || !args[i + 1] || args[i+1].startsWith('--')) throw Error('Argumento desconocido/incompleto: ' + a);
  if(options.has(a)) throw Error('Argumento duplicado: ' + a);
  options.set(a, args[++i]);
}
if (options.has('--help')) {
  console.log('Uso: node scripts/adopt_course_complete.mjs --target /ruta/curso --tracking-id ckapriv --code CKA_PRIV --name "Nombre" [--description "Descripción"] [--apply]');
  process.exit(0);
}
const target = resolve(options.get('--target') ?? '');
const trackingId = options.get('--tracking-id');
const code = options.get('--code');
const name = options.get('--name');
const description = options.get('--description') ?? '';
const apply = options.has('--apply');
if (!options.has('--target') || target === source) throw Error('--target debe apuntar al repositorio del curso');
if (!/^[a-z0-9]{2,20}$/.test(trackingId ?? '')) throw Error('tracking-id incompatible con LabControl (2-20 caracteres alfanuméricos)');
if (!/^[A-Z0-9][A-Z0-9_]{1,49}$/.test(code ?? '')) throw Error('code inválido según contrato LabControl');
if (!name || name.length > 200 || description.length > 2000) throw Error('Nombre/descripcion inválidos');

const command = (binary, argv, cwd = target) => {
  const x = spawnSync(binary, argv, {cwd, encoding: 'utf8', stdio: 'inherit', shell: false});
  if(x.error) throw x.error;
  if(x.status !== 0) throw Error(binary + ' finalizó con estado ' + x.status);
};
const node = (script, argv=[], cwd=target) => command(process.execPath, [join(source,'scripts',script), ...argv], cwd);
const python = (script, argv=[], cwd=target) => command(process.platform==='win32'?'python':'python3', [join(source,'scripts',script), ...argv], cwd);
const exists = async p => stat(p).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
const identityFile = join(target,'course.identity.json');
const lab1 = join(target,'labs/lab1/lab1.md');
const workflowPath = '.github/workflows/pages.yml';
const desiredIdentity = {version:1,code,trackingId,name,description};

const hasLabTracking = async () => {
  const text = await readFile(lab1,'utf8');
  return /^course_id:\s*[^\s]+\s*$/m.test(text) && /^lab_id:\s*l001\s*$/m.test(text);
};
async function assertIdentity() {
  if(!await exists(identityFile)) return;
  const prior = JSON.parse(await readFile(identityFile,'utf8'));
  if(prior.code!==code || prior.trackingId!==trackingId) throw Error('La identidad del curso ya existe y no coincide. No modificar IDs históricos.');
}
async function assertRepo() {
  for (const p of ['.git','labs','_data/courses.yml','_config.yml','_layouts/lab.html','_layouts/default.html']) {
    if(!await exists(join(target,p))) throw Error('Falta ' + p + ' en el curso');
  }
  const status=spawnSync('git',['status','--porcelain'],{cwd:target,encoding:'utf8'});
  if(status.status!==0 || status.stdout.trim()) throw Error('El repositorio del curso debe estar limpio antes de aplicar cambios');
  const catalog=await readFile(join(target,'_data/courses.yml'),'utf8');
  if(!catalog.split(/\r?\n/).some(line=>line.trim()===trackingId+':')) throw Error('No aparece el tracking ID en _data/courses.yml; revisar identidad sin inventar metadatos');
}
const migrationArgs=['--template',source,'--target',target,'--course-id',trackingId];
const changes = [];
async function stageFile(rel,content) {
  const dst=join(target,rel),prior=await exists(dst)?await readFile(dst,'utf8'):null;
  if(prior!==content) changes.push({rel,dst,prior,content});
}
async function installFiles() {
  // Refresh common technical assets from the central template, never course content.
  const shared = [
    '_includes/step_label.html',
    'scripts/generate_lab_manifest.mjs',
    'scripts/generate_course_catalog.mjs',
    'scripts/repair_step_ids.mjs',
    'scripts/lab_id_registry.mjs',
    'scripts/normalize_course_labs.mjs',
    'scripts/sync_lab_manifests.mjs',
    'scripts/sync_course_catalog.mjs',
    'scripts/read_course_identity.mjs',
    'scripts/write_course_link_proof.mjs'
  ];
  for (const rel of shared) {
    await stageFile(rel, await readFile(join(source,rel),'utf8'));
  }
  let workflow=await readFile(join(source,'docs/examples/standard-course-pages.yml'),'utf8');
  const sourceRevision=spawnSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'});
  if(sourceRevision.status!==0 || !/^[a-f0-9]{40}$/.test(sourceRevision.stdout.trim())) throw Error('No se pudo fijar el commit de la plantilla central');
  workflow=workflow.replace('ref: main','ref: '+sourceRevision.stdout.trim());
  await stageFile(workflowPath,workflow);
  const desired=JSON.stringify(desiredIdentity,null,2)+'\n';
  if(!await exists(identityFile)) await stageFile('course.identity.json',desired);
}
async function commitPreparedFiles() {
  if(!changes.length) return;
  const stamp=new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14)+'-'+randomUUID().slice(0,8);
  const backup=join(target,'.labcontrol-template-backup',stamp);
  for(const x of changes.filter(z=>z.prior!==null)) {
    const dest=join(backup,x.rel);
    await mkdir(dirname(dest),{recursive:true});
    await copyFile(x.dst,dest);
  }
  for(const x of changes){
    await mkdir(dirname(x.dst),{recursive:true});
    await writeFile(x.dst,x.content,'utf8');
  }
  console.log('Actualizaciones:',changes.map(x=>x.rel).join(', '));
  console.log('Respaldo en:',backup);
}
async function main() {
  await assertRepo();
  await assertIdentity();
  const migrated=await hasLabTracking();
  if(!migrated && await exists(join(target,'_data/labcontrol-identities.yml')))
    throw Error('Identidades parcialmente migradas. Revisar manualmente; no sobrescribir.');
  console.log('Curso:',name,'| Tracking:',trackingId,'| Estado:',migrated?'ya migrado':'sin migrar');
  console.log('Modo:',apply?'APPLY':'DRY RUN');
  if(!migrated) python('migrate_existing_course.py',migrationArgs);
  node('update_existing_course_runtime.mjs',['--target',target]);
  node('update_existing_course_layouts.mjs',['--target',target]);
  await installFiles();
  changes.forEach(x=>console.log(x.prior===null?'Crear:':'Actualizar:',x.rel));
  if(!apply) return console.log('DRY RUN completado. Sin archivos modificados; ejecuta --apply cuando esté aprobado.');
  if(!migrated) python('migrate_existing_course.py',[...migrationArgs,'--apply']);
  node('update_existing_course_runtime.mjs',['--target',target,'--apply']);
  node('update_existing_course_layouts.mjs',['--target',target,'--apply']);
  await commitPreparedFiles();
  const ignore=join(target,'.gitignore');
  let original=await readFile(ignore,'utf8').catch(e=>e.code==='ENOENT'?'':Promise.reject(e));
  const rules=['.migration-backup-labcontrol/','.labcontrol-template-backup/'];
  const missing=rules.filter(x=>!original.split(/\r?\n/).includes(x));
  if(missing.length) await appendFile(ignore,'\n# Backups locales de migracion\n'+missing.join('\n')+'\n');
  if(!migrated) python('verify_academic_integrity.py',[],target);
  node('verify_course_runtime.mjs',[target]);
  node('repair_step_ids.mjs',['--check','--root',target]);
  node('generate_lab_manifest.mjs',['--all']);
  node('generate_course_catalog.mjs');
  node('test_lab_manifest.mjs');
  node('test_course_catalog.mjs');
  command('git',['diff','--check']);
  console.log('ADOPCIÓN TÉCNICA LISTA. Validar Jekyll y diff; commit/push solo cuando lo apruebes.');
  console.log('URL prevista: https://netec-mx.github.io/'+(await readFile(join(target,'_config.yml'),'utf8')).match(/baseurl:\s*["']\/([^"']+)/)?.[1]+'/');
}
main().catch(e=>{console.error('ERROR:',e.message);process.exitCode=1;});
