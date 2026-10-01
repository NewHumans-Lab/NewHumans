import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { assertLegacyEconomyFreeze } from './check-legacy-economy-freeze.js';

function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap((entry)=>{const p=path.join(dir,entry.name);return entry.isDirectory()?walk(p):[p]})}
for(const file of [...walk('src'),...walk('scripts'),...walk('tests')].filter((f)=>f.endsWith('.js'))) execFileSync(process.execPath,['--check',file],{stdio:'inherit'});

const ajv=new Ajv2020({allErrors:true,strict:true});
addFormats(ajv);
for(const file of walk('schemas').filter((f)=>f.endsWith('.json'))){
  const schema=JSON.parse(fs.readFileSync(file,'utf8'));
  ajv.compile(schema);
}
assertLegacyEconomyFreeze();
console.log('syntax, JSON Schema, and NH-012 Legacy Economy freeze checks passed');
