import {describe,it,expect} from 'vitest';
import {BigTaskExecutionStore} from '../src/big-task-execution.js';
import {makeExecutionFixture} from './big-task-execution-fixture.js';
import {BigTaskExecutionStatusSchema} from '@codex-task-console/domain';

describe('Owner-adjustable execution limits',()=>{
  it('recovers a failed recovery after an explicit amendment, preserving history across restart',async()=>{
    let now=Date.parse('2026-09-10T00:00:00.000Z');
    const f=makeExecutionFixture(()=>new Date(now++),(role,n)=>role==='EXECUTE'&&n<=2?'wrong-fields':undefined,'STANDARD');
    try{
      f.execution.approve(f.approval);f.execution.start(f.approval.bigTaskId);
      for(let n=0;n<2;n++){
        const next=f.governed.prepareNextRole(f.approval.bigTaskId);
        if(next.kind!=='ROLE_AUTHORIZED')throw new Error('Role required');
        expect((await f.execute(f.governed,next.authorization.authorizationId)).success).toBe(false);
        f.execution.stop(f.approval.bigTaskId,'GOVERNED_BLOCKED');
        if(n===0){f.governed.recoverExecution(f.governed.reviewExecutionRecovery(f.approval.bigTaskId).request);f.execution.start(f.approval.bigTaskId);}
      }
      expect(()=>f.governed.reviewExecutionRecovery(f.approval.bigTaskId)).toThrow();
      const before=f.execution.inspect(f.approval.bigTaskId);
      now=Date.parse(before.expiresAt!)+1;
      const request={bigTaskId:f.approval.bigTaskId,planDigest:before.planDigest,expectedRevision:0,
        values:{recoveryAttemptLimit:2,totalTokenLimit:1,roleCallLimit:100,budgetMode:'MEASURE'}};
      const adjusted=f.execution.adjustLimits(request);
      expect(adjusted).toMatchObject({knownTokens:before.knownTokens,roleCalls:2,limitAdjustment:{revision:1},totalBudgetMode:'WARNING_ONLY'});
      expect(f.execution.adjustLimits(request)).toEqual(adjusted);
      expect(()=>f.execution.adjustLimits({...request,values:{...request.values,recoveryAttemptLimit:3}})).toThrow();
      f.execution.renewWindow({bigTaskId:before.bigTaskId,planDigest:before.planDigest,previousExpiresAt:before.expiresAt,durationMilliseconds:600000});
      const retry=f.governed.reviewExecutionRecovery(f.approval.bigTaskId).request;
      f.governed.recoverExecution(retry);
      const restored=f.execution.inspect(f.approval.bigTaskId);

      expect(BigTaskExecutionStatusSchema.safeParse(restored).success).toBe(true);
      f.execution.start(f.approval.bigTaskId);
      const next=f.governed.prepareNextRole(f.approval.bigTaskId);
      if(next.kind!=='ROLE_AUTHORIZED')throw new Error('Role required');
      expect(next.authorization.authorizationId).not.toBe(retry.failedAuthorizationId);
      expect((await f.execute(f.governed,next.authorization.authorizationId)).success).toBe(true);
      expect(f.execution.inspect(f.approval.bigTaskId).roleCalls).toBe(3);
      expect(f.governed.prepareNextRole(f.approval.bigTaskId)).toMatchObject({kind:'ROLE_AUTHORIZED',authorization:{role:'FRESH_QA'}});
      const final=f.execution.inspect(f.approval.bigTaskId);f.reopen();expect(new BigTaskExecutionStore(f.storage).inspect(f.approval.bigTaskId)).toEqual(final);
    }finally{f.close();}
  },30000);
  it('rejects changes during execution and keeps actual QA policy unchanged',()=>{
    const f=makeExecutionFixture();
    try{
      f.execution.approve(f.approval);const running=f.execution.start(f.approval.bigTaskId).status;
      const request={bigTaskId:running.bigTaskId,planDigest:running.planDigest,expectedRevision:0,values:{recoveryAttemptLimit:3,totalTokenLimit:1000000,roleCallLimit:100,budgetMode:'MEASURE'}};
      expect(()=>f.execution.adjustLimits(request)).toThrow();
      f.execution.stop(running.bigTaskId,'USER_PAUSED');
      const adjusted=f.execution.adjustLimits(request);
      expect(adjusted.limits.repairCycleLimit).toBe(running.limits.repairCycleLimit);
      expect(()=>f.execution.adjustLimits({...request,expectedRevision:1,planDigest:'a'.repeat(64)})).toThrow();
    }finally{f.close();}
  });
});
