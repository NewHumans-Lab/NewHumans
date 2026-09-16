import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap((entry)=>{const p=path.join(dir,entry.name);return entry.isDirectory()?walk(p):[p]})}
for(const file of [...walk('src'),...walk('scripts'),...walk('tests')].filter((f)=>f.endsWith('.js'))) execFileSync(process.execPath,['--check',file],{stdio:'inherit'});
for(const file of walk('schemas').filter((f)=>f.endsWith('.json'))) JSON.parse(fs.readFileSync(file,'utf8'));
console.log('syntax and schema JSON checks passed');
