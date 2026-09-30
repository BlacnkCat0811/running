import {readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {replayFitnessVersions,type ModelReplayInput} from "./model-replay-v2.js";
const args=process.argv.slice(2);
const option=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const path=option('--input');if(!path||path.startsWith('--'))throw new Error('--input requires a saved as-of source-facts JSON file');
const input=JSON.parse(readFileSync(resolve(path),'utf8')) as ModelReplayInput;
const output=JSON.stringify(replayFitnessVersions(input),null,2)+'\n';
const target=option('--out');if(target)writeFileSync(resolve(target),output);else process.stdout.write(output);
