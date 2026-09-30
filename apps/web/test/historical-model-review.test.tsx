import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,it,expect,vi} from 'vitest';
// vitest.config.ts 未开 globals / setupFiles，所以没有自动 DOM 清理；
// 本文件有多个用例，必须自己清，否则上一个 render 的节点会污染下一个的查询。
afterEach(cleanup);
const {remote}=vi.hoisted(()=>({remote:vi.fn()}));
vi.mock('../src/hooks.js',()=>({useRemote:remote}));
vi.mock('../src/components/AbilityChart.js',()=>({AbilityChart:({trend}:{trend:{daily:unknown[]}})=><div data-testid="saved-chart">{trend.daily.length} saved points</div>}));
import {HistoricalModelReview} from '../src/components/HistoricalModelReview.js';
it('loads only the selected saved epoch and never relabels it as a re-estimated curve',()=>{
  remote.mockReturnValue({loading:false,error:null,reload:vi.fn(),data:{status:'available',runId:'old',snapshots:[{domain:'fitness',key:'summary',payload:{lineage:{baselineEpochId:'epoch-old'},daily:[{local_date:'2026-01-01',true_ability:55,snapshot_status:'active'}]}}]}});
  render(<MemoryRouter><HistoricalModelReview runs={[{id:'old',date:'2026-01-01',modelVersion:'v1',active:false}]}/></MemoryRouter>);
  expect(remote).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'old'}});
  expect(remote).toHaveBeenCalledWith('/v1/model-snapshots?runId=old');
  expect(screen.getByTestId('saved-chart').textContent).toBe('1 saved points');
  expect(screen.getByText(/不是按新标尺重估/)).toBeTruthy();
});
it('surfaces a refusal status instead of drawing an empty curve for it',()=>{
  remote.mockReturnValue({loading:false,error:null,reload:vi.fn(),data:{status:'legacy',runId:'old',snapshots:[]}});
  render(<MemoryRouter><HistoricalModelReview runs={[{id:'old',date:'2026-01-01',modelVersion:'v1',active:false}]}/></MemoryRouter>);
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'old'}});
  expect(screen.getByText(/早于 V2 发布包/)).toBeTruthy();
  expect(screen.queryByTestId('saved-chart')).toBeNull();
});
it('treats an unexpected fitness payload as absent rather than reading fields off it',()=>{
  // `payload` is `unknown` by contract: a sealed `load`/`zones` snapshot, or a future
  // shape, must not be coerced into a fitness curve.
  remote.mockReturnValue({loading:false,error:null,reload:vi.fn(),data:{status:'available',runId:'old',snapshots:[
    {domain:'fitness',key:'summary',payload:{lineage:{baselineEpochId:'e'},days:[{local_date:'2026-01-01'}]}}
  ]}});
  render(<MemoryRouter><HistoricalModelReview runs={[{id:'old',date:'2026-01-01',modelVersion:'v1',active:false}]}/></MemoryRouter>);
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'old'}});
  expect(screen.getByText(/没有可展示的历史能力快照/)).toBeTruthy();
  expect(screen.queryByTestId('saved-chart')).toBeNull();
});

const readinessPayload=(overrides:Record<string,unknown>={})=>({
  asOf:'2026-01-05T07:00:00.000Z',localDate:'2026-01-05',coverage:'complete',
  assessment:'low_signal',state:'caution',
  stateEvidence:{method:'heuristic_rules',validationStatus:'not_empirically_validated',
    ruleSetVersion:'rai-readiness-ruleset-v1',validationTarget:null,validationReportId:null},
  score:null,scoreStatus:'not_calibrated',sleepStreak:true,reasonCodes:['sleep_below_baseline'],
  signals:{
    sleep:{name:'sleep',value:300,baseline:450,ratio:0.66,low:true,quality:'adequate'},
    hrv:{name:'hrv',value:60,baseline:60,ratio:1,low:false,quality:'adequate'},
    rhr:{name:'rhr',value:46,baseline:46,ratio:1,low:false,quality:'adequate'}
  },
  ...overrides
});
const savedRun=(snapshots:unknown[])=>({
  loading:false,error:null,reload:vi.fn(),
  data:{status:'available',runId:'old',snapshots:[
    {domain:'fitness',key:'summary',payload:{lineage:{baselineEpochId:'epoch-old'},daily:[{local_date:'2026-01-05',true_ability:55,snapshot_status:'active'}]}},
    ...snapshots
  ]}
});

it('R06: a saved readiness state keeps its heuristic label, coverage and reason codes',()=>{
  remote.mockReturnValue(savedRun([{domain:'readiness',key:'summary',payload:readinessPayload()}]));
  render(<MemoryRouter><HistoricalModelReview runs={[{id:'old',date:'2026-01-05',modelVersion:'v1',active:false}]}/></MemoryRouter>);
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'old'}});
  expect(screen.getByText(/恢复提示：需谨慎/)).toBeTruthy();
  expect(screen.getByText(/尚未经实证校准/)).toBeTruthy();
  expect(screen.getByText(/仅供训练安排参考/)).toBeTruthy();
  expect(screen.getByText(/依据：sleep_below_baseline/)).toBeTruthy();
  expect(screen.getByText(/规则集 rai-readiness-ruleset-v1/)).toBeTruthy();
  // 禁止出现的措辞：医学阈值/确诊/保证性结论。
  expect(screen.queryByText(/医学阈值/)).toBeNull();
  expect(screen.queryByText(/已证实/)).toBeNull();
});

it('R01/I02: no readiness claim is rendered when the sealed payload is absent or malformed',()=>{
  // 缺失 = 没有证据，不是"恢复良好"。回落成 no_low_signal 会把未知读成正常。
  remote.mockReturnValue(savedRun([]));
  render(<MemoryRouter><HistoricalModelReview runs={[{id:'old',date:'2026-01-05',modelVersion:'v1',active:false}]}/></MemoryRouter>);
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'old'}});
  expect(screen.queryByText(/恢复提示/)).toBeNull();
  cleanup();

  remote.mockReturnValue(savedRun([{domain:'readiness',key:'summary',payload:{status:'not_available_in_legacy_run'}}]));
  render(<MemoryRouter><HistoricalModelReview runs={[{id:'old',date:'2026-01-05',modelVersion:'v1',active:false}]}/></MemoryRouter>);
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'old'}});
  expect(screen.queryByText(/恢复提示/)).toBeNull();
  expect(screen.queryByText(/未见低信号/)).toBeNull();
});

it('R06: no_low_signal is never presented as confirmed full recovery',()=>{
  remote.mockReturnValue(savedRun([{domain:'readiness',key:'summary',payload:readinessPayload({
    coverage:'partial',assessment:'no_low_signal',state:'no_low_signal',sleepStreak:false,reasonCodes:[]
  })}]));
  render(<MemoryRouter><HistoricalModelReview runs={[{id:'old',date:'2026-01-05',modelVersion:'v1',active:false}]}/></MemoryRouter>);
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'old'}});
  expect(screen.getByText(/恢复提示：未见低信号/)).toBeTruthy();
  expect(screen.getByText(/部分信号/)).toBeTruthy();
  expect(screen.queryByText(/完全恢复/)).toBeNull();
  expect(screen.queryByText(/已恢复/)).toBeNull();
});
