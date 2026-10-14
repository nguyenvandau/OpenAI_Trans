import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadConferenceGlossary, parseCsv, transcriptionProfile } from '../conference-glossary.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CSV = 'IFR2026_glossary_EN-VI.csv';
const EN = 'gpt-live-transcribe_EN_session.json';
const VI = 'gpt-live-transcribe_VI_session.json';
const SUPPLEMENT = 'IFR2026_glossary_EN-VI_supplement.csv';
const COLUMNS = ['category', 'english', 'vietnamese', 'abbreviation', 'note'];

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cabin-glossary-test-'));
  for (const file of [CSV, EN, VI]) copyFileSync(join(ROOT, file), join(directory, file));
  t.after(() => {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('cabin-glossary-test-'));
    rmSync(target, { recursive: true, force: true });
  });
  return directory;
}

function editProfile(directory, update, file = EN) {
  const path = join(directory, file);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  update(data.session.audio.input.transcription, data);
  writeFileSync(path, JSON.stringify(data), 'utf8');
}

function readEntries(directory) {
  const [header, ...rows] = parseCsv(readFileSync(join(directory, CSV), 'utf8'));
  return rows.map(row => Object.fromEntries(header.map((column, index) => [column, row[index]])));
}

function writeCsv(directory, file, entries, columns = COLUMNS) {
  const field = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = [columns, ...entries.map(entry => columns.map(column => entry[column]))];
  writeFileSync(join(directory, file), lines.map(row => row.map(field).join(',')).join('\n') + '\n', 'utf8');
}

function writeBundle(directory, suffix, entries, options = {}) {
  writeCsv(directory, `IFR2026_glossary_EN-VI${suffix}.csv`, entries, options.columns);
  for (const [language, base] of [['en', EN], ['vi', VI]]) {
    const data = JSON.parse(readFileSync(join(directory, base), 'utf8'));
    Object.assign(data.session.audio.input.transcription, options[language]);
    writeFileSync(join(directory, base.replace('.json', `${suffix}.json`)), JSON.stringify(data), 'utf8');
  }
}

function term(english, vietnamese, additional = {}) {
  return { category: 'Thuật ngữ', english, vietnamese, abbreviation: '', note: '', ...additional };
}

test('CSV parser preserves Vietnamese, commas, multiline notes, escaped quotes and empty fields', () => {
  const csv = '\uFEFFcategory,english,vietnamese,abbreviation,note\r\n'
    + 'Diễn giả,"Nguyen, MD","Nguyễn, TS.BS.",,"said ""hello""\r\nsecond line"\r\n'
    + 'Bệnh,polyarthritis / oligoarthritis,thể đa khớp / thể ít khớp,,\n';
  assert.deepEqual(parseCsv(csv), [
    ['category', 'english', 'vietnamese', 'abbreviation', 'note'],
    ['Diễn giả', 'Nguyen, MD', 'Nguyễn, TS.BS.', '', 'said "hello"\r\nsecond line'],
    ['Bệnh', 'polyarthritis / oligoarthritis', 'thể đa khớp / thể ít khớp', '', ''],
  ]);
  assert.deepEqual(parseCsv('""'), [['']]);
  assert.deepEqual(parseCsv('a,b,'), [['a', 'b', '']]);
  assert.throws(() => parseCsv('a,"unfinished'), /Unclosed/);
  assert.throws(() => parseCsv('a,"closed"extra'), /closing quote/);
  assert.throws(() => parseCsv('a,invalid"quote'), /Invalid CSV quote/);
});

