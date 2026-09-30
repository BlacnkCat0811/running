import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {RaiDatabase} from '@rai/storage-sqlite';
import {healthTypes} from '@rai/contracts';
import {loadDatedReadiness} from '../src/model-v2-snapshots.js';

test('raw RHR uses a publication upper bound, not source-created time or an unrelated freshness date',async()=>{
 const root=mkdtempSync(join(tmpdir(),'rai-dated-rhr-')),store=await RaiDatabase.open(join(root,'db.sqlite'),{createMigrationBackup:false});
 try{
  const insert=store.database.prepare(`INSERT INTO health_records(id,type,source_name,source_category,unit,value_numeric,start_at,end_at,metadata_json,raw_attributes_json)
    VALUES (?,?,'Watch','apple_watch','count/min',?,?,?,'{}','{}')`);
  for(let day=20;day<=27;day++)insert.run(`prior-${day}`,healthTypes.restingHeartRate,50,`2026-09-${day}T02:00:00Z`,`2026-09-${day}T02:01:00Z`);
  insert.run('today',healthTypes.restingHeartRate,60,'2026-09-29T04:00:00Z','2026-09-29T04:01:00Z');
  const asOf='2026-09-29T08:00:00Z';
  assert.equal(loadDatedReadiness(store.database,asOf,'Asia/Shanghai').coverage,'none');
  store.database.prepare("INSERT INTO import_manifest VALUES ('import_completed_at',?)").run('2026-09-29T06:00:00Z');
  const known=loadDatedReadiness(store.database,asOf,'Asia/Shanghai');
  assert.equal(known.coverage,'partial');assert.equal(known.signals.rhr.value,60);
  assert.equal(known.signals.rhr.baseline,50);
  assert.equal(known.signals.rhr.availabilitySource,'dataset_publication_upper_bound');
  assert.equal(loadDatedReadiness(store.database,'2026-09-29T05:00:00Z','Asia/Shanghai').coverage,'none');
  assert.equal(loadDatedReadiness(store.database,'2026-09-30T08:00:00Z','Asia/Shanghai').coverage,'none');
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
