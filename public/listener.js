import { CaptionModel } from './caption-model.js';
import { CaptionPager } from './caption-pager.js';

const $=(id)=>document.getElementById(id);
let ctx=null, gain=null, nextTime=0, enabled=false;
let listeningRequest = null;
let presentation = false, renderPending = false;
let presentationTransition = false;
let renderedHistoryOrderVersion = 0;
let presentationRevision = 0;
let targetLanguage = 'vi';
const captions = new CaptionModel();
const pip = { open:false, opening:false, video:false, panel:$('pipCaption'), title:$('pipTitle'), viewport:$('pipWindow'), text:$('pipText') };
// A video PiP window has no browser title bar, unlike Document PiP, so captions are drawn on a canvas.
// The window keeps the canvas's aspect ratio: the Width slider changes that shape, Lines the text size.
const PIP_HEIGHT = 400, PIP_PADDING = 36;
const pipCanvas = document.createElement('canvas');
const pipVideo = Object.assign(document.createElement('video'), { muted:true, playsInline:true });
const renderChannel = new MessageChannel();
renderChannel.port1.onmessage = ()=>renderCaptions();
const scheduledAudio = new Set();
const historyRows = new Map();
let captionFontRevision = 0;
const captionPanes = [
  ['vi', 'vietnamese', 'Chờ lời thoại tiếng Việt…', 'Tiếng Việt'],
  ['en', 'english', 'Waiting for English captions…', 'English'],
].map(([language, prefix, placeholder, title]) => {
  const viewport = $(prefix+'Window');
  const measure = document.createElement('div');
  measure.className = 'caption-measure';
  measure.setAttribute('aria-hidden', 'true');
  viewport.append(measure);
  return {language, placeholder, title, viewport, content: $(prefix+'Text'), measure, pager: new CaptionPager()};
});

