import {describe,expect,it} from 'vitest';
import {BigTaskExecutionStore} from '../src/big-task-execution.js';
import {makeExecutionFixture} from './big-task-execution-fixture.js';

describe('Owner-adjustable task network access',()=>{
  it.each([false,true])('passes recorded network=%s to implementation and read-only QA, retaining it across replay',async enabled=>{
    const f=makeExecutionFixture(undefined,undefined,'STANDARD',{consoleWorkflow:{planReview:'SELF',budgetMode:'MEASURE',planningTokenLimit:120000,executionTokenLimit:120000,durationMinutes:180}});
    try{
      f.execution.approve({...f.approval,limits:{...f.approval.limits,budgetMode:"MEASURE"}});f.execution.start(f.approval.bigTaskId);
      const state=f.execution.inspect(f.approval.bigTaskId);
      const request={bigTaskId:state.bigTaskId,planDigest:state.planDigest,expectedRevision:0,
        values:{totalTokenLimit:120000,roleCallLimit:16,budgetMode:'MEASURE',recoveryAttemptLimit:2,networkAccess:enabled}};
      expect(()=>f.execution.adjustLimits(request)).toThrow();
      f.execution.stop(state.bigTaskId,'USER_PAUSED');
      const adjusted=f.execution.adjustLimits(request);
      expect(adjusted.limitAdjustment?.values.networkAccess).toBe(enabled);
      expect(()=>f.execution.adjustLimits({...request,values:{...request.values,networkAccess:!enabled}})).toThrow();
      f.execution.start(state.bigTaskId);
      for(const role of ['EXECUTE','FRESH_QA']){
        const prepared=f.governed.prepareNextRole(state.bigTaskId);
        if(prepared.kind!=='ROLE_AUTHORIZED')throw new Error('Role required');
        expect(prepared.authorization.role).toBe(role);
        const result=await f.execute(f.governed,prepared.authorization.authorizationId);
        expect(result).toMatchObject({success:true,threadPolicy:{networkAccess:enabled,
          sandbox:role==='EXECUTE'?'workspaceWrite':'readOnly',writableRootCount:role==='EXECUTE'?1:0}});
      }
      f.execution.stop(state.bigTaskId,'USER_PAUSED');
      const final=f.execution.inspect(state.bigTaskId);f.reopen();
      expect(new BigTaskExecutionStore(f.storage).inspect(state.bigTaskId)).toEqual(final);
    }finally{f.close();}
  },30000);
});
