#!/usr/bin/env node
import {parseArgs} from "node:util";
import {writeFileSync,mkdirSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {replayPublishedLoadSnapshot} from "../packages/application/src/load-replay-data.js";
const {values}=parseArgs({options:{
  database:{type:"string"},out:{type:"string"},"as-of":{type:"string"},timezone:{type:"string",default:"Asia/Shanghai"}
}});
if(!values.database||!values["as-of"])throw new Error("--database and --as-of are required");
const db=new DatabaseSync(resolve(values.database),{readOnly:true});
try {
  const report=replayPublishedLoadSnapshot(db,values["as-of"],values.timezone!);
  const json=JSON.stringify(report,null,2)+"\n";
  if(values.out){const out=resolve(values.out);mkdirSync(dirname(out),{recursive:true});writeFileSync(out,json);}
  else process.stdout.write(json);
}finally{db.close();}
