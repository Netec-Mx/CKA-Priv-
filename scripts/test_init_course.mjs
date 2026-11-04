import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const source=resolve('scripts');
async function fixture(fn){
 const base=await mkdtemp(join(tmpdir(),'lab-course-init-'));
 try{await mkdir(join(base,'scripts'));await mkdir(join(base,'_data'));
  for(const f of ['init_course.mjs','read_course_identity.mjs','create_labs.sh']){
   await writeFile(join(base,'scripts',f),await readFile(join(source,f)));
  }
  return await fn(base);
 }finally{await rm(base,{recursive:true,force:true});}
}
test('inicializador propone ID compacto validable',async()=>{
 await fixture(async base=>{
  const run=spawnSync(process.execPath,[join(base,'scripts','init_course.mjs'),'--name','Terraform en Google Cloud Intermedio','--description','Descripción de prueba','--yes'],{
   cwd:base,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const data=JSON.parse(await readFile(join(base,'course.identity.json'),'utf8'));
  assert.equal(data.code,'TFGCPINT');assert.equal(data.trackingId,'tfgcpint');
  assert.match(await readFile(join(base,'_data','courses.yml'),'utf8'),/tfgcpint:/);
  const again=spawnSync(process.execPath,[join(base,'scripts','init_course.mjs')],{cwd:base,encoding:'utf8'});
  assert.notEqual(again.status,0);
  assert.match(again.stderr,/Ya existe course.identity.json/);
 });
});
test('create_labs reutiliza identidad y rechaza un ID diferente',async()=>{
 await fixture(async base=>{
  await writeFile(join(base,'course.identity.json'),JSON.stringify({
   version:1,name:'Terraform en Google Cloud Intermedio',code:'TFGCPINT',trackingId:'tfgcpint'}));
  const mismatch=spawnSync('bash',[join(base,'scripts','create_labs.sh'),'1','otrocurso','--dry-run'],{cwd:base,encoding:'utf8'});
  assert.notEqual(mismatch.status,0);
  assert.match(mismatch.stdout+mismatch.stderr,/no coincide con identidad canónica/);
  const good=spawnSync(process.execPath,[join(base,'scripts','read_course_identity.mjs'),join(base,'course.identity.json')],{cwd:base,encoding:'utf8'});
  assert.equal(good.status,0);assert.equal(good.stdout.trim(),'tfgcpint');
 });
});
