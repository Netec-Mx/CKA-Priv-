#!/usr/bin/env node
// Inicializa una identidad de curso una sola vez, sin crear Labs.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import process from 'node:process';

const root=resolve(process.env.COURSE_ROOT||'.');
const identityPath=join(root,'course.identity.json');
const yamlPath=join(root,'_data','courses.yml');
const normalize=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
export function suggest(name){
 const words=normalize(name).split(/[^A-Z0-9]+/).filter(Boolean);
 const tech={TERRAFORM:'TF',KUBERNETES:'K8S',DATABRICKS:'DBRICKS',AMAZON:'AWS',GOOGLE:'GCP',CLOUD:'',MICROSOFT:'MS',AZURE:'AZ',PYTHON:'PY',NEPTUNE:'NEPTUNE'};
 const levels={INTERMEDIO:'INT',INTERMEDIATE:'INT',AVANZADO:'ADV',ADVANCED:'ADV',BASICO:'FND',BASIC:'FND',FUNDAMENTOS:'FND',FOUNDATIONS:'FND',PROFESIONAL:'PRO',PROFESSIONAL:'PRO'};
 const stop=new Set(['EN','DE','DEL','PARA','CON','Y','THE','ON','OF','AND']);
 const codes=words.filter(w=>!stop.has(w)).map(w=>levels[w]??tech[w]??(w.length<=4?w:w.slice(0,3))).filter(Boolean);
 const code=codes.join('').slice(0,16);
 return {code,trackingId:code.toLowerCase()};
}
export function valid(code,id){
 return /^[A-Z0-9]{2,16}$/.test(code)&&/^[a-z0-9]{2,20}$/.test(id);
}
const yamlQuote=s=>JSON.stringify(s).replace(/\\n/g,' ');
async function run(){
 try{await readFile(identityPath,'utf8');throw Error('Ya existe course.identity.json. No se modifica la identidad existente.');}
 catch(e){if(e.code!=='ENOENT')throw e;}
 const args=process.argv.slice(2);
 const valueOf=flag=>{const i=args.indexOf(flag);return i>=0?args[i+1]:undefined;};
 const batch=args.includes('--yes');
 if(batch && !valueOf('--name'))throw Error('--yes requiere --name.');
 const cli=batch?null:createInterface({input:process.stdin,output:process.stdout});
 try{
  const name=(batch?valueOf('--name'):await cli.question('Nombre del curso: ')).trim();
  if(!name)throw Error('El nombre es obligatorio.');
  const description=batch?(valueOf('--description')??''):(await cli.question('Descripción: ')).trim();
  const proposal=suggest(name);
  console.log('Sugerencia editable. Confirma un código reconocible y breve.');
  const code=(batch?(valueOf('--code')??proposal.code):((await cli.question('Código ['+proposal.code+']: ')).trim()||proposal.code)).toUpperCase();
  const trackingId=(batch?(valueOf('--tracking-id')??code.toLowerCase()):((await cli.question('Tracking ID ['+proposal.trackingId+']: ')).trim()||proposal.trackingId)).toLowerCase();
  if(!valid(code,trackingId))throw Error('Código: 2-16 caracteres A-Z/0-9. Tracking ID: 2-20 caracteres a-z/0-9.');
  const answer=batch?'si':(await cli.question('¿Confirmar identidad? (s/N): ')).trim().toLowerCase();
  if(answer!=='s'&&answer!=='si')return console.log('Cancelado; no se modificaron archivos.');
  const old=await readFile(yamlPath,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
  if(new RegExp('^'+trackingId+':\\s*$','m').test(old))throw Error('Tracking ID ya existe en _data/courses.yml.');
  // La identidad canónica se escribe solo tras validar; no se sobrescribe el catálogo existente.
  const data={version:1,code,trackingId,name,description};
  await writeFile(identityPath,JSON.stringify(data,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  await mkdir(join(root,'_data'),{recursive:true});
  await writeFile(yamlPath,old+(old&&!old.endsWith('\n')?'\n':'')+'\n'+trackingId+':\n  title: '+yamlQuote(name)+'\n  intro: '+yamlQuote(description)+'\n  labs: []\n','utf8');
  console.log('Identidad creada: '+identityPath);
  console.log('Para registrar identidad: node scripts/sync_course_identity.mjs (requiere API y token de authoring autorizados).');
 }finally{cli?.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url)))run().catch(e=>{console.error('Error:',e.message);process.exitCode=1;});
