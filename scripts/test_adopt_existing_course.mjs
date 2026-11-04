import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const script=resolve('scripts/adopt_existing_course.mjs');
test('adopts existing course and preserves catalog',async()=>{
 const root=await mkdtemp(join(tmpdir(),'adopt-course-'));
 try{
  await mkdir(join(root,'_data'));
  const original='terrgcpint:\n  title: Terraform\n  labs:\n    - id: lab1\n';
  await writeFile(join(root,'_data/courses.yml'),original);
  await writeFile(join(root,'_config.yml'),'include:\n  - .well-known\n');
  const args=[script,'--code','TRFRM_GCP_INT','--tracking-id','terrgcpint','--name','Terraform'];
  const run=spawnSync(process.execPath,args,{env:{...process.env,COURSE_ROOT:root},encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const metadata=JSON.parse(await readFile(join(root,'course.identity.json'),'utf8'));
  assert.equal(metadata.code,'TRFRM_GCP_INT');
  assert.equal(metadata.trackingId,'terrgcpint');
  assert.equal(await readFile(join(root,'_data/courses.yml'),'utf8'),original);
  const repeat=spawnSync(process.execPath,args,{env:{...process.env,COURSE_ROOT:root},encoding:'utf8'});
  assert.notEqual(repeat.status,0);
 }finally{await rm(root,{force:true,recursive:true});}
});
