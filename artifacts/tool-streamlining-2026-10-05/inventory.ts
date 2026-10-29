import { getKnownToolContracts } from '../../src/contractTools';
import { CHATGPT_PUBLIC_SURFACE, V2_PUBLIC_SURFACE } from '../../src/toolProfiles';
import { isWidgetOnlyTool } from '../../src/widgetToolContract';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { writeFileSync } from 'node:fs';
const all=getKnownToolContracts();
const rows=CHATGPT_PUBLIC_SURFACE.map(id=>{
 const defs=all.filter(d=>d.id===id); const d=defs[0];
 const schema=d?.inputSchema?zodToJsonSchema(z.object(d.inputSchema),'input'):{};
 const shape=(schema as any).definitions?.input;
 return {id,modelVisible:!isWidgetOnlyTool(id),definitions:defs.map(d=>d.source),fields:Object.keys(d?.inputSchema??{}),actions:(shape?.properties?.action as any)?.enum??(shape?.properties?.mode as any)?.enum??[],schemaBytes:JSON.stringify(schema).length,descriptionBytes:d?.description.length??0,annotations:d?.annotations,ui:(d as any)?._meta?.ui?.resourceUri};
});
writeFileSync('artifacts/tool-streamlining-2026-10-05/inventory.json',JSON.stringify({chatgptListed:rows.length,modelVisible:rows.filter(x=>x.modelVisible).length,v2Listed:V2_PUBLIC_SURFACE.length,knownDefinitions:all.length,knownUnique:new Set(all.map(x=>x.id)).size,rows},null,2)+'\n');
console.log(JSON.stringify(rows.map(({id,modelVisible,definitions,actions,schemaBytes,fields})=>({id,modelVisible,definitions,actions,schemaBytes,fields})),null,2));
