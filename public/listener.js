const $=(id)=>document.getElementById(id);
let ctx=null, gain=null, nextTime=0, enabled=false;
let targetText='', sourceText='';
let targetLanguage=null;
const ws = new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws/listen`);
ws.binaryType='arraybuffer';

$('listen').onclick=async()=>{
  if(!ctx){ ctx=new AudioContext(); gain=ctx.createGain(); gain.connect(ctx.destination); }
  await ctx.resume(); enabled=true; nextTime=Math.max(ctx.currentTime+0.12,nextTime); $('listen').textContent='Đang nghe ✓';
};

function appendText(current, delta, max=1400){
  const s=current+delta; return s.length>max?s.slice(-max):s;
}
function playPcm16(buf){
  if(!enabled || !ctx || !gain) return;
  const pcm=new Int16Array(buf); const f=new Float32Array(pcm.length);
  for(let i=0;i<pcm.length;i++) f[i]=pcm[i]/32768;
  const ab=ctx.createBuffer(1,f.length,24000); ab.copyToChannel(f,0);
  const src=ctx.createBufferSource(); src.buffer=ab; src.connect(gain);
  if(nextTime < ctx.currentTime+0.05) nextTime=ctx.currentTime+0.10;
  // If backlog grows too much after a network stall, jump forward instead of playing old speech.
  if(nextTime > ctx.currentTime+2.0) nextTime=ctx.currentTime+0.15;
  src.start(nextTime); nextTime += ab.duration;
}

ws.onopen=()=>{$('status').textContent='Đã vào phòng. Chờ ban tổ chức bắt đầu.';};
ws.onclose=()=>{$('status').textContent='Mất kết nối. Hãy tải lại trang.';};
ws.onmessage=(ev)=>{
  if(typeof ev.data!=='string'){ playPcm16(ev.data); return; }
  let m; try{m=JSON.parse(ev.data);}catch{return;}
  if(m.type==='status'){
    $('direction').textContent=m.targetLanguage==='en'?'Việt → Anh':'Anh → Việt';
    $('subtitleTitle').textContent=m.targetLanguage==='en'?'Phụ đề tiếng Anh':'Phụ đề tiếng Việt';
    if(targetLanguage!==m.targetLanguage){
      targetText=''; sourceText=''; $('subtitle').textContent='…'; $('source').textContent='…';
      targetLanguage=m.targetLanguage;
    }
    $('status').textContent = m.error ? `Lỗi dịch: ${m.error}` : (m.aiReady ? `Đang dịch trực tiếp • ${m.listeners||1} người nghe` : (m.sourceConnected?'Đang khởi tạo AI…':'Chờ ban tổ chức bắt đầu'));
  } else if(m.type==='target_delta'){
    targetText=appendText(targetText,m.delta); $('subtitle').textContent=targetText;
  } else if(m.type==='source_delta'){
    sourceText=appendText(sourceText,m.delta,800); $('source').textContent=sourceText;
  } else if(m.type==='error'){
    $('status').textContent='Lỗi dịch: '+m.message;
  }
};
