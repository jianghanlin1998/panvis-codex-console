import {describe,it,expect,vi} from 'vitest';
import {ConsoleApplication} from '../src/console-application.js';
import {makePlanningFixture} from '../../storage/test/live-planning-fixture.js';
import {makeExecutionFixture} from '../../storage/test/big-task-execution-fixture.js';
import type {LocalControlService} from '../src/service.js';
import type {executeConsoleDiscussionCodex} from '@codex-task-console/codex-adapter';
const forbidden=async():Promise<never>=>{throw new Error('No provider calls');};
const base:LocalControlService={inspectSubtask:forbidden,provisionOwnedWorktree:forbidden,runOwnedWorktreeExecution:forbidden,releaseOwnedWorktree:forbidden};
const brief={title:'Revise B',goal:'Review and repair existing B',scopeIn:['Preserve old code and issues'],scopeOut:['Reset old records'],successCriteria:['New independent QA cycle']};
const mock=(action:object)=>vi.fn<typeof executeConsoleDiscussionCodex>(async()=>({success:true,agentResponseText:JSON.stringify({reply:'Applying your confirmation',proposal:null,actions:[action]}),normalizedUsage:{totalTokens:1},failureCode:null} as Awaited<ReturnType<typeof executeConsoleDiscussionCodex>>));
const settle=async(check:()=>boolean)=>{for(let n=0;n<300&&!check();n++)await Promise.resolve();expect(check()).toBe(true);};
describe('Chat confirmation performs the current operation',()=>{
  it('confirms the related revision from its paused original chat, schedules once, and preserves the original',async()=>{
    const f=makePlanningFixture();f.planning.accept(f.intake);
    const runPlanning=vi.fn(async(id:Parameters<NonNullable<LocalControlService['runPlanning']>>[0])=>{f.planning.claim(id);return f.planning.inspect(id);});
    const ui=new ConsoleApplication(f.storage,{...base,inspectPlanning:async id=>f.planning.inspect(id),runPlanning},{discuss:forbidden});
    try{
      const scope={kind:'BIG_TASK',id:f.intake.bigTask.id} as const;
      ui.store.changeSettings({scope,requestId:'pause-original-task',expectedRevision:0,lifecycle:'PAUSED'});
      const draft=ui.store.createDraft({requestId:'revision-draft-1',projectId:f.intake.bigTask.projectId,relatedBigTaskId:scope.id,kind:'BIG_TASK',title:brief.title,goal:brief.goal,suggestedBrief:brief});
      const action={kind:'CONFIRM_DRAFT',draftId:draft.id,revision:0};
      const chat=new ConsoleApplication(f.storage,{...base,inspectPlanning:async id=>f.planning.inspect(id),runPlanning},{discuss:mock(action)});
      try{
        await chat.request('discuss',{scope,requestId:'confirm-revision-chat',message:'确认。开始实施。'});
        await settle(()=>chat.store.turns(scope).turns[0]?.effects?.[0]?.kind==='TASK_ADVANCED');
        expect(chat.store.lifecycle(scope)).toBe('PAUSED');
        const id=chat.store.getDraft(draft.id)!.confirmedBigTaskId!;
        expect(chat.store.taskPresence(id).execution).toBe(false);
        await chat.request('draft-confirm-and-plan',{draftId:draft.id,revision:0});
        expect(runPlanning).toHaveBeenCalledTimes(1);
        expect(chat.store.listDrafts(f.intake.bigTask.projectId)).toHaveLength(1);
        await expect(chat.request('draft-confirm-and-plan',{draftId:draft.id,revision:4})).rejects.toThrow();
      }finally{await chat.stop();}
    }finally{await ui.stop();f.close();}
  });
  it('approves only the exact prepared plan and starts it from explicit chat confirmation',async()=>{
    const f=makeExecutionFixture();
    const approveExecution=vi.fn(async(input:unknown)=>f.execution.approve(input));
    const startExecution=vi.fn(async()=>f.execution.start(f.approval.bigTaskId).status);
    const ui=new ConsoleApplication(f.storage,{...base,approveExecution,startExecution},{discuss:forbidden});
    try{
      const id=f.approval.bigTaskId,binding=ui.store.planningBinding(id)!;
      await expect(ui.request('plan-approve-and-start',{bigTaskId:id,expectedBinding:'0'.repeat(32)})).rejects.toThrow();
      expect(approveExecution).not.toHaveBeenCalled();
      const result=await ui.request('plan-approve-and-start',{bigTaskId:id,expectedBinding:binding});
      expect(result).toMatchObject({kind:'TASK_ADVANCED',targetId:id});expect(approveExecution).toHaveBeenCalledTimes(1);expect(startExecution).toHaveBeenCalledTimes(1);
    }finally{await ui.stop();f.close();}
  });
  it.each([true,false,null])('forwards the owner network choice %s from chat into recovery',async networkAccess=>{
    const f=makeExecutionFixture();
    const id=f.approval.bigTaskId;
    const action={kind:'RECOVER_TASK',bigTaskId:id,planDigest:f.approval.planDigest,expectedRevision:0,acknowledgeUnknownUsage:false,durationMinutes:null,networkAccess};
    const ui=new ConsoleApplication(f.storage,base,{discuss:mock(action)});
    const original=ui.request.bind(ui);
    const request=vi.spyOn(ui,'request').mockImplementation(async(kind,input)=>kind==='task-recover-and-start'?{kind:'TASK_ADVANCED',targetId:id,description:'Recovered'}:original(kind,input));
    try{
      const scope={kind:'BIG_TASK',id} as const;
      await ui.request('discuss',{scope,requestId:'network-recovery-chat',message:'调整联网设置并恢复任务'});
      await settle(()=>ui.store.turns(scope).turns[0]?.effects?.[0]?.kind==='TASK_ADVANCED');
      expect(request).toHaveBeenCalledWith('task-recover-and-start',expect.objectContaining({networkAccess}));
    }finally{await ui.stop();f.close();}
  });
  it('rejects confirming unrelated drafts from a big-task chat',()=>{
    const f=makePlanningFixture();f.planning.accept(f.intake);
    const ui=new ConsoleApplication(f.storage,base,{discuss:forbidden});
    try{
      const draft=ui.store.createDraft({requestId:'unrelated-draft-1',projectId:f.intake.bigTask.projectId,kind:'BIG_TASK',title:brief.title,goal:brief.goal,suggestedBrief:brief});
      const scope={kind:'BIG_TASK',id:f.intake.bigTask.id} as const;
      const turn=ui.store.claimDiscussion({scope,requestId:'wrong-confirmation',message:'Confirm revision'});
      expect(ui.store.finishDiscussion(turn.turn.id,{reply:'Confirm',proposal:null,actions:[{kind:'CONFIRM_DRAFT',draftId:draft.id,revision:0}]},{totalTokens:1},null)).toMatchObject({status:'FAILED',effects:[]});
      expect(ui.store.getDraft(draft.id)?.confirmedBigTaskId).toBe(null);
    }finally{f.close();}
  });
});
