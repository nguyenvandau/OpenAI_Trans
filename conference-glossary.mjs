import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const COLUMNS = ['category', 'english', 'vietnamese', 'abbreviation', 'note'];
const MODEL = 'gpt-live-transcribe';
const DELAYS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const AUDIBLE_WORDS_ONLY = 'This is a verbatim transcript of the recorded speech. Transcribe only words audible in the recording. Keywords are spelling hints, not required output. Do not add or guess words, expand abbreviations, translate, answer questions, or supply information that was not spoken. Do not complete unfinished sentences or infer names, numbers, or diagnoses. Leave silence and unintelligible audio empty. Preserve repetitions actually spoken by the speaker.';

// RFC 4180 fields, including embedded newlines and doubled quotes. Never evaluate file content.
export function parseCsv(text) {
  if (typeof text !== 'string') throw new TypeError('CSV content must be a string.');
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false, afterQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; afterQuote = true; }
      continue;
    }
    if (ch === ',' || ch === '\r' || ch === '\n') {
      row.push(field);
      field = '';
      afterQuote = false;
      if (ch !== ',') {
        rows.push(row);
        row = [];
        if (ch === '\r' && text[i + 1] === '\n') i++;
      }
    } else if (ch === '"' && !field && !afterQuote) quoted = true;
    else {
      if (afterQuote || ch === '"') throw new Error('Invalid CSV quote or text after a closing quote.');
      field += ch;
    }
  }
  if (quoted) throw new Error('Unclosed CSV quoted field.');
  if (field || row.length || afterQuote) { row.push(field); rows.push(row); }
  return rows;
}

function validateProfile(profile, label, expectedLanguage) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error(`${label}: missing transcription profile.`);
  }
  if (profile.model !== MODEL) throw new Error(`${label}: model must be ${MODEL}.`);
  if (typeof profile.prompt !== 'string' || !profile.prompt.trim()) {
    throw new Error(`${label}: prompt must be a nonempty string.`);
  }
  if (!Array.isArray(profile.keywords) || !profile.keywords.length || profile.keywords.some(
    keyword => typeof keyword !== 'string' || !keyword.trim() || /[<>\r\n]/u.test(keyword),
  )) throw new Error(`${label}: keywords must be nonempty single-line strings without < or >.`);
  if (!Array.isArray(profile.languages) || !profile.languages.length || profile.languages.some(
    language => language !== 'en' && language !== 'vi',
  ) || (expectedLanguage && !profile.languages.includes(expectedLanguage))) {
    throw new Error(`${label}: languages must contain the expected source language and only en or vi.`);
  }
  if (!DELAYS.includes(profile.delay)) {
    throw new Error(`${label}: delay must be one of ${DELAYS.join(', ')}.`);
  }
  return {
    model: MODEL, prompt: profile.prompt, keywords: [...profile.keywords],
    languages: [...profile.languages], delay: profile.delay,
  };
}

export function loadConferenceGlossary(directory = ROOT) {
  const csvFile = 'IFR2026_glossary_EN-VI.csv';
  const rows = parseCsv(readFileSync(join(directory, csvFile), 'utf8'));
  const header = rows.shift();
  if (!header || header.length !== COLUMNS.length || new Set(header).size !== COLUMNS.length
    || COLUMNS.some(column => !header.includes(column))) {
    throw new Error(`${csvFile}: expected the five columns ${COLUMNS.join(',')}.`);
  }
  const entries = rows.map((row, index) => {
    if (row.length !== header.length) throw new Error(`${csvFile}: record ${index + 2} must have five fields.`);
    const entry = Object.fromEntries(header.map((column, i) => [column, row[i]]));
    if (!entry.english.trim() || !entry.vietnamese.trim()) {
      throw new Error(`${csvFile}: record ${index + 2} has an empty English or Vietnamese term.`);
    }
    return entry;
  });
  if (!entries.length) throw new Error(`${csvFile}: no glossary entries.`);

  const profiles = {};
  for (const language of ['en', 'vi']) {
    const file = `gpt-live-transcribe_${language.toUpperCase()}_session.json`;
    let data;
    try { data = JSON.parse(readFileSync(join(directory, file), 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { throw new Error(`${file}: ${error.message}`, { cause: error }); }
    profiles[language] = validateProfile(data?.session?.audio?.input?.transcription, file, language);
  }
  const abbreviations = new Map();
  for (const { abbreviation, english, vietnamese } of entries) {
    if (!abbreviation.trim()) continue;
    const key = abbreviation.trim().toLowerCase();
    const group = abbreviations.get(key) || { abbreviation, meanings: [] };
    group.meanings.push({ english, vietnamese });
    abbreviations.set(key, group);
  }
  return {
    entries, profiles,
    metadata: {
      entries: entries.length, keywordsEn: profiles.en.keywords.length, keywordsVi: profiles.vi.keywords.length,
      ambiguousAbbreviations: [...abbreviations.values()].filter(group => new Set(
        group.meanings.map(meaning => meaning.english.toLowerCase()),
      ).size > 1),
    },
  };
}

export function transcriptionProfile(targetLanguage, profiles) {
  if (targetLanguage !== 'en' && targetLanguage !== 'vi') throw new RangeError('Target language must be en or vi.');
  const sourceLanguage = targetLanguage === 'vi' ? 'en' : 'vi';
  const profile = validateProfile(profiles?.[sourceLanguage], `Profile ${sourceLanguage}`, sourceLanguage);
  // Keep the original conference files for reference; their contextual prose can
  // bias recognition toward names, dates, or topics that were never spoken.
  // This request applies only to source captions, not to translated audio.
  profile.prompt = AUDIBLE_WORDS_ONLY;
  return profile;
}
