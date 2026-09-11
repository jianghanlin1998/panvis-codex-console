import {describe,it,expect} from 'vitest';
import {ConsoleApplication} from '../src/console-application.js';
import {makeExecutionFixture} from '../../storage/test/big-task-execution-fixture.js';
import type {LocalControlService} from '../src/service.js';
const forbidden=async():Promise<never>=>{throw new Error('No provider calls');};
const service:LocalControlService={inspectSubtask:forbidden,provisionOwnedWorktree:forbidden,runOwnedWorktreeExecution:forbidden,releaseOwnedWorktree:forbidden};
describe('Console capability inventory',()=>{
 it('reports registered integrations separately from live verification and inherits task policy',async()=>{
  const f=makeExecutionFixture(),ui=new ConsoleApplication(f.storage,service,{discuss:forbidden});
  try {
   const scope={kind:'BIG_TASK',id:f.approval.bigTaskId};
   const before=await ui.request('capabilities',{scope}) as {liveVerification:boolean;capabilities:{id:string;state:string}[]};
   expect(before.liveVerification).toBe(false);
   expect(before.capabilities.find(x=>x.id==='network')?.state).toBe('SELECT_TASK');
   expect(before.capabilities.find(x=>x.id==='browser')?.state).toBe('NOT_CONFIGURED');
   expect(before.capabilities.find(x=>x.id==='integrations')?.state).toBe('NOT_CONFIGURED');
   f.execution.approve(f.approval);
   const after=await ui.request('capabilities',{scope}) as typeof before;
   expect(after.capabilities.find(x=>x.id==='network')?.state).toBe('RESTRICTED');
   await expect(ui.request('capabilities',{scope:{kind:'BIG_TASK',id:'bt_missing'}})).rejects.toThrow();
   await expect(ui.request('capabilities',{scope,networkAccess:true})).rejects.toThrow();
  } finally {await ui.stop();f.close();}
 });
});
