import {describe,expect,it} from 'vitest';
import {BigTaskExecutionStore} from '../src/big-task-execution.js';
import {makeExecutionFixture} from './big-task-execution-fixture.js';

describe('Explicit final QA allowance',()=>{
  it.each(['PASS','BLOCKING_FAIL'] as const)('retains %s and never grants an extra repair cycle',async outcome=>{
    const f=makeExecutionFixture(undefined,role=>role==='FRESH_QA'&&outcome==='BLOCKING_FAIL'?'two-blockers':undefined,'STANDARD',{
      consoleWorkflow:{planReview:'SELF',budgetMode:'MEASURE',planningTokenLimit:120000,executionTokenLimit:120000,durationMinutes:180},
    });
    try{
      f.execution.approve({...f.approval,limits:{...f.approval.limits,repairCycleLimit:0,budgetMode:'MEASURE'}});
      f.execution.start(f.approval.bigTaskId);
      for(const role of ['EXECUTE','FRESH_QA']){
        const prepared=f.governed.prepareNextRole(f.approval.bigTaskId);
        if(prepared.kind!=='ROLE_AUTHORIZED')throw new Error('Role required');
        expect(prepared.authorization.role).toBe(role);
        expect(await f.execute(f.governed,prepared.authorization.authorizationId)).toMatchObject({success:true});
      }
      const next=f.governed.prepareNextRole(f.approval.bigTaskId);
      if(outcome==='BLOCKING_FAIL') {
        expect(next).toMatchObject({kind:'HUMAN_REQUIRED'});
        expect(f.execution.inspect(f.approval.bigTaskId).integratedSubtaskIds).toHaveLength(0);
      } else {
        expect(next.kind).not.toBe('HUMAN_REQUIRED');
        expect(f.execution.inspect(f.approval.bigTaskId).integratedSubtaskIds).toHaveLength(1);
      }
      const before=f.execution.inspect(f.approval.bigTaskId);
      expect(before.limits.repairCycleLimit).toBe(0);
      expect(before.roleCalls).toBe(2);
      f.reopen();
      expect(new BigTaskExecutionStore(f.storage).inspect(f.approval.bigTaskId)).toEqual(before);
    }finally{f.close();}
  },30000);
});
