import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const U = ['https://corpuslaw.us','https://www.taxsaleatlas.com/tools/ifta-tax-rates','https://scvd.store'];
const b = await chromium.launch();
for (const u of U) {
  const c = await b.newContext();
  await c.addInitScript({ path: join(__dirname,'node_modules/@mcp-b/global/dist/index.iife.js') });
  const p = await c.newPage();
  try {
    await p.goto(u,{waitUntil:'domcontentloaded',timeout:30000});
    await p.waitForTimeout(4000);
    const r = await p.evaluate(async () => {
      const tools = await document.modelContext.getTools();
      const res = [];
      for (const t of tools) {
        const props = t.inputSchema?.properties||{};
        const full={};
        for (const [k,v] of Object.entries(props)) {
          if(v?.type==='string') full[k]=v.default??v.examples?.[0]??(v.enum?v.enum[0]:'test');
          else if(v?.type==='number'||v?.type==='integer') full[k]=1;
          else if(v?.type==='boolean') full[k]=false;
        }
        const req=t.inputSchema?.required||[];
        if(req.length<2) continue;
        const partial={}; for(const k of req.slice(1)) if(k in full) partial[k]=full[k];
        let transport, body;
        try { transport='ok'; body=JSON.stringify(await document.modelContext.executeTool(t,JSON.stringify(partial))); }
        catch(e){ transport='THROW'; body=e.name+': '+e.message; }
        res.push({name:t.name, required:req, transport, body:body.slice(0,220)});
        if(res.length>=3) break;
      }
      return res;
    });
    console.log('\n== '+u.replace('https://',''));
    for (const x of r) console.log(`  ${x.name}  req=[${x.required}]  ${x.transport}\n     ${x.body}`);
  } catch(e){ console.log('ERR',u,e.message.slice(0,60)); }
  await c.close();
}
await b.close();
