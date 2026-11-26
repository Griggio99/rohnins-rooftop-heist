// Rohnin's Rooftop Heist - tiny zero-dependency server: static game + leaderboard API.
const http=require('http'), fs=require('fs'), path=require('path'), crypto=require('crypto');
const PORT=process.env.PORT||3000;
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,'data');
const FILE=path.join(DATA_DIR,'scores.json');
const PUB=fs.existsSync(path.join(__dirname,'public'))?path.join(__dirname,'public'):__dirname;
const HIDE=/^\/(server\.js|package\.json|render\.yaml|data(\/|$)|\.)/;
fs.mkdirSync(DATA_DIR,{recursive:true});
let scores=[]; try{ scores=JSON.parse(fs.readFileSync(FILE,'utf8')); }catch(e){ scores=[]; }
let dirty=false;
// signed run tokens: server-side proof a run actually started and how long it has been going
let SECRET; try{ SECRET=fs.readFileSync(path.join(DATA_DIR,'secret'),'utf8').trim(); }catch(e){ SECRET=crypto.randomBytes(24).toString('hex'); try{ fs.writeFileSync(path.join(DATA_DIR,'secret'),SECRET); }catch(_){} }
const sign=p=>crypto.createHmac('sha256',SECRET).update(p).digest('hex').slice(0,24);
function mkTok(sc0){ const p=Date.now()+'.'+sc0; return p+'.'+sign(p); }
function readTok(t){ const a=String(t||'').split('.'); if(a.length!==3) return null; const p=a[0]+'.'+a[1]; if(sign(p)!==a[2]) return null; return {t0:+a[0],sc0:+a[1]}; }

