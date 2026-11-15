#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function digest(roots){
 const entries=[];
 const visit=relative=>{const p=path.join(root,relative);if(fs.statSync(p).isDirectory()){for(const name of fs.readdirSync(p).sort())visit(path.join(relative,name));}else entries.push([relative,createHash('sha256').update(fs.readFileSync(p)).digest('hex')]);};
 for(const p of roots)visit(p);
 return {sha256:createHash('sha256').update(JSON.stringify(entries)).digest('hex'),files:entries.length};
}
const result={source:digest(['src','scripts','skills','plugins','experiments','package.json','package-lock.json','tsconfig.json']),artifact:digest(['dist'])};
if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');else console.log(JSON.stringify(result,null,2));
