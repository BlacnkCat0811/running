import {useState} from 'react';
import {readFitnessSnapshot} from '@rai/api-contracts';
import type {ModelSnapshotsResponse, TrendResponse} from '@rai/api-contracts';
import {useRemote} from '../hooks.js';
import {AbilityChart} from './AbilityChart.js';
import {ErrorBlock,LoadingBlock} from './Feedback.js';

const refusalMessages:Record<'not_published'|'not_found'|'legacy',string>={
  not_published:'还没有已发布的模型版本；不会以当前模型回填历史。',
  not_found:'找不到这个模型版本，可能已被清理；不会用当前分数替代。',
  legacy:'该版本早于 V2 发布包，这里展示的是兼容读取结果，不是封存的 V2 证据。'
};

function HistoricalCurve({runId}:{runId:string}) {
  const report=useRemote<ModelSnapshotsResponse>(`/v1/model-snapshots?runId=${encodeURIComponent(runId)}`);
  if(report.loading)return <LoadingBlock label="正在读取已保存的历史模型"/>;
  if(report.error||!report.data)return <ErrorBlock message={report.error??'无法读取历史模型'} onRetry={()=>void report.reload()}/>;
  const response=report.data;
  if(response.status==='not_published'||response.status==='not_found'||response.status==='legacy'){
    return <p>{refusalMessages[response.status]}</p>;
  }
  const entry=response.snapshots.find(row=>row.domain==='fitness'&&row.key==='summary');
  const series=entry?readFitnessSnapshot(entry.payload):null;
  if(!series)return <p>此版本没有可展示的历史能力快照；不会以当前模型回填。</p>;
  const daily=series.daily.map(row=>({date:row.localDate,trueAbility:row.trueAbility,
    decayPoints:0,growthVelocityPerWeek:null,status:row.status,baselineEpochId:series.baselineEpochId}));
  const trend:TrendResponse={startDate:daily[0]!.date,endDate:daily.at(-1)!.date,daily,workouts:[],context:[],modelRuns:[]};
  return <>
    <p>展示所选版本的原始保存值，不是按新标尺重估；不得与另一 epoch 直接计算涨跌。</p>
    <AbilityChart trend={trend} height={240} showCa={false}/>
  </>;
}

export function HistoricalModelReview({runs}:{runs:TrendResponse['modelRuns']}) {
  const [selected,setSelected]=useState('');
  return <section className="panel" aria-label="历史模型查看">
    <h2>历史模型与基线</h2>
    <label className="field"><span>选择已保存的模型版本</span>
      <select value={selected} onChange={event=>setSelected(event.target.value)}>
        <option value="">选择版本后读取，不重新计算</option>
        {runs.map(run=><option key={run.id} value={run.id}>{run.modelVersion} · {run.date.slice(0,10)}{run.active?'（当前）':''}</option>)}
      </select>
    </label>
    {selected?<HistoricalCurve key={selected} runId={selected}/>:<p>基线更新会改变分数标尺，不代表更新当天体能突变。旧版本保留在历史快照中。</p>}
  </section>;
}