function captionPageText(pane, text){
  if(!text){
    pane.pager.reset();
    pane.content.dataset.pageNumber = 1;
    return '';
  }
  const {viewport, measure, pager} = pane;
  const firstBreak = text.indexOf('\n');
  const newestSentence = firstBreak === -1 ? text : text.slice(0, firstBreak);
  const earlierSentences = firstBreak === -1 ? '' : text.slice(firstBreak);
  const style = getComputedStyle(viewport);
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const layout = [width, height, style.font, style.lineHeight, style.letterSpacing,
    style.wordSpacing, captionFontRevision].join('|');
  if(measure.style.width !== width+'px') measure.style.width = width+'px';
  const page = pager.page(newestSentence, layout, candidate => {
    if(!candidate) return true;
    measure.textContent = candidate;
    return measure.getBoundingClientRect().height <= height;
  });
  pane.content.dataset.pageNumber = page.pageNumber;
  return page.text + earlierSentences;
}

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
  for(const pane of captionPanes) pane.pager.reset();
  $('captionWarning').hidden = true;
  scheduleRender();
}
const ws = new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws/listen`);
ws.binaryType='arraybuffer';


function showAudioWarning(){
  enabled = false;
  resetPlayback();
  $('listen').textContent = 'Bắt đầu nghe / Start to listen';
  $('audioWarning').textContent = 'Âm thanh chưa bật hoặc đang tạm dừng. Nếu đang toàn màn hình, bấm Quay lại, rồi Bắt đầu nghe để thử lại. / Audio has not started or is paused. In Full Screen, press Back, then Start to listen to retry.';
  $('audioWarning').hidden = false;
}

function startListening(){
  if(listeningRequest) return listeningRequest;
  try {
    // Safari uses the media playback route for interpretation, including when
    // the iPhone ring/silent switch is on. Other browsers may omit this API.
    try { if(navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    const unlock = ctx?.state !== 'running';
    if(!ctx || ctx.state === 'closed'){
      resetPlayback();
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      ctx = new AudioContextClass();
      nextTime = ctx.currentTime + 0.12;
      gain = ctx.createGain();
      gain.connect(ctx.destination);
      const audioContext = ctx;
      audioContext.addEventListener('statechange', ()=>{
        if(audioContext === ctx && enabled && !listeningRequest && audioContext.state !== 'running') showAudioWarning();
      });
    }
    if(ctx.state !== 'running') $('listen').textContent = 'Đang bật âm thanh / Starting audio…';
    if(unlock){
      // Start one silent sample in the same tap. The first network audio chunk
      // arrives later, outside Safari's user-activation window.
      const source = ctx.createBufferSource();
      source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      source.connect(ctx.destination);
      source.onended = ()=>source.disconnect();
      source.start(0);
    }
    // Invoke resume immediately inside the Start click, before any await.
    const resume = ctx.resume();
    const audioContext = ctx;
    let timeout;
    const startupTimeout = new Promise((_, reject)=>{
      timeout = setTimeout(()=>reject(new Error('Audio startup timed out')), 8000);
    });
    const request = Promise.race([Promise.resolve(resume), startupTimeout]).then(()=>{
      if(listeningRequest !== request || ctx !== audioContext) return false;
      if(audioContext.state !== 'running') throw new Error('Audio context is not running');
      enabled = true;
      nextTime = Math.max(ctx.currentTime + 0.12, nextTime);
      $('listen').textContent = 'Đang nghe / Listening ✓';
      $('audioWarning').hidden = true;
      return true;
    }).catch(()=>{
      if(listeningRequest === request && ctx === audioContext) showAudioWarning();
      return false;
    }).finally(()=>{
      clearTimeout(timeout);
      if(listeningRequest === request) listeningRequest = null;
    });
    listeningRequest = request;
    return request;
  } catch {
    showAudioWarning();
    return Promise.resolve(false);
  }
}

$('listen').onclick=startListening;

function showCaption(textElement, viewport, text, placeholder){
  textElement.textContent = text || placeholder;
  textElement.classList.toggle('caption-empty', !text);
  viewport.scrollTop = 0;
}

function renderCaptions(){
  renderPending = false;
  for(const pane of captionPanes){
    const text = captions.liveText(pane.language);
    const displayText = captionPageText(pane, text) || pane.placeholder;
    // Independent source/translation events must not replace an unchanged
    // text node. Paging changes only the live view, never the transcript.
    if(pane.content.textContent !== displayText) pane.content.textContent = displayText;
    pane.content.classList.toggle('caption-empty', !text);
    pane.viewport.scrollTop = 0;
    if(pip.open && pane.language === targetLanguage){
      pip.title.textContent = pane.title;
      pip.viewport.lang = pane.language;
      showCaption(pip.text, pip.viewport, text, pane.placeholder);
      if(pip.video) drawPipFrame(text, pane.placeholder);
    }
  }
  if($('historyDialog').open) renderHistory();
}

function scheduleRender(){
  if(renderPending) return;
  renderPending = true;
  // The page is often in a background tab while its PiP window is showing, and frames pause there.
  if(pip.video) renderChannel.port2.postMessage(null);
  else requestAnimationFrame(renderCaptions);
}

function wrapLines(context, text, maxWidth, maxLines){
  const lines = [];
  for(const paragraph of text.split('\n')){
    let line = '';
    for(const word of paragraph.split(/\s+/).filter(Boolean)){
      const candidate = line ? `${line} ${word}` : word;
      if(context.measureText(candidate).width <= maxWidth){ line = candidate; continue; }
      if(line) lines.push(line);
      line = word;
      // Break a word wider than the window, like overflow-wrap: anywhere.
      while(line.length > 1 && context.measureText(line).width > maxWidth){
        let fit = line.length - 1;
        while(fit > 1 && context.measureText(line.slice(0, fit)).width > maxWidth) fit--;
        lines.push(line.slice(0, fit));
        line = line.slice(fit);
      }
      if(lines.length >= maxLines) return lines.slice(0, maxLines);
    }
    if(line) lines.push(line);
    if(lines.length >= maxLines) break;
  }
  return lines.slice(0, maxLines);
}

function drawPipFrame(text, placeholder){
  const {width, height} = pipCanvas, lines = Number($('pipLines').value);
  const lineHeight = (height - PIP_PADDING*2) / lines, fontSize = Math.round(lineHeight / 1.4);
  const context = pipCanvas.getContext('2d');
  context.fillStyle = '#0d1729';
  context.fillRect(0, 0, width, height);
  context.font = `500 ${fontSize}px "Segoe UI", Tahoma, Arial, sans-serif`;
  context.textBaseline = 'top';
  context.fillStyle = text ? '#fff' : '#98a7bc';
  // Newest sentences come first, so the top lines are the latest speech.
  wrapLines(context, text || placeholder, width - PIP_PADDING*2, lines)
    .forEach((line, index)=>context.fillText(line, PIP_PADDING, PIP_PADDING + index*lineHeight + (lineHeight - fontSize)/2));
}

function resizePipCanvas(){
  pipCanvas.width = Math.round(PIP_HEIGHT * Number($('pipRatio').value));
  pipCanvas.height = PIP_HEIGHT;
  $('pipLinesValue').textContent = `${$('pipLines').value} dòng / lines`;
}
for(const input of [$('pipRatio'), $('pipLines')]){
  try { const saved = localStorage.getItem(input.id); if(saved) input.value = saved; } catch {}
  input.addEventListener('input', ()=>{
    try { localStorage.setItem(input.id, input.value); } catch {}
    resizePipCanvas();
    renderCaptions(); // Resizing clears the canvas; redraw in the same task so no blank frame is sent.
  });
}
resizePipCanvas();

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

async function enterPresentation(){
  if(presentation || presentationTransition) return;
  presentationTransition = true;
  presentation = true;
  document.body.classList.add('caption-mode');
  $('returnFromFullScreen').hidden = false;
  // Keep the same caption elements and AudioContext so playback continues uninterrupted.
  try {
    try { await $('captionStage').requestFullscreen({navigationUI:'hide'}); }
    catch { /* Use the full-window layout when native fullscreen is unavailable. */ }
    if(presentation) $('returnFromFullScreen').focus({preventScroll:true});
    scheduleRender();
  } finally { presentationTransition = false; }
}
async function exitPresentation(){
  if(!presentation || presentationTransition) return;
  presentationTransition = true;
  try {
    if(document.fullscreenElement){
      try { await document.exitFullscreen(); } catch { return; }
    }
    leavePresentation();
  } finally { presentationTransition = false; }
}
function togglePresentation(){
  return presentation ? exitPresentation() : enterPresentation();
}
$('fullScreen').onclick=togglePresentation;
$('returnFromFullScreen').onclick=exitPresentation;
document.addEventListener('fullscreenchange', ()=>{
  if(!document.fullscreenElement && presentation) leavePresentation();
  else scheduleRender();
});
document.addEventListener('keydown', event=>{
  if(event.defaultPrevented || event.isComposing || event.repeat || document.querySelector('dialog[open]')) return;
  if(event.key === 'Escape'){
    if(presentation && !document.fullscreenElement){
      event.preventDefault();
      exitPresentation();
    }
    return;
  }
  if(event.key.toLowerCase() !== 'f' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  const editing = event.composedPath().some(target => target instanceof Element
    && (target.matches('input, textarea, select') || target.isContentEditable));
  if(editing) return;
  event.preventDefault();
  togglePresentation();
});

// Picture in Picture: target-language captions only. Chrome, Edge and Safari get an always-on-top
// video window without a title bar; other browsers get a draggable, resizable overlay in the page.
function placeOverlay(left, top, width, height){
  const margin = 8, {clientWidth, clientHeight} = document.documentElement; // Excludes scrollbars.
  width = Math.min(Math.max(width, 240), clientWidth - margin*2);
  height = Math.min(Math.max(height, 120), clientHeight - margin*2);
  left = Math.min(Math.max(left, margin), clientWidth - width - margin);
  top = Math.min(Math.max(top, margin), clientHeight - height - margin);
  Object.assign(pip.panel.style, {left:`${left}px`, top:`${top}px`, width:`${width}px`, height:`${height}px`});
}

async function openPip(){
  pip.open = pip.opening = true;
  if(document.pictureInPictureEnabled){
    try {
      pipVideo.srcObject ??= pipCanvas.captureStream();
      pip.video = true;
      renderCaptions(); // The stream needs a first frame before the video can play.
      await pipVideo.play();
      await pipVideo.requestPictureInPicture();
    } catch {
      pip.video = false;
      pipVideo.pause();
    }
  }
  if(!pip.video){
    const {clientWidth, clientHeight} = document.documentElement;
    const width = Math.min(480, clientWidth - 32), height = 220;
    placeOverlay(clientWidth - width - 16, clientHeight - height - 16, width, height);
    pip.panel.hidden = false;
  }
  pip.opening = false;
  $('pipSize').hidden = !pip.video;
  $('pictureInPicture').setAttribute('aria-pressed', 'true');
  renderPending = false;
  scheduleRender();
}

function closedPip(){
  pip.open = pip.video = false;
  pip.panel.hidden = true;
  $('pipSize').hidden = true;
  pipVideo.pause();
  $('pictureInPicture').setAttribute('aria-pressed', 'false');
  renderPending = false;
  scheduleRender();
}

function closePip(){
  if(document.pictureInPictureElement === pipVideo) document.exitPictureInPicture(); // Fires leavepictureinpicture.
  else closedPip();
}

pipVideo.addEventListener('leavepictureinpicture', closedPip);
// A paused video would freeze the captions in the PiP window.
pipVideo.addEventListener('pause', ()=>{ if(pip.video && !pip.opening) pipVideo.play().catch(()=>{}); });

$('pictureInPicture').onclick=()=>{
  if(pip.opening) return;
  if(pip.open) closePip();
  else openPip();
};
$('closePip').onclick=closePip;

function onDrag(handle, update){
  handle.addEventListener('pointerdown', down=>{
    if(down.button !== 0 || down.target.closest('.pip-close')) return;
    down.preventDefault();
    const start = pip.panel.getBoundingClientRect();
    const move = event=>update(start, event.clientX - down.clientX, event.clientY - down.clientY);
    handle.setPointerCapture(down.pointerId);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('lostpointercapture', ()=>handle.removeEventListener('pointermove', move), {once:true});
  });
}
onDrag($('pipBar'), (start, dx, dy)=>placeOverlay(start.left + dx, start.top + dy, start.width, start.height));
onDrag($('pipResize'), (start, dx, dy)=>placeOverlay(start.left, start.top, start.width + dx, start.height + dy));
$('pipBar').addEventListener('keydown', event=>{
  const step = {ArrowLeft:[-24, 0], ArrowRight:[24, 0], ArrowUp:[0, -24], ArrowDown:[0, 24]}[event.key];
  if(!step) return;
  event.preventDefault();
  const box = pip.panel.getBoundingClientRect();
  if(event.shiftKey) placeOverlay(box.left, box.top, box.width + step[0], box.height + step[1]);
  else placeOverlay(box.left + step[0], box.top + step[1], box.width, box.height);
});
window.addEventListener('resize', ()=>{
  if(pip.open && !pip.video){
    const box = pip.panel.getBoundingClientRect();
    placeOverlay(box.left, box.top, box.width, box.height);
  }
});

window.addEventListener('resize', scheduleRender);
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) scheduleRender(); });
// Re-page after font or viewport changes, including speaker/photo/QR/warning
// updates that resize the fullscreen panes without resizing the browser.
function refreshCaptionFonts(){ captionFontRevision++; scheduleRender(); }
document.fonts.ready.then(refreshCaptionFonts);
document.fonts.addEventListener('loadingdone', refreshCaptionFonts);
const captionResizeObserver = new ResizeObserver(scheduleRender);
for(const pane of captionPanes) captionResizeObserver.observe(pane.viewport);

function receiveCaption(message){
  captions.update(message);
  scheduleRender();
}
function playPcm16(buf){
  if(!enabled || !ctx || !gain || ctx.state !== 'running') return;
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
    const language = m.targetLanguage === 'en' ? 'en' : 'vi';
    if(language !== targetLanguage){ targetLanguage = language; scheduleRender(); }
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