test('all uploaded bundles and XLSX-only names merge without losing meanings or source metadata', () => {
  const { entries, profiles, metadata } = loadConferenceGlossary();
  assert.equal(entries.length, 959);
  assert.deepEqual([metadata.entries, metadata.keywordsEn, metadata.keywordsVi], [959, 340, 290]);
  assert.equal(metadata.bundles, 4);
  assert.equal(metadata.duplicateEntries, 1938);
  assert.equal(metadata.supplementEntries, 4);
  assert.deepEqual(metadata.sourceFiles, [CSV,
    'IFR2026_glossary_EN-VI_v2.csv', 'IFR2026_glossary_EN-VI_v3.csv', 'IFR2026_glossary_EN-VI_v4.csv', SUPPLEMENT]);
  assert.equal(entries.filter(entry => entry.category === 'Diễn giả').length, 72);
  assert.equal(entries.filter(entry => entry.category === 'Đơn vị').length, 22);
  assert.equal(entries.filter(entry => entry.category !== 'Diễn giả' && entry.category !== 'Đơn vị').length, 865);
  assert.equal(entries.find(entry => entry.english === 'muscle strength / muscle mass').vietnamese, 'sức mạnh cơ / khối lượng cơ');
  assert.equal(entries.find(entry => entry.english === 'rheumatoid arthritis').note, 'VI viết tắt: VKDT');
  assert.equal(entries.find(entry => entry.english === 'Prof. Lai-Shan Tam').vietnamese, 'GS. Lai-Shan Tam');
  assert.deepEqual(metadata.ambiguousAbbreviations.map(group => group.abbreviation), ['DM', 'T2T', 'csDMARDs', 'DN4', 'IBP', 'APS']);
  assert.deepEqual(metadata.ambiguousAbbreviations.find(group => group.abbreviation === 'DM'), {
    abbreviation: 'DM', meanings: [
      { english: 'dermatomyositis', vietnamese: 'viêm da cơ' },
      { english: 'diabetes mellitus', vietnamese: 'đái tháo đường' },
    ],
  });
  assert.ok(profiles.vi.keywords.includes('Nguyễn Văn Hùng'));
  assert.ok(profiles.en.keywords.includes('Sjögren'));
  assert.ok(entries.some(entry => entry.source && entry.pair_type));
});

test('a deployment containing only the original bundle remains compatible', t => {
  const directory = fixture(t);
  const { entries, profiles, metadata } = loadConferenceGlossary(directory);
  assert.equal(entries.length, 475);
  assert.deepEqual([metadata.entries, metadata.keywordsEn, metadata.keywordsVi], [475, 166, 133]);
  assert.equal(profiles.en.keywords.length, 166);
  assert.equal(profiles.vi.keywords.length, 133);
  assert.equal(metadata.bundles, 1);
  assert.equal(metadata.duplicateEntries, 0);
  assert.equal(metadata.supplementEntries, 0);
  assert.deepEqual(metadata.sourceFiles, [CSV]);
});

test('direction selects source keywords and returned arrays cannot mutate the conference profiles', () => {
  const { profiles } = loadConferenceGlossary();
  const originalPrompt = profiles.en.prompt;
  const english = transcriptionProfile('vi', profiles);
  const vietnamese = transcriptionProfile('en', profiles);
  assert.deepEqual(english.languages, ['en']);
  assert.deepEqual(vietnamese.languages, ['vi', 'en']);
  assert.ok(english.prompt.startsWith(`${originalPrompt}\n`));
  assert.match(english.prompt, /only words audible/);
  assert.match(english.prompt, /hints, not required output/);
  assert.match(english.prompt, /Do not add or guess words/);
  english.keywords.push('added by a consumer');
  english.languages.push('vi');
  assert.equal(profiles.en.keywords.length, 340);
  assert.deepEqual(profiles.en.languages, ['en']);
  assert.equal(profiles.en.prompt, originalPrompt);
  assert.throws(() => transcriptionProfile('auto', profiles), RangeError);
});

test('untrusted session fields are discarded and strings remain inert data', t => {
  const directory = fixture(t);
  const inert = 'globalThis.__glossaryExecuted = true;';
  editProfile(directory, (profile, data) => {
    profile.keywords.push(inert);
    profile.unexpected = { code: inert };
    data.session.instructions = inert;
    data.session.tools = [{ type: 'function', name: 'execute' }];
    data.session.audio.output = { voice: 'marin' };
  });
  const { profiles } = loadConferenceGlossary(directory);
  const profile = transcriptionProfile('vi', profiles);
  assert.deepEqual(Object.keys(profile), ['model', 'prompt', 'keywords', 'languages', 'delay']);
  assert.ok(profile.keywords.includes(inert));
  assert.equal(globalThis.__glossaryExecuted, undefined);
  assert.equal(profile.instructions, undefined);
  assert.equal(profile.tools, undefined);
});

test('malformed keywords, unsupported models and wrong source languages are rejected before API calls', t => {
  const directory = fixture(t);
  const original = readFileSync(join(ROOT, EN), 'utf8');
  const invalid = [
    profile => { profile.keywords = ['unsafe\nkeyword']; },
    profile => { profile.keywords = ['unsafe\rkeyword']; },
    profile => { profile.keywords = ['<tag>']; },
    profile => { profile.keywords = [5]; },
    profile => { profile.keywords = ['   ']; },
    profile => { profile.model = 'gpt-realtime-translate'; },
    profile => { profile.languages = ['fr']; },
    profile => { profile.languages = ['vi']; },
    profile => { profile.prompt = 1; },
    profile => { profile.delay = null; },
    profile => { profile.delay = 'fast'; },
  ];
  for (const update of invalid) {
    writeFileSync(join(directory, EN), original, 'utf8');
    editProfile(directory, update);
    assert.throws(() => loadConferenceGlossary(directory), /gpt-live-transcribe_EN_session\.json:/);
  }
});