setInterval(()=>{ if(!dirty) return; dirty=false; try{ fs.writeFileSync(FILE+'.tmp',JSON.stringify(scores)); fs.renameSync(FILE+'.tmp',FILE); }catch(e){ console.error('save failed',e.message); } },3000);
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.json':'application/json','.webmanifest':'application/manifest+json'};
const SFILE=path.join(DATA_DIR,'stats.json');
let stats={runs:0,sumT:0,byDi:{},byDist:{},cause:{},mode:{},pet:{}}; try{ stats=Object.assign(stats,JSON.parse(fs.readFileSync(SFILE,'utf8'))); }catch(e){}
let sdirty=false; setInterval(()=>{ if(!sdirty) return; sdirty=false; try{ fs.writeFileSync(SFILE+'.tmp',JSON.stringify(stats)); fs.renameSync(SFILE+'.tmp',SFILE); }catch(e){} },20000);
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
function wsFrame(op,buf){ const n=buf.length; let h; if(n<126) h=Buffer.from([0x80|op,n]); else { h=Buffer.alloc(4); h[0]=0x80|op; h[1]=126; h.writeUInt16BE(n,2); } return Buffer.concat([h,buf]); }
function wsSend(sock,str){ if(sock.destroyed||!sock.writable) return; sock.write(wsFrame(1,Buffer.from(str))); }
function push(c,ev,data){ try{ if(c.ws) wsSend(c.sock,JSON.stringify({e:ev,d:data})); else c.write('event: '+ev+'\ndata: '+data+'\n\n'); }catch(e){} }
const sse=push;
setInterval(()=>{ const now=Date.now(); for(const [c,r] of rooms){ for(const [id,res] of r.clients){ push(res,'ping','1'); } for(const [id,st] of r.states) if(now-st.t>30000) r.states.delete(id); if(!r.clients.size&&now-r.t>60000) rooms.delete(c); } },8000);
// extra boards: duo (co-op) and daily-heist leaderboards, plus client error log
const XFILE=path.join(DATA_DIR,'extra.json');
let extra={co:[],daily:{},weekly:{}}; try{ extra=Object.assign(extra,JSON.parse(fs.readFileSync(XFILE,'utf8'))); }catch(e){}
let xdirty=false;
function saveExtra(){ try{ fs.writeFileSync(XFILE+'.tmp',JSON.stringify(extra)); fs.renameSync(XFILE+'.tmp',XFILE); }catch(e){ console.error('extra save failed',e.message); } }
setInterval(()=>{ if(!xdirty) return; xdirty=false; saveExtra(); },3000);
const dayKey=()=>new Date().toISOString().slice(0,10);
const weekKey=()=>'W'+Math.floor((Math.floor(Date.now()/86400000)+3)/7);
const topOf=(arr,n)=>arr.slice().sort((a,b)=>b.score-a.score).slice(0,n).map(({name,score,di})=>({name,score,di}));
const rankIn=(arr,score)=>{ let r=1; for(const x of arr) if(x.score>score) r++; return r; };
const errLog=[];
function top(n){ return scores.slice().sort((a,b)=>b.score-a.score).slice(0,n).map(({name,score,di})=>({name,score,di})); }
function rankOf(score){ let r=1; for(const s of scores) if(s.score>score) r++; return r; }
const server=http.createServer((req,res)=>{
  const ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  const u=new URL(req.url,'http://x');
  if(req.method==='OPTIONS'){ res.writeHead(204,CORS); return res.end(); }
  if(u.pathname==='/api/ping') return send(res,200,{ok:true,players:scores.length,rooms:true,ws:true});
  { const m=u.pathname.match(/^\/api\/room\/([A-Za-z]{4})\/(events|pub)$/);
    if(m){ const code=m[1].toUpperCase();
      if(m[2]==='events'){
        const id=String(u.searchParams.get('id')||'').replace(/[^\w]/g,'').slice(0,12); if(!id) return send(res,400,{error:'id'});
        const r=roomOf(code); if(!r||r.clients.size>=MAX_PER_ROOM) return send(res,503,{error:'room full'});
        res.writeHead(200,Object.assign({'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'},CORS));
        res.write('retry: 1500\n\n'); { const old=r.clients.get(id); if(old&&old!==res){ try{ old.end(); }catch(e){} } } r.clients.set(id,res); r.t=Date.now();
        for(const [oid,st] of r.states) if(oid!==id) sse(res,'state',st.j);
        req.on('close',()=>{ if(r.clients.get(id)===res) r.clients.delete(id); });
        return;
      }
      if(limited(ip+':pub',1800,60000)) return send(res,429,{error:'slow down'});
      let body=''; req.on('data',c=>{ body+=c; if(body.length>4000) req.destroy(); });
      req.on('end',()=>{ let j; try{ j=JSON.parse(body); }catch(e){ return send(res,400,{error:'bad json'}); }
        const id=String(j&&j.id||'').replace(/[^\w]/g,'').slice(0,12); if(!id) return send(res,400,{error:'id'});
        const r=rooms.get(code); if(!r||!r.clients.has(id)) return send(res,409,{error:'not joined'});
        const jj=JSON.stringify(j); r.states.set(id,{j:jj,t:Date.now()}); r.t=Date.now();
        for(const [oid,c] of r.clients) if(oid!==id) sse(c,'state',jj);
        return send(res,200,{ok:true}); });
      return; } }
  if(u.pathname==='/api/top'){ const n=Math.min(100,Math.max(1,+u.searchParams.get('n')||25)), mode=u.searchParams.get('mode');
    if(mode==='co') return send(res,200,{top:topOf(extra.co,n)});
    if(mode==='daily'){ const day=dayKey(); return send(res,200,{day,top:topOf(extra.daily[day]||[],n)}); }
    if(mode==='weekly'){ const wk=weekKey(); return send(res,200,{week:wk,top:topOf((extra.weekly||{})[wk]||[],n)}); }
    return send(res,200,{top:top(n)}); }
  if(u.pathname==='/api/err'&&req.method==='POST'){
    if(limited(ip+'e',20,60000)) return send(res,429,{error:'slow down'});
    let body=''; req.on('data',c=>{ body+=c; if(body.length>3000) req.destroy(); });
    req.on('end',()=>{ let j; try{ j=JSON.parse(body); }catch(e){ return send(res,400,{error:'bad json'}); }
      const ua=String(req.headers['user-agent']||''), dev=(ua.match(/iPhone|iPad|Android|Windows|Macintosh|Linux/)||['?'])[0];
      const rec={t:new Date().toISOString(),m:String(j.m||'').slice(0,300),s:String(j.s||'').slice(0,500),u:String(j.u||'').slice(0,80),dev};
      errLog.push(rec); if(errLog.length>100) errLog.shift(); console.log('CLIENT_ERR',JSON.stringify(rec)); return send(res,200,{ok:true}); });
    return; }
  if(u.pathname==='/api/ev'&&req.method==='POST'){
    if(limited('ev'+ip,40,60000)) return send(res,429,{error:'slow down'});
    let b=''; req.on('data',d=>{ b+=d; if(b.length>600) req.destroy(); }); req.on('end',()=>{ try{ const j=JSON.parse(b); if(j&&j.e==='run'&&j.d){ const d=j.d, inc=(o,k)=>{ k=String(k).replace(/[^\w \-.]/g,'').slice(0,40)||'?'; o[k]=(o[k]||0)+1; };
      stats.runs++; stats.sumT+=Math.min(7200,Math.max(0,+d.t||0)); inc(stats.byDi,Math.min(30,Math.max(0,+d.di||0))); inc(stats.byDist,Math.min(20000,Math.max(0,+d.dist||0))); inc(stats.cause,d.cause); inc(stats.mode,d.mode); if(d.pet) inc(stats.pet,d.pet); sdirty=true; } }catch(e){} send(res,200,{ok:true}); }); return; }
  if(u.pathname==='/api/stats') return send(res,200,Object.assign({avgSec:stats.runs?Math.round(stats.sumT/stats.runs):0},stats));
  if(u.pathname==='/api/errors') return send(res,200,{count:errLog.length,errors:errLog.slice(-30)});
  if(u.pathname==='/api/run'){ if(limited(ip,30,60000)) return send(res,429,{error:'slow down'}); const sc0=Math.max(0,Math.min(60000,Math.floor(+u.searchParams.get('sc0'))||0)); return send(res,200,{tok:mkTok(sc0)}); }
  if(u.pathname==='/api/score'&&req.method==='POST'){
    if(limited(ip,12,60000)) return send(res,429,{error:'slow down'});
    let body=''; req.on('data',c=>{ body+=c; if(body.length>2000) req.destroy(); });
    req.on('end',()=>{
      let j; try{ j=JSON.parse(body); }catch(e){ return send(res,400,{error:'bad json'}); }
      const mode=j.mode==='co'?'co':j.mode==='daily'?'daily':j.mode==='weekly'?'weekly':'solo', M=(mode==='co'||mode==='weekly')?2:1;
      let name=mode==='co'?String(j.team||'').replace(/[^\w .\-!&+]/g,'').trim().slice(0,30):clean(j.name)||'ROHNIN'; if(BAD.test(name)) name=mode==='co'?'':'ROHNIN';
      if(!name) return send(res,400,{error:'bad team'});
      const score=Math.floor(+j.score), dist=Math.floor(+j.dist), di=Math.floor(+j.di)||0, kills=Math.floor(+j.kills)||0;
      if(!(score>=50)||!(dist>=0)||!isFinite(score)) return send(res,400,{error:'bad score'});
      // soft plausibility check: score is mostly distance plus boss/kill bonuses
      if(score>(dist*45+kills*900+60000)*M) return send(res,400,{error:'implausible'});
      // the run must have really been running: score gained needs real elapsed time
      const tk=readTok(j.tok); const el=tk?(Date.now()-tk.t0)/1000:0;
      if(!tk&&(score>6000||mode!=='solo')) return send(res,400,{error:'no run token'});
      if(tk&&(el>8*3600||score>(tk.sc0+el*320+3000)*M)) return send(res,400,{error:'implausible time'});
      const key=name.toLowerCase();
      if(mode!=='solo'){ if(!extra.weekly) extra.weekly={}; const list=mode==='co'?extra.co:mode==='weekly'?(extra.weekly[weekKey()]=extra.weekly[weekKey()]||[]):(extra.daily[dayKey()]=extra.daily[dayKey()]||[]); let e=list.find(s=>s.key===key);
        if(!e){ e={key,name,score:0,di:0,t:Date.now()}; list.push(e); }
        if(score>e.score){ e.score=score; e.di=di; e.name=name; e.t=Date.now(); xdirty=true; }
        if(mode==='daily'){ const ks=Object.keys(extra.daily).sort(); while(ks.length>14) delete extra.daily[ks.shift()]; }
        if(mode==='weekly'){ const ks=Object.keys(extra.weekly).sort(); while(ks.length>8) delete extra.weekly[ks.shift()]; }
        return send(res,200,{rank:rankIn(list,e.score),total:list.length,best:e.score}); }
      let e=scores.find(s=>s.key===key);
      if(!e){ e={key,name,score:0,di:0,t:Date.now()}; scores.push(e); }
      if(score>e.score){ e.score=score; e.di=di; e.name=name; e.t=Date.now(); dirty=true; }
      return send(res,200,{rank:rankOf(e.score),total:scores.length,best:e.score});
    }); return;
  }
  if(u.pathname.startsWith('/api/')) return send(res,404,{error:'not found'});
  let p=decodeURIComponent(u.pathname); if(p==='/') p='/index.html';
  const f=path.normalize(path.join(PUB,p)); if(!f.startsWith(PUB)||HIDE.test(p)){ res.writeHead(403); return res.end(); }
  fs.readFile(f,(err,buf)=>{ if(err){ res.writeHead(404); return res.end('Not found'); } const ct0=MIME[path.extname(f)]||MIME[path.extname(f).toLowerCase()]||'application/octet-stream'; const ext=path.extname(f).toLowerCase(); const vt=ext==='.mp4'?'video/mp4':ext==='.webm'?'video/webm':ext==='.jpg'?'image/jpeg':ext==='.txt'?'text/plain':ext==='.xml'?'application/xml':null; const rg=req.headers.range&&/^bytes=(\d*)-(\d*)$/.exec(req.headers.range); if(rg&&(ext==='.mp4'||ext==='.webm')){ let st=rg[1]===''?Math.max(0,buf.length-(+rg[2]||0)):+rg[1], en=rg[1]===''||rg[2]===''?buf.length-1:Math.min(+rg[2],buf.length-1); if(st>en||st>=buf.length){ res.writeHead(416,{'Content-Range':'bytes */'+buf.length}); return res.end(); } res.writeHead(206,{'Content-Type':vt,'Content-Range':'bytes '+st+'-'+en+'/'+buf.length,'Content-Length':en-st+1,'Accept-Ranges':'bytes','Cache-Control':'public, max-age=3600'}); return res.end(buf.slice(st,en+1)); } res.writeHead(200,{'Content-Type':vt||ct0,'Accept-Ranges':'bytes','Cache-Control':p==='/index.html'?'no-cache':'public, max-age=3600'}); res.end(buf); });
});
server.on('upgrade',(req,sock)=>{
  const u=new URL(req.url,'http://x'); const m=u.pathname.match(/^\/api\/room\/([A-Za-z]{4})\/ws$/); const key=req.headers['sec-websocket-key'];
  if(!m||!key||String(req.headers.upgrade).toLowerCase()!=='websocket'){ sock.destroy(); return; }
  const code=m[1].toUpperCase(), id=String(u.searchParams.get('id')||'').replace(/[^\w]/g,'').slice(0,12); if(!id){ sock.destroy(); return; }
  const r=roomOf(code); if(!r||(r.clients.size>=MAX_PER_ROOM&&!r.clients.has(id))){ sock.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); sock.destroy(); return; }
  const acc=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n');
  sock.setNoDelay(true); sock.setTimeout(0);
  const old=r.clients.get(id); if(old){ try{ old.end(); }catch(e){} }
  const me={ws:true,sock,end(){ try{ sock.destroy(); }catch(e){} }}; r.clients.set(id,me); r.t=Date.now();
  for(const [oid,st] of r.states) if(oid!==id) push(me,'state',st.j);
  let buf=Buffer.alloc(0), cnt=0, win=Date.now();
  sock.on('data',d=>{ buf=Buffer.concat([buf,d]); if(buf.length>16000){ sock.destroy(); return; }
    for(;;){ if(buf.length<2) return; const op=buf[0]&15, masked=buf[1]&128; let len=buf[1]&127, off=2; if(len===126){ if(buf.length<4) return; len=buf.readUInt16BE(2); off=4; } else if(len===127){ sock.destroy(); return; }
      if(!masked){ sock.destroy(); return; } if(buf.length<off+4+len) return; const mk=buf.slice(off,off+4), pl=Buffer.from(buf.slice(off+4,off+4+len)); for(let i=0;i<pl.length;i++) pl[i]^=mk[i&3]; buf=buf.slice(off+4+len);
      if(op===8){ try{ sock.write(wsFrame(8,Buffer.alloc(0))); }catch(e){} sock.destroy(); return; }
      if(op===9){ try{ sock.write(wsFrame(10,pl)); }catch(e){} continue; }
      if(op!==1) continue;
      const now=Date.now(); if(now-win>1000){ win=now; cnt=0; } if(++cnt>40) continue;
      let j; try{ j=JSON.parse(pl.toString()); }catch(e){ continue; } if(!j||typeof j!=='object') continue; j.id=id; const jj=JSON.stringify(j);
      r.states.set(id,{j:jj,t:now}); r.t=now; for(const [oid,c] of r.clients) if(oid!==id) push(c,'state',jj); } });
  const gone=()=>{ if(r.clients.get(id)===me) r.clients.delete(id); };
  sock.on('close',gone); sock.on('error',gone); sock.on('end',gone);
});
server.listen(PORT,()=>console.log('Rohnin\'s Rooftop Heist on :'+PORT));
process.on('SIGTERM',()=>{ try{ fs.writeFileSync(FILE,JSON.stringify(scores)); }catch(e){} saveExtra(); process.exit(0); });
