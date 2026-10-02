import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES = [
  ['https://scvd.store','check_purchase'],
  ['https://www.haulhandbook.com/tools/ifta-tax-rates','search_site'],
  ['https://b2a.bluepillow.com/webmcp','resolve_destination'],
];
const b = await chromium.launch();
for (const [u,want] of CASES) {
  const c = await b.newContext();
  await c.addInitScript({ path: join(__dirname,'node_modules/@mcp-b/global/dist/index.iife.js') });
  const p = await c.newPage();
  try{
    await p.goto(u,{waitUntil:'domcontentloaded',timeout:30000});
    await p.waitForTimeout(4000);
    const r = await p.evaluate(async (want) => {
      const t=(await document.modelContext.getTools()).find(x=>x.name===want);
      if(!t) return {err:'tool not found'};
      const props=t.inputSchema?.properties||{};
      const full={};
      for(const[k,v]of Object.entries(props)){
        if(v?.type==='string')full[k]=v.default??v.examples?.[0]??(v.enum?v.enum[0]:'test');
        else if(v?.type==='number'||v?.type==='integer')full[k]=1;
        else if(v?.type==='boolean')full[k]=false;
      }
      const req=t.inputSchema?.required||[];
      const partial={}; for(const k of req.slice(1)) if(k in full)partial[k]=full[k];
      const out={schema:JSON.stringify(t.inputSchema).slice(0,180), req, partialKeys:Object.keys(partial)};
      try{ out.partial=JSON.stringify(await document.modelContext.executeTool(t,JSON.stringify(partial))).slice(0,200); }
      catch(e){ out.partial='THROW '+e.name; }
      return out;
    },want);
    console.log('\n== '+u.replace('https://','')+' :: '+want);
    console.log('  schema:',r.schema);
    console.log('  required:',JSON.stringify(r.req),' partial sent:',JSON.stringify(r.partialKeys));
    console.log('  result:',r.partial||r.err);
  }catch(e){console.log('ERR',e.message.slice(0,60));}
  await c.close();
}
await b.close();