test('documented transcription delay values are accepted without changing the supplied setting', () => {
  const { profiles } = loadConferenceGlossary();
  for (const delay of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
    profiles.en.delay = delay;
    assert.equal(transcriptionProfile('vi', profiles).delay, delay);
  }
});

test('CSV schema and incomplete bilingual records are rejected without dropping data', t => {
  const directory = fixture(t);
  for (const csv of [
    'english,vietnamese\nhello,xin chào\n',
    'category,english,vietnamese,abbreviation,english\nBệnh,test,thử,,note\n',
    'category,english,vietnamese,abbreviation,note\nBệnh,test,,DM,note\n',
    'category,english,vietnamese,abbreviation,note\nBệnh,test,thử,DM\n',
  ]) {
    writeFileSync(join(directory, CSV), csv, 'utf8');
    assert.throws(() => loadConferenceGlossary(directory), /IFR2026_glossary_EN-VI\.csv:/);
  }
});

test('cumulative snapshots merge once and a later noncumulative bundle keeps earlier additions', t => {
  const directory = fixture(t);
  const base = readEntries(directory);
  const first = term('first addition', 'thuật ngữ mới thứ nhất');
  const second = term('second addition', 'thuật ngữ mới thứ hai');
  const third = term('third addition', 'thuật ngữ mới thứ ba');
  writeBundle(directory, '_v2', [...base, first]);
  writeBundle(directory, '_v3', [...base, first, second]);
  writeBundle(directory, '_v4', [third]);
  const originals = new Map([CSV, EN, VI, 'IFR2026_glossary_EN-VI_v2.csv',
    'gpt-live-transcribe_EN_session_v2.json', 'gpt-live-transcribe_VI_session_v2.json']
    .map(file => [file, readFileSync(join(directory, file), 'utf8')]));
  const { entries, metadata } = loadConferenceGlossary(directory);
  assert.equal(entries.length, 478);
  assert.equal(metadata.bundles, 4);
  assert.equal(metadata.duplicateEntries, 951);
  assert.deepEqual(entries.slice(-3), [first, second, third]);
  for (const [file, contents] of originals) assert.equal(readFileSync(join(directory, file), 'utf8'), contents);
});

test('numeric bundle order and normalized keyword union preserve base settings and first spelling', t => {
  const directory = fixture(t);
  const base = loadConferenceGlossary(directory).profiles;
  // Create v10 first so both directory order and lexical order differ from numeric order.
  writeBundle(directory, '_v10', [term('tenth entry', 'thuật ngữ thứ mười')], {
    en: { prompt: 'A different later conference context.', keywords: ['Numeric tenth', 'Cafe\u0301', 'RHEUMATOLOGY'], languages: ['en', 'vi'], delay: 'xhigh' },
    vi: { prompt: 'Ngữ cảnh hội nghị khác.', keywords: ['Thứ mười', 'hà nội'.normalize('NFD')], languages: ['vi'], delay: 'high' },
  });
  writeBundle(directory, '_v2', [term('second entry', 'thuật ngữ thứ hai')], {
    en: { keywords: ['Numeric second', 'Café', 'rheumatology'], delay: 'low' },
    vi: { keywords: ['Thứ hai', 'hà nội'], delay: 'minimal' },
  });
  const { entries, profiles, metadata } = loadConferenceGlossary(directory);
  assert.deepEqual(entries.slice(-2).map(entry => entry.english), ['second entry', 'tenth entry']);
  assert.deepEqual(metadata.sourceFiles, [CSV, 'IFR2026_glossary_EN-VI_v2.csv', 'IFR2026_glossary_EN-VI_v10.csv']);
  assert.deepEqual(profiles.en.keywords.slice(base.en.keywords.length), ['Numeric second', 'Café', 'Numeric tenth']);
  assert.deepEqual(profiles.vi.keywords.slice(base.vi.keywords.length), ['Thứ hai', 'hà nội', 'Thứ mười']);
  for (const language of ['en', 'vi']) {
    for (const setting of ['model', 'prompt', 'languages', 'delay']) {
      assert.deepEqual(profiles[language][setting], base[language][setting]);
    }
  }
});

