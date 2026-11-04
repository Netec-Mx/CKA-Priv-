#!/usr/bin/env node
/** Patch only the LabControl integration points in existing Jekyll layouts.
 * Dry-run by default; backup touched layouts before applying any changes.
 */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const args=process.argv.slice(2);
const targetIdx=args.indexOf('--target');
if(targetIdx<0 || !args[targetIdx+1] || args.some((a,i)=>i!==targetIdx+1 && a!=='--target' && a!=='--apply')) {
  console.error('Uso: node scripts/update_existing_course_layouts.mjs --target /path/course [--apply]');
  process.exit(1);
}
const target=resolve(args[targetIdx+1]), apply=args.includes('--apply');
const paths=['_layouts/default.html','_layouts/lab.html'];
const anchor='<script src="{{ site.baseurl }}/assets/js/lab-progress.js"></script>';
const tracker='<script src="{{ site.baseurl }}/assets/js/lab-tracker.js"></script>';
const article='<article class="lab">';
const replacement=`<article class="lab"
  {% if page.course_id %}data-course-id="{{ page.course_id | escape }}"{% endif %}
  {% if page.lab_id %}data-lab-id="{{ page.lab_id | escape }}"{% endif %}
  {% if site.labcontrol_api_url %}data-tracking-api="{{ site.labcontrol_api_url | escape }}"{% endif %}
  data-tracking="{% if page.tracking == true %}true{% else %}false{% endif %}"
>`;
function update(path,original){
  if(path.endsWith('default.html')){
    if(original.includes(tracker)) return original;
    if(!original.includes(anchor)) throw Error('Punto de carga lab-progress.js no encontrado en default.html');
    return original.replace(anchor,anchor+'\n  '+tracker);
  }
  if(original.includes('data-course-id') && original.includes('data-lab-id') && original.includes('data-tracking-api') && original.includes('data-tracking')) return original;
  if(!original.includes(article)) throw Error('Etiqueta article.lab no reconocida; revisar manualmente');
  return original.replace(article,replacement);
}
try {
  const changes=[];
  for(const path of paths) {
    const filename=join(target,path),old=await readFile(filename,'utf8');
    const next=update(path,old);
    if(old!==next) changes.push({path,filename,next});
  }
  console.log(apply?'APPLY':'DRY RUN',target);
  changes.forEach(x=>console.log('Actualizar',x.path));
  if(!apply) {
    if(!changes.length) console.log('Layouts ya integrados.');
    else console.log('Sin cambios; usar --apply tras revisar.');
  } else if(changes.length){
    const backupRoot=join(target,'.labcontrol-template-backup',new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14)+'-'+randomUUID().slice(0,8));
    for(const x of changes){
      const dest=join(backupRoot,x.path);
      await mkdir(dirname(dest),{recursive:true});
      await copyFile(x.filename,dest);
    }
    for(const x of changes) await writeFile(x.filename,x.next,'utf8');
    console.log('Layouts actualizados:',changes.length,'Backup:',backupRoot);
  } else console.log('Layouts ya integrados.');
} catch(err){console.error('ERROR:',err.message);process.exitCode=1;}
