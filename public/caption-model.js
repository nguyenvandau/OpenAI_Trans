// Language detection places source captions in a column; it never controls audio translation.
const VI_WORDS = new Set('và là của có cho với trong một những các tôi chúng ta này đó không được đã sẽ khi thì để bệnh nhân nghiên cứu điều trị kết quả thuốc sử dụng xin cảm ơn bác sĩ chào mừng hôm nay'.split(' '));
const EN_WORDS = new Set('the a an and is are was were of to in for with this that these those we our you your i they their not have has had will can may should study patient patients treatment results thank welcome today'.split(' '));
const VI_ACCENTS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/u;

export function detectCaptionLanguage(text) {
  let vi = 0, en = 0;
  for (const word of text.toLowerCase().match(/[\p{L}]+/gu) || []) {
    if (VI_ACCENTS.test(word)) vi += 2;
    if (VI_WORDS.has(word)) vi += 2;
    if (EN_WORDS.has(word)) en += 2;
  }
  return vi > en ? 'vi' : en > vi ? 'en' : null;
}

export class CaptionModel {
  constructor() {
    this.history = [];
    this.reset();
  }

  reset() {
    this.turns = [];
    this.byId = new Map();
    this.fallbackId = 0;
  }

  turn(itemId) {
    const id = itemId || `caption-${++this.fallbackId}`;
    if (!this.byId.has(id)) {
      const turn = { id, source: '', target: '', sourceLanguage: 'en', targetLanguage: null, time: new Date() };
      this.byId.set(id, turn);
      this.turns.push(turn);
      this.history.push(turn);
    }
    return this.byId.get(id);
  }

  update(event) {
    const turn = this.turn(event.itemId);
    if (['vi', 'en'].includes(event.targetLanguage)) turn.targetLanguage = event.targetLanguage;
    if (event.type === 'source_delta') turn.source += event.delta || '';
    if (event.type === 'target_delta') turn.target += event.delta || '';
    // Source and translation append independently within a session/language segment.
    // Do not pair deltas by timestamps or insert spaces between partial words.
    turn.sourceLanguage = detectCaptionLanguage(turn.source.slice(-1000))
      || (turn.targetLanguage ? (turn.targetLanguage === 'vi' ? 'en' : 'vi')
        : detectCaptionLanguage(turn.target) === 'vi' ? 'en' : detectCaptionLanguage(turn.target) === 'en' ? 'vi' : turn.sourceLanguage);
  }

  textFor(turn, language) {
    const targetLanguage = turn.targetLanguage || (turn.sourceLanguage === 'vi' ? 'en' : 'vi');
    return [language === turn.sourceLanguage ? turn.source : '', language === targetLanguage ? turn.target : ''].filter(Boolean).join('\n');
  }

  liveText(language) {
    // Keep rendering bounded while preserving the entire transcript separately.
    return this.turns.slice(-40).map(turn => this.textFor(turn, language)).filter(Boolean).join('\n').slice(-12000);
  }

  downloadText() {
    return ['LỜI THOẠI HỘI NGHỊ — ANH / VIỆT', ...this.history.filter(turn => turn.source || turn.target).map(turn =>
      `[${turn.time.toLocaleTimeString('vi-VN')}]\nBÁO CÁO VIÊN (VI): ${this.textFor(turn, 'vi')}\nSPEAKER (EN): ${this.textFor(turn, 'en')}`)].join('\n\n');
  }
}
