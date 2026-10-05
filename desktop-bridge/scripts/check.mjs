import {readdir} from 'node:fs/promises';import {spawnSync} from 'node:child_process';
for(const dir of ['src','scripts','test','integration'])for(const name of await readdir(dir))if(/\.(js|cjs|mjs)$/.test(name)){
 const result=spawnSync(process.execPath,['--check',`${dir}/${name}`],{stdio:'inherit'});if(result.status!==0)process.exit(1);
}
