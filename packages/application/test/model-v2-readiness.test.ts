import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {RaiDatabase} from '@rai/storage-sqlite';
import {healthTypes} from '@rai/contracts';
import {assessDatedReadiness} from '@rai/readiness';
import {loadDatedReadiness,loadDatedRecoveryFacts} from '../src/model-v2-snapshots.js';

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

test('the facts interface and the assessment path cannot drift apart',async()=>{
  // §4.1：判定只有 `assessDatedReadiness` 一处，事实装配只有 `loadDatedRecoveryFacts` 一处。
  // 这条断言把"两者是同一件事"钉死 —— 否则回放器读到的"事实"与实际生产的判定可以来自
  // 两套不同的 SQL，而两边各自看起来都正确。多组输入都要求逐位相等。
  const root=mkdtempSync(join(tmpdir(),'rai-facts-parity-')),store=await RaiDatabase.open(join(root,'db.sqlite'),{createMigrationBackup:false});
  try{
    const insertRhr=store.database.prepare(`INSERT INTO health_records(id,type,source_name,source_category,unit,value_numeric,start_at,end_at,metadata_json,raw_attributes_json)
      VALUES (?,?,'Watch','apple_watch','count/min',?,?,?,'{}','{}')`);
    for(let day=10;day<=27;day++)insertRhr.run(`rhr-${day}`,healthTypes.restingHeartRate,50+day%3,`2026-09-${day}T02:00:00Z`,`2026-09-${day}T02:01:00Z`);
    const insertNight=store.database.prepare(`INSERT INTO canonical_nights(id,wake_date,timezone_identifier,kind,source_name,source_category,source_rank,has_stages,sleep_onset_at,wake_at,asleep_union_minutes,in_bed_union_minutes,awake_minutes,stage_minutes_json,segment_count,provenance_json,computed_at)
      VALUES (?,?,'Asia/Shanghai','main','Watch','apple_watch',1,?,?,?,?,?,?,'{}',1,'{}',?)`);
    for(let day=20;day<=29;day++){
      const wakeDate=`2026-09-${String(day).padStart(2,'0')}`;
      const prev=new Date(`${wakeDate}T00:00:00Z`);prev.setUTCDate(prev.getUTCDate()-1);
      const wakeAt=`${prev.toISOString().slice(0,10)}T22:00:00Z`;
      insertNight.run(`night-${day}`,wakeDate,1,wakeAt,wakeAt,400+day,430,30,wakeAt);
    }
    for(const [asOf,label] of [['2026-09-29T08:00:00Z','publication unknown'],['2026-09-25T08:00:00Z','earlier day']] as const){
      const facts=loadDatedRecoveryFacts(store.database,asOf,'Asia/Shanghai');
      assert.deepEqual(loadDatedReadiness(store.database,asOf,'Asia/Shanghai'),assessDatedReadiness(facts),label);
      // 事实里必须真的带着信号，否则这条等价断言只是"两边都是空的"。
      assert.notEqual(facts.signals.sleep.value,null,label);
    }
    store.database.prepare("INSERT INTO import_manifest VALUES ('import_completed_at',?)").run('2026-09-29T06:00:00Z');
    const asOf='2026-09-29T08:00:00Z';
    const facts=loadDatedRecoveryFacts(store.database,asOf,'Asia/Shanghai');
    assert.deepEqual(loadDatedReadiness(store.database,asOf,'Asia/Shanghai'),assessDatedReadiness(facts),'publication known');
    assert.equal(facts.signals.rhr.availabilitySource,'dataset_publication_upper_bound');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