test('duplicate rows gain provenance while different notes, meanings and provenance remain distinct', t => {
  const directory = fixture(t);
  const original = term('trial concept', 'khái niệm thử', { abbreviation: 'TC', note: 'Original note' });
  writeCsv(directory, CSV, [...readEntries(directory), original]);
  const enriched = { ...original, source: 'Reference A', pair_type: 'reviewed' };
  const differentNote = { ...enriched, note: 'A distinct qualification' };
  const differentMeaning = { ...enriched, vietnamese: 'nghĩa khác' };
  const differentSource = { ...enriched, source: 'Reference B' };
  const differentPair = { ...enriched, pair_type: 'alternative' };
  writeBundle(directory, '_v2', [enriched, differentNote, differentMeaning, differentSource, differentPair],
    { columns: [...COLUMNS, 'source', 'pair_type'] });
  const { entries, metadata } = loadConferenceGlossary(directory);
  assert.equal(entries.length, 480);
  assert.equal(metadata.duplicateEntries, 1);
  assert.deepEqual(entries.filter(entry => entry.english === 'trial concept'),
    [enriched, differentNote, differentMeaning, differentSource, differentPair]);
});

test('every supplemental JSON profile is validated before merging even when base settings would win', t => {
  const directory = fixture(t);
  writeBundle(directory, '_v2', [term('safe term', 'thuật ngữ an toàn')]);
  const supplemental = 'gpt-live-transcribe_EN_session_v2.json';
  const original = readFileSync(join(directory, supplemental), 'utf8');
  for (const update of [
    profile => { profile.keywords = ['bad\nkeyword']; },
    profile => { profile.model = 'gpt-realtime-translate'; },
    profile => { profile.languages = ['vi']; },
    profile => { profile.prompt = ''; },
    profile => { profile.delay = 'fast'; },
  ]) {
    writeFileSync(join(directory, supplemental), original, 'utf8');
    editProfile(directory, update, supplemental);
    assert.throws(() => loadConferenceGlossary(directory), /gpt-live-transcribe_EN_session_v2\.json:/);
  }
  writeFileSync(join(directory, supplemental), original, 'utf8');
  writeFileSync(join(directory, supplemental), '{broken', 'utf8');
  assert.throws(() => loadConferenceGlossary(directory), /gpt-live-transcribe_EN_session_v2\.json:/);
});

test('XLSX organization supplements preserve provenance and add only missing spelling hints', t => {
  const directory = fixture(t);
  const base = loadConferenceGlossary(directory).profiles;
  const name = term('Café Research Society', 'Hội nghiên cứu Hà Nội', {
    category: 'Đơn vị', source: 'IFR2026_Thuat_ngu_Anh-Viet_v2.xlsx:Organizations', pair_type: 'organization',
  });
  const alternate = { ...name, source: 'IFR2026_Thuat_ngu_Anh-Viet_v3.xlsx:Organizations' };
  const existingHints = term('RHEUMATOLOGY', 'VIÊM KHỚP DẠNG THẤP', { category: 'Đơn vị' });
  writeCsv(directory, SUPPLEMENT, [name, name, alternate, existingHints], [...COLUMNS, 'source', 'pair_type']);
  const { entries, profiles, metadata } = loadConferenceGlossary(directory);
  assert.equal(entries.length, 478);
  assert.equal(metadata.supplementEntries, 3);
  assert.equal(metadata.duplicateEntries, 1);
  assert.deepEqual(entries.slice(-3), [name, alternate, { ...existingHints, source: '', pair_type: '' }]);
  assert.deepEqual(profiles.en.keywords.slice(base.en.keywords.length), ['Café Research Society']);
  assert.deepEqual(profiles.vi.keywords.slice(base.vi.keywords.length), ['Hội nghiên cứu Hà Nội']);
  assert.deepEqual(metadata.sourceFiles, [CSV, SUPPLEMENT]);

  // A later CSV may incorporate every XLSX organization without adding it to
  // the supplied keyword profiles. Overlap must not remove its spelling hint.
  writeCsv(directory, CSV, entries, [...COLUMNS, 'source', 'pair_type']);
  const overlapping = loadConferenceGlossary(directory);
  assert.equal(overlapping.entries.length, 478);
  assert.equal(overlapping.metadata.supplementEntries, 0);
  assert.equal(overlapping.metadata.duplicateEntries, 4);
  assert.deepEqual(overlapping.entries.slice(-3), entries.slice(-3));
  assert.deepEqual(overlapping.profiles.en.keywords.slice(base.en.keywords.length), ['Café Research Society']);
  assert.deepEqual(overlapping.profiles.vi.keywords.slice(base.vi.keywords.length), ['Hội nghiên cứu Hà Nội']);
});

test('supplement names cannot introduce unsafe API keyword content', t => {
  const directory = fixture(t);
  writeCsv(directory, SUPPLEMENT, [term('Organization <unsafe>', 'Đơn vị')]);
  assert.throws(() => loadConferenceGlossary(directory), /keywords|single-line/);
});
