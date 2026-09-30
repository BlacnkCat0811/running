import { canonicalSemanticJson, type ReplayDescriptorV2 } from "@rai/contracts";

export interface ReplayAdapter<Input,Output> { version:string; run(input:Input,descriptor:ReplayDescriptorV2):Output }
/** Frozen inputs, explicit clocks, separately versioned adapters; labels remain evaluator-owned. */
export function replayModelPair<Input,Output>(input:Input,descriptor:ReplayDescriptorV2,
  incumbent:ReplayAdapter<Input,Output>,candidate:ReplayAdapter<Input,Output>) {
  if (!Number.isFinite(Date.parse(descriptor.asOf))) throw new Error("Invalid replay asOf");
  if(descriptor.replayMode==="as_known_then"&&descriptor.availabilityUnknown) throw new Error("Unknown arrival times cannot certify as-known-then replay");
  if(!incumbent.version||!candidate.version)throw new Error("Replay adapter versions are required");
  const json=canonicalSemanticJson(input);
  const run=(adapter:ReplayAdapter<Input,Output>)=>{
    const frozen=JSON.parse(json) as Input;
    const freeze=(v:unknown):void=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}};
    freeze(frozen);
    const first=adapter.run(frozen,{...descriptor});
    const second=adapter.run(frozen,{...descriptor});
    const semantic=canonicalSemanticJson(first);
    if(semantic!==canonicalSemanticJson(second))throw new Error(`Non-deterministic replay: ${adapter.version}`);
    return {version:adapter.version,output:first,semantic};
  };
  const base=run(incumbent),next=run(candidate);
  return {descriptor,base,candidate:next,semanticEqual:base.semantic===next.semantic};
}
