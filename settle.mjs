import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const U=['https://settledestate.com','https://settledestate.com/texas/executor-compensation','https://spectrumtours.cz','https://airportloungelist.com','https://www.bestprice.gr','https://hopi.co.uk','https://agentk.stacktr.ee','https://googlechromelabs.github.io/webmcp-tools/demos/pizza-maker'];
const b=await chromium.launch();
for(const u of U){
  const c=await b.newContext();
  await c.addInitScript({path:join(__dirname,'node_modules/@mcp-b/global/dist/index.iife.js')});
  const p=await c.newPage();
  let status=null, tools=null, note='';
  for(const attempt of [1,2,3]){
    try{
      const r=await p.goto(u,{waitUntil:'load',timeout:45000});
      status=r?r.status():null;
      await p.waitForTimeout(6000);
      tools=await p.evaluate(async()=>{ if(!document.modelContext?.getTools) return -1; return (await document.modelContext.getTools()).length; });
      break;
    }catch(e){
      note=e.message.split('\n')[0].slice(0,70);
      await p.waitForTimeout(2500);
    }
  }
  console.log(u.replace('https://','').slice(0,50).padEnd(52),'http='+String(status).padEnd(5),'tools='+String(tools).padEnd(4),note);
  await c.close();
}
await b.close();
