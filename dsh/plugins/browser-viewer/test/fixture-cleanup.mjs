import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,basename,sep} from 'node:path';

export async function removeFixture(directory,prefix){
  const target=resolve(directory),parent=resolve(tmpdir());
  if(!target.startsWith(parent+sep)||!basename(target).startsWith(prefix))throw new Error('Unsafe fixture cleanup.');
  await rm(target,{recursive:true,force:true,maxRetries:8,retryDelay:200});
}
