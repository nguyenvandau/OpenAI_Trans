import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const COLUMNS = ['category', 'english', 'vietnamese', 'abbreviation', 'note'];
const EXTRA_COLUMNS = ['source', 'pair_type'];
const SUPPLEMENT_FILE = 'IFR2026_glossary_EN-VI_supplement.csv';
const MODEL = 'gpt-live-transcribe';
const DELAYS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const AUDIBLE_WORDS_ONLY = 'Transcribe only words audible in the recording. Context and keywords are spelling hints, not required output. Do not add or guess words, expand abbreviations, translate, answer questions, or supply information that was not spoken.';

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

function readEntries(directory, csvFile) {
  const rows = parseCsv(readFileSync(join(directory, csvFile), 'utf8'));
  const header = rows.shift();
  if (!header || new Set(header).size !== header.length
    || COLUMNS.some(column => !header.includes(column))
    || header.some(column => ![...COLUMNS, ...EXTRA_COLUMNS].includes(column))) {
    throw new Error(`${csvFile}: expected the five columns ${COLUMNS.join(',')}; optional columns: ${EXTRA_COLUMNS.join(',')}.`);
  }
  const entries = rows.map((row, index) => {
    if (row.length !== header.length) throw new Error(`${csvFile}: record ${index + 2} must have ${header.length} fields.`);
    const entry = Object.fromEntries(header.map((column, i) => [column, row[i]]));
    if (!entry.english.trim() || !entry.vietnamese.trim()) {
      throw new Error(`${csvFile}: record ${index + 2} has an empty English or Vietnamese term.`);
    }
    return entry;
  });
  if (!entries.length) throw new Error(`${csvFile}: no glossary entries.`);
  return entries;
}

function readProfile(directory, language, suffix) {
  const file = `gpt-live-transcribe_${language.toUpperCase()}_session${suffix}.json`;
  let data;
  try { data = JSON.parse(readFileSync(join(directory, file), 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`${file}: ${error.message}`, { cause: error }); }
  return validateProfile(data?.session?.audio?.input?.transcription, file, language);
}

const normalized = value => value.normalize('NFC').trim();
function appendUniqueKeywords(profile, keywords) {
  const seen = new Set(profile.keywords.map(keyword => normalized(keyword).toLowerCase()));
  for (const keyword of keywords) {
    const key = normalized(keyword).toLowerCase();
    if (!seen.has(key)) { seen.add(key); profile.keywords.push(keyword); }
  }
}

export function loadConferenceGlossary(directory = ROOT) {
  const versions = readdirSync(directory, { withFileTypes: true })
    .filter(file => file.isFile())
    .map(file => /^IFR2026_glossary_EN-VI(_v([1-9]\d*))\.csv$/u.exec(file.name))
    .filter(Boolean)
    .sort((left, right) => Number(left[2]) - Number(right[2]));
  const suffixes = ['', ...versions.map(match => match[1])];
  const entries = [], byTerm = new Map(), sourceFiles = [];
  let duplicateEntries = 0;
  function mergeEntries(file, rows = readEntries(directory, file)) {
    sourceFiles.push(file);
    for (const entry of rows) {
      // Notes and alternative meanings are part of a row's identity. Additional
      // source metadata enriches a matching older row instead of duplicating it.
      const key = JSON.stringify(COLUMNS.map(column => normalized(entry[column])));
      const candidates = byTerm.get(key) || [];
      const existing = candidates.find(candidate => EXTRA_COLUMNS.every(column =>
        !normalized(candidate[column] || '') || !normalized(entry[column] || '')
        || normalized(candidate[column]) === normalized(entry[column]),
      ));
      if (existing) {
        for (const column of EXTRA_COLUMNS) if (!normalized(existing[column] || '') && entry[column]) existing[column] = entry[column];
        duplicateEntries++;
      } else {
        candidates.push(entry);
        byTerm.set(key, candidates);
        entries.push(entry);
      }
    }
  }

  const profiles = {};
  for (const suffix of suffixes) {
    mergeEntries(`IFR2026_glossary_EN-VI${suffix}.csv`);
    for (const language of ['en', 'vi']) {
      const profile = readProfile(directory, language, suffix);
      if (!profiles[language]) {
        profiles[language] = { ...profile, keywords: [] };
      }
      // Keep the established model, context, language hints and latency setting.
      // New dictionaries only expand spelling hints; never concatenate prompts.
      appendUniqueKeywords(profiles[language], profile.keywords);
    }
  }
  let supplementEntries = 0;
  if (existsSync(join(directory, SUPPLEMENT_FILE))) {
    const supplements = readEntries(directory, SUPPLEMENT_FILE);
    const before = entries.length;
    mergeEntries(SUPPLEMENT_FILE, supplements);
    supplementEntries = entries.length - before;
    // These organization names exist only in the supplied XLSX sheets.
    // Include their literal names as hints without loading XLSX during capture.
    appendUniqueKeywords(profiles.en, supplements.map(entry => entry.english));
    appendUniqueKeywords(profiles.vi, supplements.map(entry => entry.vietnamese));
  }
  for (const language of ['en', 'vi']) {
    profiles[language] = validateProfile(profiles[language], `Merged profile ${language}`, language);
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
      bundles: suffixes.length, sourceFiles, duplicateEntries, supplementEntries,
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
  profile.prompt += `\n${AUDIBLE_WORDS_ONLY}`;
  return profile;
}
