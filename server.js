// Rohnin's Rooftop Heist - tiny zero-dependency server: static game + leaderboard API.
const http=require('http'), fs=require('fs'), path=require('path');
const PORT=process.env.PORT||3000;
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,'data');
const FILE=path.join(DATA_DIR,'scores.json');
const PUB=fs.existsSync(path.join(__dirname,'public'))?path.join(__dirname,'public'):__dirname;
const HIDE=/^\/(server\.js|package\.json|render\.yaml|data(\/|$)|\.)/;
fs.mkdirSync(DATA_DIR,{recursive:true});
let scores=[]; try{ scores=JSON.parse(fs.readFileSync(FILE,'utf8')); }catch(e){ scores=[]; }
let dirty=false;
setInterval(()=>{ if(!dirty) return; dirty=false; try{ fs.writeFileSync(FILE+'.tmp',JSON.stringify(scores)); fs.renameSync(FILE+'.tmp',FILE); }catch(e){ console.error('save failed',e.message); } },3000);
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.json':'application/json','.webmanifest':'application/manifest+json'};
const hits=new Map();
function limited(ip,max,winMs){ const now=Date.now(); const a=(hits.get(ip)||[]).filter(t=>now-t<winMs); a.push(now); hits.set(ip,a); return a.length>max; }
setInterval(()=>{ const now=Date.now(); for(const [k,v] of hits) if(!v.length||now-v[v.length-1]>120000) hits.delete(k); },60000);
const clean=s=>String(s||'').replace(/[^\w .\-!]/g,'').trim().slice(0,14);
const BAD=/(fuck|shit|cunt|nigg|fag|rape|nazi)/i;
const CORS={'Access-Control-Allow-Origin':process.env.CORS_ORIGIN||'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
function send(res,code,obj){ res.writeHead(code,Object.assign({'Content-Type':'application/json','Cache-Control':'no-store'},CORS)); res.end(JSON.stringify(obj)); }
// ---- co-op rooms: presence-style state relay over Server-Sent Events (no dependencies) ----
const rooms=new Map(); // code -> {clients:Map(id->res), states:Map(id->json), t}
const MAX_ROOMS=500, MAX_PER_ROOM=6;
function roomOf(code){ let r=rooms.get(code); if(!r){ if(rooms.size>=MAX_ROOMS) return null; r={clients:new Map(),states:new Map(),t:Date.now()}; rooms.set(code,r); } return r; }
function sse(res,ev,data){ try{ res.write('event: '+ev+'\ndata: '+data+'\n\n'); }catch(e){} }
setInterval(()=>{ const now=Date.now(); for(const [c,r] of rooms){ for(const [id,res] of r.clients){ try{ res.write(':ka\n\n'); }catch(e){} } for(const [id,st] of r.states) if(now-st.t>15000&&!r.clients.has(id)) r.states.delete(id); if(!r.clients.size&&now-r.t>60000) rooms.delete(c); } },15000);
function top(n){ return scores.slice().sort((a,b)=>b.score-a.score).slice(0,n).map(({name,score,di})=>({name,score,di})); }
function rankOf(score){ let r=1; for(const s of scores) if(s.score>score) r++; return r; }
const server=http.createServer((req,res)=>{
  const ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  const u=new URL(req.url,'http://x');
  if(req.method==='OPTIONS'){ res.writeHead(204,CORS); return res.end(); }
  if(u.pathname==='/api/ping') return send(res,200,{ok:true,players:scores.length,rooms:true});
  { const m=u.pathname.match(/^\/api\/room\/([A-Za-z]{4})\/(events|pub)$/);
    if(m){ const code=m[1].toUpperCase();
      if(m[2]==='events'){
        const id=String(u.searchParams.get('id')||'').replace(/[^\w]/g,'').slice(0,12); if(!id) return send(res,400,{error:'id'});
        const r=roomOf(code); if(!r||r.clients.size>=MAX_PER_ROOM) return send(res,503,{error:'room full'});
        res.writeHead(200,Object.assign({'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'},CORS));
        res.write('retry: 1500\n\n'); r.clients.set(id,res); r.t=Date.now();
        for(const [oid,st] of r.states) if(oid!==id) sse(res,'state',st.j);
        req.on('close',()=>{ r.clients.delete(id); r.states.delete(id); for(const [oid,c] of r.clients) sse(c,'left',id); });
        return;
      }
      if(limited(ip+':pub',900,60000)) return send(res,429,{error:'slow down'});
      let body=''; req.on('data',c=>{ body+=c; if(body.length>4000) req.destroy(); });
      req.on('end',()=>{ let j; try{ j=JSON.parse(body); }catch(e){ return send(res,400,{error:'bad json'}); }
        const id=String(j&&j.id||'').replace(/[^\w]/g,'').slice(0,12); if(!id) return send(res,400,{error:'id'});
        const r=rooms.get(code); if(!r||!r.clients.has(id)) return send(res,409,{error:'not joined'});
        const jj=JSON.stringify(j); r.states.set(id,{j:jj,t:Date.now()}); r.t=Date.now();
        for(const [oid,c] of r.clients) if(oid!==id) sse(c,'state',jj);
        return send(res,200,{ok:true}); });
      return; } }
  if(u.pathname==='/api/top'){ const n=Math.min(100,Math.max(1,+u.searchParams.get('n')||25)); return send(res,200,{top:top(n)}); }
  if(u.pathname==='/api/score'&&req.method==='POST'){
    if(limited(ip,12,60000)) return send(res,429,{error:'slow down'});
    let body=''; req.on('data',c=>{ body+=c; if(body.length>2000) req.destroy(); });
    req.on('end',()=>{
      let j; try{ j=JSON.parse(body); }catch(e){ return send(res,400,{error:'bad json'}); }
      let name=clean(j.name)||'ROHNIN'; if(BAD.test(name)) name='ROHNIN';
      const score=Math.floor(+j.score), dist=Math.floor(+j.dist), di=Math.floor(+j.di)||0, kills=Math.floor(+j.kills)||0;
      if(!(score>=50)||!(dist>=0)||!isFinite(score)) return send(res,400,{error:'bad score'});
      // soft plausibility check: score is mostly distance plus boss/kill bonuses
      if(score>dist*45+kills*900+60000) return send(res,400,{error:'implausible'});
      const key=name.toLowerCase(); let e=scores.find(s=>s.key===key);
      if(!e){ e={key,name,score:0,di:0,t:Date.now()}; scores.push(e); }
      if(score>e.score){ e.score=score; e.di=di; e.name=name; e.t=Date.now(); dirty=true; }
      return send(res,200,{rank:rankOf(e.score),total:scores.length,best:e.score});
    }); return;
  }
  if(u.pathname.startsWith('/api/')) return send(res,404,{error:'not found'});
  let p=decodeURIComponent(u.pathname); if(p==='/') p='/index.html';
  const f=path.normalize(path.join(PUB,p)); if(!f.startsWith(PUB)||HIDE.test(p)){ res.writeHead(403); return res.end(); }
  fs.readFile(f,(err,buf)=>{ if(err){ res.writeHead(404); return res.end('Not found'); } res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream','Cache-Control':p==='/index.html'?'no-cache':'public, max-age=3600'}); res.end(buf); });
});
server.listen(PORT,()=>console.log('Rohnin\'s Rooftop Heist on :'+PORT));
process.on('SIGTERM',()=>{ try{ fs.writeFileSync(FILE,JSON.stringify(scores)); }catch(e){} process.exit(0); });
