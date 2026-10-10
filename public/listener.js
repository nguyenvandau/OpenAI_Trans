import { CaptionModel } from './caption-model.js';

const $=(id)=>document.getElementById(id);
let ctx=null, gain=null, nextTime=0, enabled=false;
let presentation = false, renderPending = false;
let renderedHistoryOrderVersion = 0;
let presentationRevision = 0;
const captions = new CaptionModel();
const scheduledAudio = new Set();
const historyRows = new Map();

function interpretationError(detail){
  return `Lỗi dịch / Interpretation error: ${detail} • Vui lòng báo ban tổ chức. / Please ask the organizers to check the interpretation service.`;
}

function showPresentation(info){
  if(!info) return;
  presentationRevision++;
  const speakerName = typeof info.speakerName === 'string' ? info.speakerName : '';
  const talkTitle = typeof info.talkTitle === 'string' ? info.talkTitle : '';
  const photoUrl = typeof info.speakerPhotoUrl === 'string' ? info.speakerPhotoUrl : '';
  const showPhoto = info.showSpeakerPhoto === true && Boolean(photoUrl);
  if(photoUrl && $('currentSpeakerPhoto').getAttribute('src') !== photoUrl) $('currentSpeakerPhoto').src = photoUrl;
  if(!photoUrl) $('currentSpeakerPhoto').removeAttribute('src');
  $('currentSpeakerPhoto').alt = speakerName ? `Ảnh ${speakerName} / Photo of ${speakerName}` : 'Ảnh báo cáo viên / Speaker photo';
  $('speakerPortrait').hidden = !showPhoto;
  $('presentationBanner').classList.toggle('has-speaker-photo', showPhoto);
  if($('currentSpeaker').textContent !== speakerName) $('currentSpeaker').textContent = speakerName;
  if($('currentTalk').textContent !== talkTitle) $('currentTalk').textContent = talkTitle;
  $('speakerLine').hidden = !speakerName;
  $('talkLine').hidden = !talkTitle;
  $('presentationBanner').hidden = !speakerName && !talkTitle && !showPhoto;
  $('listenerQr').hidden = info.showListenerQr !== true;
  if(info.showListenerQr === true && !$('listenerQrImage').getAttribute('src')) $('listenerQrImage').src = '/api/qr.png';
}

// A late initial fetch must not replace a newer WebSocket update.
const initialPresentationRevision = presentationRevision;
fetch('/api/config').then(response=>response.json()).then(config=>{
  if(typeof config.listenerUrl === 'string') $('listenerQr').href = config.listenerUrl;
  if(presentationRevision === initialPresentationRevision) showPresentation(config.presentation);
}).catch(()=>{ /* The room status also supplies the current presentation. */ });

function resetPlayback(){
  for(const audio of scheduledAudio){ try{audio.stop();}catch{} }
  scheduledAudio.clear();
  nextTime=ctx?ctx.currentTime+0.12:0;
}
function resetSession(){
  resetPlayback();
  captions.reset();
  $('captionWarning').hidden = true;
  scheduleRender();
}
const ws = new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws/listen`);
ws.binaryType='arraybuffer';


$('listen').onclick=async()=>{
  if(!ctx){ ctx=new AudioContext(); gain=ctx.createGain(); gain.connect(ctx.destination); }
  await ctx.resume(); enabled=true; nextTime=Math.max(ctx.currentTime+0.12,nextTime); $('listen').textContent='Đang nghe / Listening ✓';
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
    viewport.scrollTop = 0;
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
  const reorder = renderedHistoryOrderVersion !== captions.historyOrderVersion;
  let hasText = false;
  for(const turn of captions.history.slice().reverse()){
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
      for(const [language, label] of [['vi', 'DIỄN GIẢ / SPEAKER'], ['en', 'SPEAKER / DIỄN GIẢ']]){
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
    // Move existing rows only when predecessor IDs changed their order.
    if(reorder) fragment.append(view.row);
    const hasTurnText = Boolean(turn.source || turn.target);
    view.row.hidden = !hasTurnText;
    hasText ||= hasTurnText;
    for(const language of ['vi', 'en']){
      const text = captions.textFor(turn, language) || '…';
      if(view[language].data !== text) view[language].data = text;
    }
  }
  content.prepend(fragment);
  renderedHistoryOrderVersion = captions.historyOrderVersion;
  let empty = content.querySelector('.history-empty');
  if(!hasText && !empty){
    const empty = document.createElement('p');
    empty.className = 'hint history-empty';
    empty.textContent = 'Chưa có lời thoại được ghi nhận. / No transcript has been received yet.';
    content.append(empty);
  }
  if(hasText) empty?.remove();
  $('downloadHistory').disabled = !hasText;
}

$('showHistory').onclick=()=>{
  renderHistory();
  $('historyDialog').showModal();
  $('historyContent').scrollTop = 0;
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
  // Chunk sizes vary. Preserve every chunk in order, including the tail after Stop.
  scheduledAudio.add(src);
  src.onended=()=>scheduledAudio.delete(src);
  src.start(nextTime); nextTime += ab.duration;
}

ws.onopen=()=>{$('status').textContent='Đã vào phòng. Chờ ban tổ chức bắt đầu. / Connected. Waiting for the organizers to start.';};
ws.onclose=()=>{
  resetPlayback();
  $('status').textContent='Mất kết nối. Hãy tải lại trang. / Connection lost. Please reload the page.';
};
ws.onmessage=(ev)=>{
  if(typeof ev.data!=='string'){ playPcm16(ev.data); return; }
  let m; try{m=JSON.parse(ev.data);}catch{return;}
  if(m.type==='session_reset'){
    resetSession();
  } else if(m.type==='status'){
    showPresentation(m.presentation);
    $('captionWarning').hidden = !m.captionWarning;
    $('direction').textContent=m.targetLanguage === 'en' ? 'Việt / Vietnamese → Anh / English' : 'Anh / English → Việt / Vietnamese';
    $('status').textContent = m.error ? interpretationError(m.error) : m.draining ? 'Đang phát phần dịch cuối… / Playing the remaining interpretation…'
      : m.aiReady ? `Đang dịch song song / Simultaneous interpretation • ${m.listeners||1} người nghe / listeners`
        : m.sourceConnected ? 'Đang khởi tạo AI… / Starting interpretation…' : 'Chờ ban tổ chức bắt đầu / Waiting for the organizers to start';
  } else if(m.type==='presentation_update'){
    showPresentation(m.presentation);
  } else if(['source_turn', 'source_delta', 'source_transcript', 'target_delta'].includes(m.type)){
    receiveCaption(m);
  } else if(m.type==='caption_warning'){
    $('captionWarning').hidden = false;
  } else if(m.type==='error'){
    $('status').textContent=interpretationError(m.message);
  }
};
