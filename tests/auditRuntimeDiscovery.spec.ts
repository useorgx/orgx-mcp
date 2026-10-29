import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { AUTHORIZATION_PRESETS } from '../src/authorizationPolicy';
import { createEmptyMcpActivationState } from '../src/mcpActivationTracker';
import { createEmptyMcpSessionReentryState } from '../src/welcomeBackContext';
vi.mock('agents/mcp',()=>({McpAgent:class{static serve(){return{fetch:vi.fn()};}static serveSSE(){return{fetch:vi.fn()};}}}));
vi.mock('../src/oauth',()=>({OAuthState:class{}}));
vi.mock('@sentry/cloudflare',()=>({captureException:vi.fn(),captureMessage:vi.fn(),wrapMcpServerWithSentry:<T>(server:T)=>server,withSentry:<T>(_options:unknown,worker:T)=>worker}));
vi.mock('@cloudflare/workers-oauth-provider',()=>({default:class{async fetch(){return new Response(null,{status:501});}}}));
describe('audit actual SDK discovery with network and business execution disabled',()=>{
  it('exports every profile registration and widget resource',async()=>{
    vi.spyOn(console,'info').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});
    vi.stubGlobal('fetch',vi.fn(async(input:string|Request)=>{
      const url=new URL(typeof input==='string'?input:input.url);
      if(url.origin==='https://mcp.useorgx.test'&&url.pathname.startsWith('/widgets/')){
        const path=resolve('public',url.pathname.slice(1));
        if(path.startsWith(resolve('public')+'/')&&existsSync(path))return new Response(readFileSync(path));
      }
      return new Response('Audit network disabled',{status:503});
    }));
    const {OrgXMcp}=await import('../src/index');
    const results:unknown[]=[];
    try{for(const profile of ['full','v2','chatgpt','claude-directory']){
      const worker=Object.create(OrgXMcp.prototype) as Record<string,any>;
      worker.props={profile,userId:'audit-only',orgxUserId:'33333333-3333-4333-8333-333333333333',scope:AUTHORIZATION_PRESETS.operate.scopes.join(' '),workspace_id:'11111111-1111-4111-8111-111111111111'};
      worker.ctx={id:{toString:()=>`audit-${profile}`},storage:{get:vi.fn(async()=>undefined),put:vi.fn(async()=>undefined),sql:{exec:vi.fn(()=>[])}},waitUntil:vi.fn((p:Promise<unknown>)=>p)};
      worker.env={ORGX_API_URL:'https://api.useorgx.test',ORGX_WEB_URL:'https://useorgx.test',MCP_SERVER_URL:'https://mcp.useorgx.test',MCP_JWT_SECRET:'audit-test-only',OAUTH_KV:{get:vi.fn(async()=>null),put:vi.fn(async()=>undefined)}};
      worker.sessionContext={};worker.sessionAuth={};worker.sessionSqlInitialized=false;worker.mcpActivationState=createEmptyMcpActivationState();worker.mcpSessionReentryState=createEmptyMcpSessionReentryState();worker._isNewSession=false;worker.widgetDebugEvents=[];worker.toolResultGuidanceInstalled=false;
      await worker._doInit();
      const client=new Client({name:'discovery-audit',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();await worker.server.connect(st);await client.connect(ct);
      try{const tools=await client.listTools();const resources=await client.listResources();const ids=tools.tools.map(t=>t.name);expect(new Set(ids).size).toBe(ids.length);for(const t of tools.tools){expect(t.inputSchema.type).toBe('object');expect(t.description).toBeTruthy();}
        const resourceReads=[];
        for(const resource of resources.resources.filter(r=>r.mimeType?.includes('html'))){
          const result=await client.readResource({uri:resource.uri});
          const content=result.contents[0];expect(content.uri).toBe(resource.uri);
          expect('text' in content).toBe(true);
          const html='text' in content?content.text:'';expect(html).toContain('<!DOCTYPE html>');expect(html.length).toBeGreaterThan(1000);
          resourceReads.push({uri:resource.uri,mimeType:content.mimeType,bytes:Buffer.byteLength(html),sha256:createHash('sha256').update(html).digest('hex'),result:'PASS offline source asset fixture'});
        }
        results.push({profile,tools:tools.tools,resources:resources.resources,resourceReads});}
      finally{await client.close();await worker.server.close();}
    }writeFileSync('../runtime-discovery.json',JSON.stringify(results,null,2));}
    finally{vi.restoreAllMocks();vi.unstubAllGlobals();}
  },30000);
});
