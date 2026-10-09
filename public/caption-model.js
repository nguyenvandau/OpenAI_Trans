// Language detection places source captions in a column; it never controls audio translation.
const VI_WORDS = new Set('và là của có cho với trong một những các tôi chúng ta này đó không được đã sẽ khi thì để bệnh nhân nghiên cứu điều trị kết quả thuốc sử dụng xin cảm ơn bác sĩ chào mừng hôm nay'.split(' '));
const EN_WORDS = new Set('the a an and is are was were of to in for with this that these those we our you your i they their not have has had will can may should study patient patients treatment results thank welcome today'.split(' '));
const VI_ACCENTS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/u;
const sentenceSegmenters = new Map();
const TITLE_ABBREVIATION = /\b(?:Dr|Mr|Mrs|Ms|Prof|Assoc|PGS|TS|ThS|GS|BS|BSCKI|BSCKII)\.$/iu;

function newestSentencesFirst(text, language) {
  if (!sentenceSegmenters.has(language)) {
    sentenceSegmenters.set(language, new Intl.Segmenter(language, { granularity: 'sentence' }));
  }
  const sentences = [];
  for (const paragraph of text.split('\n')) {
    const parts = [];
    for (const { segment } of sentenceSegmenters.get(language).segment(paragraph)) {
      // Keep a speaker's title with their name, rather than treating "Dr." as a sentence.
      if (parts.length && TITLE_ABBREVIATION.test(parts.at(-1).trimEnd())) parts[parts.length - 1] += segment;
      else parts.push(segment);
    }
    sentences.push(...parts.map(part => part.trim()).filter(Boolean));
  }
  // Reverse complete sentences/paragraphs, never their words or streaming deltas.
  return sentences.reverse().join('\n');
}

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
    this.historyOrderVersion = 0;
    this.reset();
  }

  reset() {
    this.turns = [];
    this.byId = new Map();
    this.sourcePrevious = new Map();
    this.historyStart = this.history.length;
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
    let orderChanged = false;
    if (event.type.startsWith('source_') && !turn.isSource) {
      turn.isSource = true;
      orderChanged = true;
    }
    if (event.type === 'source_turn' && Object.hasOwn(event, 'previousItemId')) {
      const previousId = typeof event.previousItemId === 'string' && event.previousItemId ? event.previousItemId : null;
      if (previousId !== turn.id && this.sourcePrevious.get(turn.id) !== previousId) {
        if (previousId) {
          // A later turn can emit partial text before its predecessor is seen.
          // Reserve an empty source row; never fill it with inferred text.
          this.turn(previousId).isSource = true;
        }
        this.sourcePrevious.set(turn.id, previousId);
        orderChanged = true;
      }
    }
    if (['vi', 'en'].includes(event.targetLanguage)) turn.targetLanguage = event.targetLanguage;
    if (event.type === 'source_delta') turn.source += event.delta || '';
    if (event.type === 'source_transcript' && typeof event.text === 'string') turn.source = event.text;
    if (event.type === 'target_delta') turn.target += event.delta || '';
    // Final ASR text replaces that item's provisional text. Translation is independent.
    // Do not pair deltas by timestamps or insert spaces between partial words.
    turn.sourceLanguage = detectCaptionLanguage(turn.source.slice(-1000))
      || (turn.targetLanguage ? (turn.targetLanguage === 'vi' ? 'en' : 'vi')
        : detectCaptionLanguage(turn.target) === 'vi' ? 'en' : detectCaptionLanguage(turn.target) === 'en' ? 'vi' : turn.sourceLanguage);
    if (orderChanged) this.orderSources();
  }

  orderSources() {
    const sources = this.turns.filter(turn => turn.isSource);
    const positions = new Map(sources.map((turn, index) => [turn.id, index]));
    const indegree = new Map(sources.map(turn => [turn.id, 0]));
    const successors = new Map();
    for (const [id, previousId] of this.sourcePrevious) {
      if (!positions.has(id) || !positions.has(previousId) || id === previousId) continue;
      indegree.set(id, indegree.get(id) + 1);
      const children = successors.get(previousId) || [];
      children.push(id);
      successors.set(previousId, children);
    }
    const queue = sources.filter(turn => !indegree.get(turn.id));
    const sorted = [];
    while (queue.length) {
      // Retain arrival order for independent streams. Only predecessor links
      // establish speech order; neither text timestamps nor final arrival do.
      queue.sort((a, b) => positions.get(a.id) - positions.get(b.id));
      const turn = queue.shift();
      sorted.push(turn);
      for (const id of successors.get(turn.id) || []) {
        indegree.set(id, indegree.get(id) - 1);
        if (!indegree.get(id)) queue.push(this.byId.get(id));
      }
    }
    // Malformed cyclic metadata must not remove captions from live/history.
    if (sorted.length < sources.length) {
      const included = new Set(sorted.map(turn => turn.id));
      sorted.push(...sources.filter(turn => !included.has(turn.id)));
    }
    if (sorted.every((turn, index) => turn === sources[index])) return;
    let index = 0;
    this.turns = this.turns.map(turn => turn.isSource ? sorted[index++] : turn);
    // Keep target rows in their existing slots and all previous sessions intact.
    this.history.splice(this.historyStart, this.turns.length, ...this.turns);
    this.historyOrderVersion++;
  }

  textFor(turn, language) {
    const targetLanguage = turn.targetLanguage || (turn.sourceLanguage === 'vi' ? 'en' : 'vi');
    return [language === turn.sourceLanguage ? turn.source : '', language === targetLanguage ? turn.target : ''].filter(Boolean).join('\n');
  }

  liveText(language) {
    // Keep rendering bounded while preserving the entire transcript separately.
    const text = this.turns.slice(-40).map(turn => this.textFor(turn, language)).filter(Boolean).join('\n').slice(-12000);
    return newestSentencesFirst(text, language).slice(0, 12000);
  }

  downloadText() {
    return ['LỜI THOẠI HỘI NGHỊ / CONFERENCE TRANSCRIPT — ANH / ENGLISH ↔ VIỆT / VIETNAMESE', ...this.history.filter(turn => turn.source || turn.target).map(turn =>
      `[${turn.time.toLocaleTimeString('vi-VN')}]\nBÁO CÁO VIÊN / SPEAKER (VI): ${this.textFor(turn, 'vi')}\nSPEAKER / BÁO CÁO VIÊN (EN): ${this.textFor(turn, 'en')}`)].join('\n\n');
  }
}
