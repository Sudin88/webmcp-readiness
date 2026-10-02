import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const d = JSON.parse(readFileSync(join(__dirname,'scan-results.json'),'utf8'));
// pick 4 sites flagged, dedup by entry
const flagged = [...new Set(d.results.flatMap(r=>r.findings.filter(f=>f.rule==='required-fields-enforced').map(f=>({e:r.entry,t:f.tool}))))].slice(0,4);
const seen=new Set(); const cases=flagged.filter(x=>!seen.has(x.e)&&seen.add(x.e));
const b = await chromium.launch();
for (const {e,t:want} of cases) {
  const url=e.startsWith('http')?e:`https://${e}`;
  const c = await b.newContext();
  await c.addInitScript({ path: join(__dirname,'node_modules/@mcp-b/global/dist/index.iife.js') });
  const p = await c.newPage();
  try{
    await p.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
    await p.waitForTimeout(4000);
    const r = await p.evaluate(async (want) => {
      const t=(await document.modelContext.getTools()).find(x=>x.name===want);
      if(!t) return {err:'not found'};
      const props=t.inputSchema?.properties||{};
      const full={};
      for(const[k,v]of Object.entries(props)){
        if(v?.type==='string')full[k]=v.default??v.examples?.[0]??(v.enum?v.enum[0]:'test');
        else if(v?.type==='number'||v?.type==='integer')full[k]=1;
        else if(v?.type==='boolean')full[k]=false;
      }
      const req=t.inputSchema?.required||[];
      const partial={}; for(const k of req.slice(1)) if(k in full)partial[k]=full[k];
      const missing=req.filter(k=>!(k in partial));
      let res;
      try{ res=JSON.stringify(await document.modelContext.executeTool(t,JSON.stringify(partial))); }
      catch(e){ res='THROW '+e.name+': '+e.message; }
      return {req,missingKeys:missing,partial,res:res.slice(0,300),schema:JSON.stringify(t.inputSchema).slice(0,200)};
    },want);
    console.log('\n== '+e.slice(0,40)+' :: '+want);
    console.log('  required:',JSON.stringify(r.req),'| OMITTED:',JSON.stringify(r.missingKeys));
    console.log('  result:',r.res||r.err);
  }catch(e){console.log('ERR',e.message.slice(0,70));}
  await c.close();
}
await b.close();
