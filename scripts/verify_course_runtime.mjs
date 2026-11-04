#!/usr/bin/env node
/** Validate that migrated Jekyll layouts actually load LabControl runtime. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const read = path => readFileSync(resolve(root,path),'utf8');
const defaultLayout = read('_layouts/default.html');
const labLayout = read('_layouts/lab.html');
const config = read('_config.yml');
const errors = [];
const scripts = ['lab-demo-context.js','lab-progress.js','lab-tracker.js'];
let previous = -1;
for (const file of scripts) {
  const script = 'assets/js/' + file;
  const idx = defaultLayout.indexOf(script);
  if (idx < 0) errors.push('Missing script loader in default layout: ' + script);
  if (idx >= 0 && idx < previous) errors.push('Incorrect runtime load order: ' + file);
  previous = idx;
}
for (const field of ['data-course-id','data-lab-id','data-tracking-api','data-tracking']) {
  if (!labLayout.includes(field)) errors.push('Missing ' + field + ' in lab layout');
}
if (!/labcontrol_api_url:\s*["']https:\/\//.test(config)) errors.push('Missing HTTPS labcontrol_api_url in Jekyll config');
if (!/include:\s*\n\s*-\s*\.well-known/m.test(config)) errors.push('Missing .well-known Jekyll include');
if(errors.length){for(const e of errors) console.error('ERROR:',e); process.exitCode=1;}
else console.log('OK: runtime loaders, lab tracking attributes and Jekyll API configuration.');
