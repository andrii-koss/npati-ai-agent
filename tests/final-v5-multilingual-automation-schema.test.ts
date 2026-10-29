import {expect,it} from 'vitest';
import {WORKSPACE_ACTION_TOOL} from '../apps/agent-api/src/chat-productivity-tools';
it('exposes the real automation status field and enum so pausing is persisted rather than described only in prose',()=>{
 const schema=(WORKSPACE_ACTION_TOOL.function.parameters.properties as Record<string,any>).automation;
 expect(schema).toMatchObject({type:'object',additionalProperties:false,properties:{status:{type:'string',enum:['active','paused']},cronExpression:{type:'string'},timezone:{type:'string'}}});
 expect(schema.description).toContain('automation.create');expect(schema.description).toContain('status');
 expect(schema.required??[]).not.toContain('status'); // Updates must preserve status when only the schedule changes.
});
