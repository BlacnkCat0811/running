import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import test from 'node:test';
import {RaiDatabase} from '@rai/storage-sqlite';
const cli=resolve('packages/application/src/model-v2-cli.ts');
test('maintenance CLI is dry-run by default and refuses ambiguous or unsupported arguments',async()=>{
 const root=mkdtempSync(join(tmpdir(),'rai-v2-cli-')),file=join(root,'db.sqlite');
 const store=await RaiDatabase.open(file,{createMigrationBackup:false});store.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');store.close();
 const hash=()=>createHash('sha256').update(readFileSync(file)).digest('hex');
 const run=(...args:string[])=>spawnSync(process.execPath,['--import','tsx',cli,'--database',file,...args],{encoding:'utf8'});
 try{
  const before=hash();
  const inspect=run('--action','inspect');assert.equal(inspect.status,0,inspect.stderr);assert.equal(JSON.parse(inspect.stdout).mode,'dry-run');
  const rebase=run('--action','rebase','--reference-start','2026-01-01T00:00:00Z','--as-of','2026-09-29T00:00:00Z');
  assert.equal(rebase.status,0,rebase.stderr);assert.equal(JSON.parse(rebase.stdout).mode,'dry-run');
  assert.equal(hash(),before);
  assert.notEqual(run('--apply','--apply').status,0);
  assert.notEqual(run('--unknown').status,0);
  assert.notEqual(run('--action','rollback','--apply').status,0);
  assert.notEqual(run('--action','rebase','--reference-start','2027-01-01','--as-of','2026-09-29').status,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
