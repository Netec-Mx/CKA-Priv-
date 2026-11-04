import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syncIdentity,normalizeBaseUrl} from './sync_course_identity.mjs';

test('normaliza URL de Lab Control sin duplicar /api',()=>{
 assert.equal(normalizeBaseUrl('https://example.test/api/'),'https://example.test');
 assert.equal(normalizeBaseUrl('https://example.test'),'https://example.test');
});
test('sincroniza curso vacío y usa bearer sin imprimir token',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sync-ident-'));
 try{
 await writeFile(join(root,'course.identity.json'),JSON.stringify({
 code:'TFGCPINT',trackingId:'tfgcpint',name:'Terraform GCP Intermedio'}));
 const result=await syncIdentity({root,apiUrl:'https://example.test/api',token:'lcat_test',
 fetcher:async (url,opts)=>{
  assert.equal(url,'https://example.test/api/authoring-sync/courses/identity');
  assert.equal(opts.headers.authorization,'Bearer lcat_test');
  assert.equal(JSON.parse(opts.body).trackingId,'tfgcpint');
  return {ok:true,json:async()=>({courseId:'id1',courseTrackingId:'tfgcpint',created:true})};
 }});
 assert.equal(result.created,true);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('rechaza conflicto de código de la API',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sync-ident-'));
 try{
 await writeFile(join(root,'course.identity.json'),JSON.stringify({code:'TFGCPINT',trackingId:'tfgcpint',name:'Terraform'}));
 await assert.rejects(syncIdentity({root,apiUrl:'https://example.test',token:'lcat_test',
 fetcher:async()=>({ok:false,status:409,json:async()=>({message:'Course code is already in use'})})}),/HTTP 409/);
 }finally{await rm(root,{recursive:true,force:true});}
});
