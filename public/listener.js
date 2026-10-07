import { CaptionModel } from './caption-model.js';

const $=(id)=>document.getElementById(id);
let ctx=null, gain=null, nextTime=0, enabled=false;
let presentation = false, renderPending = false;
const captions = new CaptionModel();
const scheduledAudio = new Set();
const historyRows = new Map();

function resetPlayback(){
  for(const audio of scheduledAudio){ try{audio.stop();}catch{} }
  scheduledAudio.clear();
  nextTime=ctx?ctx.currentTime+0.12:0;
}
function resetSession(){
  resetPlayback();
  captions.reset();
  scheduleRender();
}
const ws = new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws/listen`);
ws.binaryType='arraybuffer';

$('listen').onclick=async()=>{
  if(!ctx){ ctx=new AudioContext(); gain=ctx.createGain(); gain.connect(ctx.destination); }
  await ctx.resume(); enabled=true; nextTime=Math.max(ctx.currentTime+0.12,nextTime); $('listen').textContent='Đang nghe ✓';
};

function renderCaptions(){
  renderPending = false;
  for(const [language, prefix, placeholder] of [
    ['vi', 'vietnamese', 'Chờ lời thoại tiếng Việt…'],
    ['en', 'english', 'Waiting for English captions…'],
  ]){
    const text = captions.liveText(language);
    $(prefix+'Text').textContent = text || placeholder;
    $(prefix+'Text').classList.toggle('caption-empty', !text);
    const viewport = $(prefix+'Window');
    viewport.scrollTop = viewport.scrollHeight;
  }
  if($('historyDialog').open) renderHistory();
}

function scheduleRender(){
  if(renderPending) return;
  renderPending = true;
  requestAnimationFrame(renderCaptions);
}

function renderHistory(){
  const content = $('historyContent');
  const fragment = document.createDocumentFragment();
  let hasText = false;
  for(const turn of captions.history){
    let view = historyRows.get(turn);
    if(!view){
      const row = document.createElement('article');
      row.className = 'history-turn';
      const time = document.createElement('time');
      time.dateTime = turn.time.toISOString();
      time.textContent = turn.time.toLocaleTimeString('vi-VN');
      const pair = document.createElement('div');
      pair.className = 'history-pair';
      view = {row};
      for(const [language, label] of [['vi', 'BÁO CÁO VIÊN'], ['en', 'SPEAKER']]){
        const paragraph = document.createElement('p');
        paragraph.lang = language;
        const heading = document.createElement('strong');
        heading.textContent = label;
        const text = document.createTextNode('');
        paragraph.append(heading, text);
        pair.append(paragraph);
        view[language] = text;
      }
      row.append(time, pair);
      fragment.append(row);
      historyRows.set(turn, view);
    }
    const hasTurnText = Boolean(turn.source || turn.target);
    view.row.hidden = !hasTurnText;
    hasText ||= hasTurnText;
    for(const language of ['vi', 'en']){
      const text = captions.textFor(turn, language) || '…';
      if(view[language].data !== text) view[language].data = text;
    }
  }
  content.append(fragment);
  let empty = content.querySelector('.history-empty');
  if(!hasText && !empty){
    const empty = document.createElement('p');
    empty.className = 'hint history-empty';
    empty.textContent = 'Chưa có lời thoại được ghi nhận.';
    content.append(empty);
  }
  if(hasText) empty?.remove();
  $('downloadHistory').disabled = !hasText;
}

$('showHistory').onclick=()=>{
  renderHistory();
  $('historyDialog').showModal();
};
$('closeHistory').onclick=()=>$('historyDialog').close();
$('downloadHistory').onclick=()=>{
  const url = URL.createObjectURL(new Blob(['\ufeff'+captions.downloadText()], {type:'text/plain;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = `loi-thoai-hoi-nghi-${new Date().toISOString().slice(0,10)}.txt`;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
};

function leavePresentation(){
  presentation = false;
  document.body.classList.remove('caption-mode');
  $('returnFromFullScreen').hidden = true;
  $('fullScreen').focus({preventScroll:true});
  scheduleRender();
}

$('fullScreen').onclick=async()=>{
  presentation = true;
  document.body.classList.add('caption-mode');
  $('returnFromFullScreen').hidden = false;
  // Keep the same caption elements and AudioContext so playback continues uninterrupted.
  try { await $('captionStage').requestFullscreen({navigationUI:'hide'}); }
  catch { /* Use the full-window layout when native fullscreen is unavailable. */ }
  $('returnFromFullScreen').focus({preventScroll:true});
  scheduleRender();
};
$('returnFromFullScreen').onclick=async()=>{
  if(document.fullscreenElement){
    try { await document.exitFullscreen(); } catch { return; }
  }
  leavePresentation();
};
document.addEventListener('fullscreenchange', ()=>{
  if(!document.fullscreenElement && presentation) leavePresentation();
  else scheduleRender();
});
document.addEventListener('keydown', event=>{
  if(event.key==='Escape' && presentation && !document.fullscreenElement) leavePresentation();
});
window.addEventListener('resize', scheduleRender);
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) scheduleRender(); });
// Live captions always follow the newest line, including after a font finishes loading.
document.fonts.ready.then(scheduleRender);

function receiveCaption(message){
  captions.update(message);
  scheduleRender();
}
function playPcm16(buf){
  if(!enabled || !ctx || !gain) return;
  const pcm=new Int16Array(buf); const f=new Float32Array(pcm.length);
  for(let i=0;i<pcm.length;i++) f[i]=pcm[i]/32768;
  const ab=ctx.createBuffer(1,f.length,24000); ab.copyToChannel(f,0);
  const src=ctx.createBufferSource(); src.buffer=ab; src.connect(gain);
  if(nextTime < ctx.currentTime+0.05) nextTime=ctx.currentTime+0.10;
  // Realtime generates audio faster than playback; preserve its order without overlapping chunks.
  scheduledAudio.add(src);
  src.onended=()=>scheduledAudio.delete(src);
  src.start(nextTime); nextTime += ab.duration;
}

ws.onopen=()=>{$('status').textContent='Đã vào phòng. Chờ ban tổ chức bắt đầu.';};
ws.onclose=()=>{resetPlayback(); $('status').textContent='Mất kết nối. Hãy tải lại trang.';};
ws.onmessage=(ev)=>{
  if(typeof ev.data!=='string'){ playPcm16(ev.data); return; }
  let m; try{m=JSON.parse(ev.data);}catch{return;}
  if(m.type==='session_reset'){
    resetSession();
  } else if(m.type==='status'){
    $('direction').textContent=m.targetLanguage === 'vi' ? 'Thủ công Anh → Việt' : m.targetLanguage === 'en' ? 'Thủ công Việt → Anh' : 'Tự động Anh ↔ Việt';
    if(!m.sourceConnected) resetPlayback();
    $('status').textContent = m.error ? `Lỗi dịch: ${m.error}` : (m.aiReady ? `Đang dịch trực tiếp • ${m.listeners||1} người nghe` : (m.sourceConnected?'Đang khởi tạo AI…':'Chờ ban tổ chức bắt đầu'));
  } else if(['source_turn', 'source_delta', 'source_transcript', 'target_delta'].includes(m.type)){
    receiveCaption(m);
  } else if(m.type==='caption_warning'){
    $('status').textContent='Lưu ý phiên dịch: '+m.message;
  } else if(m.type==='error'){
    $('status').textContent='Lỗi dịch: '+m.message;
  }
};
