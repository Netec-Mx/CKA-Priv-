#!/usr/bin/env node
// Adopt an existing Jekyll course without modifying its catalog or Labs.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import process from 'node:process';

const root = resolve(process.env.COURSE_ROOT || '.');
const args = process.argv.slice(2);
const flag = name => { const i=args.indexOf(name); return i<0 ? undefined : args[i+1]; };
const code=flag('--code');
const trackingId=flag('--tracking-id');
const name=flag('--name');
const description=flag('--description') ?? '';
if (!code || !trackingId || !name ||
    !/^[A-Z0-9][A-Z0-9_]{1,49}$/.test(code) ||
    !/^[a-z0-9]{2,20}$/.test(trackingId) ||
    !name.trim() || name.length>200 || description.length>2000) {
  console.error('Uso: node scripts/adopt_existing_course.mjs --code TRFRM_GCP_INT --tracking-id terrgcpint --name "Nombre" [--description "Texto"]');
  process.exit(1);
}
const identityPath=join(root,'course.identity.json');
const coursesPath=join(root,'_data','courses.yml');
const configPath=join(root,'_config.yml');
try {
  const courses=await readFile(coursesPath,'utf8');
  if (!new RegExp('^'+trackingId+':\\s*$', 'm').test(courses)) {
    throw Error('No existe el Tracking ID en _data/courses.yml. No se altera el catálogo.');
  }
  const current=await readFile(identityPath,'utf8').catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
  if (current !== null) throw Error('La identidad ya existe; no se sobrescribe.');
  const config=await readFile(configPath,'utf8');
  if (!config.includes('  - .well-known')) {
    throw Error('Configura include: .well-known en _config.yml antes de publicar.');
  }
  const identity={version:1,code,trackingId,name,description};
  await writeFile(identityPath,JSON.stringify(identity,null,2)+'\n',{flag:'wx'});
  console.log('Identidad creada sin modificar _data/courses.yml ni los Labs.');
} catch(e) {
  console.error('Error:',e.message);
  process.exitCode=1;
}
