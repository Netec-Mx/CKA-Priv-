#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

export function normalizeBaseUrl(value) {
  if (!value) throw Error('LABCONTROL_API_URL es obligatorio.');
  const url=new URL(value);
  if (!['http:','https:'].includes(url.protocol)) throw Error('La API requiere HTTP(S).');
  return url.href.replace(/\/+$/,'').replace(/\/api$/,'');
}
export function validateIdentity(identity) {
  if(!/^[A-Z0-9]{2,16}$/.test(identity.code??'') ||
     !/^[a-z0-9]{2,20}$/.test(identity.trackingId??'') ||
     !String(identity.name??'').trim())throw Error('Identidad canónica inválida.');
  return {code:identity.code,trackingId:identity.trackingId,name:identity.name,
    description:identity.description??''};
}
export async function syncIdentity({root=process.cwd(),apiUrl=process.env.LABCONTROL_API_URL,token=process.env.LABCONTROL_AUTHORING_SYNC_TOKEN,fetcher=fetch}={}){
  const identity=validateIdentity(JSON.parse(await readFile(resolve(root,'course.identity.json'),'utf8')));
  if(!token?.startsWith('lcat_'))throw Error('LABCONTROL_AUTHORING_SYNC_TOKEN requerido (prefijo lcat_).');
  const base=normalizeBaseUrl(apiUrl);
  const response=await fetcher(base+'/api/authoring-sync/courses/identity',{
    method:'POST',
    headers:{authorization:'Bearer '+token,'content-type':'application/json'},
    body:JSON.stringify(identity),
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Error('Lab Control rechazó el registro (HTTP '+response.status+'): '+JSON.stringify(result));
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  syncIdentity().then(result=>{
    console.log('Curso '+(result.created?'registrado':'existente')+': '+result.courseTrackingId);
    console.log('ID administrativo: '+result.courseId);
  }).catch(error=>{console.error('Error:',error.message);process.exitCode=1;});
}
