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
