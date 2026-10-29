import { canonicalizeToolCallGuidance } from '../../src/toolGuidance';
import { CHATGPT_PUBLIC_SURFACE } from '../../src/toolProfiles';
import { writeFileSync } from 'node:fs';
const inputs=[
{tool:'approve_agent_work',args:{action:'list',limit:1,urgency_filter:'critical',initiative_id:'11111111-1111-4111-8111-111111111111',workspace_id:'22222222-2222-4222-8222-222222222222'}},
{tool:'recommend_next_action',args:{entity_type:'workspace',entity_id:'22222222-2222-4222-8222-222222222222',agent_id:'33333333-3333-4333-8333-333333333333',domain:'engineering',canonical_only:true,limit:3}},
{tool:'get_morning_brief',args:{workspace_id:'22222222-2222-4222-8222-222222222222',session_id:'test-autonomous-session'}},
{tool:'get_initiative_pulse',args:{initiative_name:'Search Copilot Readiness'}},
{tool:'get_initiative_pulse',args:{initiative_id:'11111111-1111-4111-8111-111111111111'}},
];
const rows=inputs.map(input=>({input,output:canonicalizeToolCallGuidance(input,new Set(CHATGPT_PUBLIC_SURFACE))}));
writeFileSync('artifacts/tool-streamlining-2026-10-05/guidance-reproductions.json',JSON.stringify(rows,null,2)+'\n'); console.log(JSON.stringify(rows,null,2));
