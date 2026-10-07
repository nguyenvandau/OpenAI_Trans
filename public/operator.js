const $ = (id) => document.getElementById(id);
let stream, ctx, source, processor, ws;
let running = false;
let lastReportedError = '';

function log(s){ $('log').textContent = `[${new Date().toLocaleTimeString()}] ${s}\n` + $('log').textContent; }
function wsUrl(path){ return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`; }
function updateDirection(){ $('start').textContent = `Bắt đầu ${$('direction').value === 'en' ? 'Việt → Anh' : 'Anh → Việt'}`; }

async function loadConfig(){
  const cfg = await fetch('/api/config').then(r=>r.json());
  if(!running){ $('direction').value = cfg.targetLanguage; updateDirection(); }
  $('listenerUrl').textContent = cfg.listenerUrl;
  $('qr').src = `/api/qr.png?t=${Date.now()}`;
  if(cfg.configurationError){
    $('status').textContent='Chưa cấu hình API key';
    $('detail').textContent=cfg.configurationError;
  }
}

async function refreshDevices(){
  try {
    const temp = await navigator.mediaDevices.getUserMedia({audio:true});
    temp.getTracks().forEach(t=>t.stop());
  } catch(e){ log('Quyen microphone/audio input chua duoc cap: ' + e.message); }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput');
  $('device').innerHTML = devices.map((d,i)=>`<option value="${d.deviceId}">${d.label || 'Audio input '+(i+1)}</option>`).join('');
}

function downsample(float32, inRate, outRate=24000){
  if (inRate === outRate) return float32;
  const ratio = inRate / outRate;
  const outLen = Math.round(float32.length / ratio);
  const out = new Float32Array(outLen);
  let offset = 0;
  for(let i=0;i<outLen;i++){
    const next = Math.round((i+1)*ratio);
    let sum=0, count=0;
    for(let j=offset;j<next && j<float32.length;j++){ sum += float32[j]; count++; }
    out[i] = count ? sum/count : 0;
    offset = next;
  }
  return out;
}
function floatTo16(float32){
  const out = new Int16Array(float32.length);
  for(let i=0;i<float32.length;i++){
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s*0x8000 : s*0x7fff;
  }
  return out.buffer;
}

async function start(){
  if(running) return;
  running=true;
  lastReportedError='';
  $('start').disabled=true;
  $('direction').disabled=true;
  $('detail').textContent='';
  const deviceId = $('device').value;
  stream = await navigator.mediaDevices.getUserMedia({
    audio:{deviceId:deviceId?{exact:deviceId}:undefined, echoCancellation:false, noiseSuppression:false, autoGainControl:false}, video:false
  });
  ctx = new AudioContext();
  await ctx.resume();
  source = ctx.createMediaStreamSource(stream);
  // MVP: ScriptProcessor is broadly compatible but deprecated; replace with AudioWorklet for production.
  processor = ctx.createScriptProcessor(4096,1,1);
  const zeroGain = ctx.createGain(); zeroGain.gain.value = 0;
  source.connect(processor); processor.connect(zeroGain); zeroGain.connect(ctx.destination);

  ws = new WebSocket(wsUrl(`/ws/source?targetLanguage=${encodeURIComponent($('direction').value)}`));
  ws.binaryType='arraybuffer';
  ws.onopen=()=>{ running=true; $('status').textContent='Đang kết nối OpenAI'; $('start').disabled=true; $('stop').disabled=false; log('Nguồn âm thanh đã nối tới server.'); };
  ws.onclose=()=>{ stop().catch(e=>log(e.message)); $('status').textContent='Đã ngắt'; log('WebSocket nguồn âm thanh đã đóng.'); };
  ws.onerror=()=>log('Lỗi WebSocket nguồn âm thanh.');
  ws.onmessage=(ev)=>{
    let m; try{ m=JSON.parse(ev.data); }catch{ return; }
    if(m.type!=='status') return;
    if(m.error){
      $('status').textContent='Lỗi dịch';
      $('detail').textContent=m.error;
      if(lastReportedError!==m.error) log(m.error);
      lastReportedError=m.error;
    } else {
      lastReportedError='';
      $('detail').textContent='';
      $('status').textContent=m.aiReady?'Đang dịch trực tiếp':'Đang kết nối OpenAI';
    }
  };

  processor.onaudioprocess=(ev)=>{
    const input = ev.inputBuffer.getChannelData(0);
    let rms=0; for(let i=0;i<input.length;i++) rms += input[i]*input[i];
    rms=Math.sqrt(rms/input.length);
    $('meterFill').style.width = `${Math.min(100, rms*350)}%`;
    if(!running || ws?.readyState!==WebSocket.OPEN) return;
    const ds=downsample(input, ctx.sampleRate, 24000);
    ws.send(floatTo16(ds));
  };
}

async function stop(){
  running=false;
  if(ws) ws.onclose=null;
  try{ ws?.close(); }catch{}
  try{ processor?.disconnect(); source?.disconnect(); }catch{}
  try{ stream?.getTracks().forEach(t=>t.stop()); }catch{}
  try{ await ctx?.close(); }catch{}
  $('meterFill').style.width='0%'; $('status').textContent='Đã dừng'; $('start').disabled=false; $('stop').disabled=true;
  $('direction').disabled=false;
}

$('refresh').onclick=refreshDevices;
$('direction').onchange=updateDirection;
$('start').onclick=()=>start().catch(async e=>{await stop(); log(e.message); $('status').textContent='Lỗi';});
$('stop').onclick=stop;
loadConfig(); refreshDevices();
