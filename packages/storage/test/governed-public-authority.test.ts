import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("compiled supported governed package boundary", () => {
  it("withholds provider/result minting and rejects unsupported subpaths in production", () => {
    const script = `
      import assert from 'node:assert/strict';
      import {mkdtempSync,rmSync} from 'node:fs';
      import {tmpdir} from 'node:os';
      import {join,resolve} from 'node:path';
      import {pathToFileURL} from 'node:url';
      import * as storage from '@codex-task-console/storage';
      import * as adapter from '@codex-task-console/codex-adapter';
      const directory=mkdtempSync(join(tmpdir(),'ctc-public-governed-'));
      const db=storage.openTaskDatabase({databasePath:join(directory,'fixture.sqlite'),clock:()=>new Date('2026-09-04T00:00:00.000Z')});
      try {
        const handle=storage.createGovernedExecutionStore(db);
        const forbidden=['reserveRoleExecutionAttempt','resolveRoleExecutionInput','claimRoleProviderExecution','bindRoleProviderThread',
          'startRoleProviderRun','persistSuccessfulRoleResult','finalizeFailedRoleAttempt','reconcileRoleResult','getGovernedProviderBridge'];
        for(const name of forbidden) {assert.equal(handle[name],undefined);assert.equal(storage[name],undefined);assert.equal(adapter[name],undefined);}
        assert.deepEqual(Object.getOwnPropertyNames(storage.GovernedExecutionStore.prototype).sort(),[
          'constructor','inspectBigTask','prepareNextRole','getRoleAuthorization','authorizeManualStart','authorizeOneTimeBudgetExtension'].sort());
        assert.equal(Object.isFrozen(handle),true);
        assert.throws(()=>Object.defineProperty(handle,'persistSuccessfulRoleResult',{value:()=>({outcome:'PASS'})}));
        assert.throws(()=>storage.createGovernedExecutionStore(db,{}));
        const forged=await adapter.executeGovernedRoleCodex({reserveRoleExecutionAttempt:()=>({})},'gra_'+'a'.repeat(48));
        assert.equal(forged.success,false); assert.equal(forged.failureCode,'INVALID_INPUT');
        for(const name of ['@codex-task-console/storage/governed-execution','@codex-task-console/storage/dist/governed-execution.js',
          '@codex-task-console/storage/governed-execution-public','@codex-task-console/codex-adapter/live-execution']) {
          await assert.rejects(import(name),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
        }
        const internal=await import(pathToFileURL(resolve('../storage/dist/governed-execution-public.js')).href);
        assert.throws(()=>internal.createGovernedExecutionStoreForTest(db,{}));
        const runtime=await import(pathToFileURL(resolve('../codex-adapter/dist/live-execution.js')).href);
        assert.equal((await runtime.executeGovernedRoleCodexWithDependenciesForTest(handle,'gra_'+'a'.repeat(48),{})).success,false);
        const local=await import(pathToFileURL(resolve('dist/index.js')).href);
        assert.deepEqual(Object.keys(local),[]);
        console.log(JSON.stringify({storage:Object.keys(storage).filter(k=>/governed/i.test(k)),adapter:Object.keys(adapter).filter(k=>/governed/i.test(k)),local:Object.keys(local),providerSpawns:0,passed:true}));
      } finally {db.close();rmSync(directory,{recursive:true,force:true});}
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: join(process.cwd(), "packages/local-control"), encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production" }, timeout: 10_000,
    });
    expect(JSON.parse(output)).toMatchObject({providerSpawns:0,passed:true,local:[]});
  });
});
