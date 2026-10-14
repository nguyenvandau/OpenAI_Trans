import assert from 'node:assert/strict';
import test from 'node:test';
import { CaptionPager } from '../public/caption-pager.js';
import { CaptionModel } from '../public/caption-model.js';

const capacity = size => text => text.length <= size;
const glyphs = new Intl.Segmenter('und', {granularity: 'grapheme'});

test('a full page continues with the next whole word at the top', () => {
  const pager = new CaptionPager();
  const fit = capacity(13);
  assert.equal(pager.page('one two three', 'normal', fit).text, 'one two three');
  const next = pager.page('one two three four', 'normal', fit);
  assert.deepEqual(next.pages, ['one two three ', 'four']);
  assert.equal(next.pageNumber, 2);
  assert.equal(next.offset, 14);
  assert.ok(next.pages.every(page => fit(page.trimEnd())));
  assert.equal(next.pages.join(''), 'one two three four');
});

test('Vietnamese pages preserve accents, punctuation and inter-word whitespace verbatim', () => {
  const text = 'Chúng tôi  điều trị\tviêm khớp bằng thuốc phù hợp, theo dõi sát.';
  const page = new CaptionPager().page(text, 'vi', capacity(20));
  assert.equal(page.pages.join(''), text);
  assert.ok(page.pages.length > 1);
  assert.ok(page.pages.every(part => part.trimEnd().length <= 20));
  assert.ok(page.pages.slice(1).every(part => !/^\s/u.test(part)));
  for(let index = 0; index < page.pages.length - 1; index++){
    assert.match(page.pages[index], /\s$/u, 'Ordinary words end at whitespace, not inside a word');
  }
  assert.ok(page.text.endsWith('sát.'));
});

test('partial words can grow without being split between ordinary word pages', () => {
  const pager = new CaptionPager();
  const fit = capacity(12);
  assert.equal(pager.page('The methotre', 'room', fit).text, 'The methotre');
  const next = pager.page('The methotrexate', 'room', fit);
  assert.deepEqual(next.pages, ['The ', 'methotrexate']);
  assert.equal(next.pages.join(''), 'The methotrexate');
  const growing = pager.page('The methotrexate treatment', 'room', fit);
  assert.equal(growing.pages[0], 'The ', 'Completed page boundaries remain stable while words append');
  assert.equal(growing.text, 'treatment');
  assert.equal(growing.pages.join(''), 'The methotrexate treatment');
});

test('final ASR corrections and a new short sentence replace obsolete visual pages', () => {
  const pager = new CaptionPager();
  const fit = capacity(12);
  pager.page('The methotrexate', 'room', fit);
  const corrected = pager.page('The dose is five milligrams.', 'room', fit);
  assert.equal(corrected.pages.join(''), 'The dose is five milligrams.');
  assert.ok(corrected.pages.every(part => fit(part.trimEnd())));
  const newest = pager.page('Thank you.', 'room', fit);
  assert.deepEqual(newest.pages, ['Thank you.']);
  assert.equal(newest.offset, 0);
  assert.equal(newest.pageNumber, 1);
});

test('resize and font changes repaginate the same text for the new available space', () => {
  const pager = new CaptionPager();
  const text = 'Clinical response is monitored carefully';
  const narrow = pager.page(text, '390x600;font:0', capacity(12));
  assert.ok(narrow.pageNumber > 1);
  const wide = pager.page(text, '1366x768;font:0', capacity(60));
  assert.equal(wide.text, text);
  assert.equal(wide.pageNumber, 1);
  const newFont = pager.page(text, '1366x768;font:1', capacity(10));
  assert.ok(newFont.pageNumber > 1);
  assert.equal(newFont.pages.join(''), text);
  assert.ok(newFont.pages.every(part => part.trimEnd().length <= 10));
});

test('unchanged text and layout reuse the measured page without layout work', () => {
  const pager = new CaptionPager();
  let measured = 0;
  const fits = text => { measured++; return text.length <= 20; };
  const text = 'The conference includes clinical research and treatment outcomes';
  const result = pager.page(text, 'en', fits);
  assert.ok(measured > 0);
  measured = 0;
  assert.equal(pager.page(text, 'en', fits), result);
  assert.equal(measured, 0);
  pager.page(text + ' today', 'en', fits);
  assert.ok(measured > 0 && measured < 20, 'An append measures only its growing page, not prior completed pages');
});

test('long unbroken tokens split only between complete Unicode graphemes', () => {
  const text = ('👩‍⚕️e\u0301🇻🇳').repeat(9);
  const fit = value => Array.from(glyphs.segment(value)).length <= 4;
  const result = new CaptionPager().page(text, 'token', fit);
  assert.equal(result.pages.join(''), text);
  assert.ok(result.pages.length > 1);
  assert.ok(result.pages.every(fit));
  const ends = new Set(Array.from(glyphs.segment(text), ({index, segment}) => index + segment.length));
  let end = 0;
  for(const part of result.pages){
    end += part.length;
    assert.ok(ends.has(end), 'No page boundary cuts an emoji or combining accent');
  }
});

test('streamed combining marks and emoji suffixes stay within complete graphemes', () => {
  const pager = new CaptionPager();
  const fit = value => Array.from(glyphs.segment(value)).length <= 2;
  let text = 'AB';
  for(const delta of ['e', '\u0301', '👩', '\u200d', '⚕', '\ufe0f', 'C']){
    text += delta;
    const page = pager.page(text, 'stream', fit);
    assert.equal(page.pages.join(''), text);
    const ends = new Set(Array.from(glyphs.segment(text), ({index, segment}) => index + segment.length));
    let end = 0;
    for(const part of page.pages){ end += part.length; assert.ok(ends.has(end)); }
    assert.ok(page.pages.every(fit));
  }
});

test('trailing whitespace never becomes an extra empty visual page', () => {
  const pager = new CaptionPager();
  assert.equal(pager.page('one two', 'room', capacity(7)).pageNumber, 1);
  const page = pager.page('one two \t  ', 'room', capacity(7));
  assert.equal(page.pageNumber, 1);
  assert.equal(page.text, 'one two \t  ');
  assert.equal(page.pages.join(''), 'one two \t  ');
  const empty = pager.page('', 'room', capacity(7));
  assert.equal(empty.pageNumber, 1);
  assert.equal(empty.text, '');
});

test('display pages leave both source and translated history and export unchanged', () => {
  const model = new CaptionModel();
  const english = 'The conference reviews treatment response and adverse effects in detail';
  const vietnamese = 'Hội nghị xem xét đáp ứng điều trị và tác dụng bất lợi một cách chi tiết';
  model.update({type: 'source_transcript', text: english, itemId: 'source:1', targetLanguage: 'vi'});
  model.update({type: 'target_delta', delta: vietnamese, itemId: 'translation:1', targetLanguage: 'vi'});
  const originalExport = model.downloadText();
  const enPager = new CaptionPager();
  const viPager = new CaptionPager();
  const englishPage = enPager.page(model.liveText('en'), 'en', capacity(25));
  const vietnamesePage = viPager.page(model.liveText('vi'), 'vi', capacity(20));
  assert.equal(englishPage.pages.join(''), english);
  assert.equal(vietnamesePage.pages.join(''), vietnamese);
  assert.ok(englishPage.pageNumber > 1 && vietnamesePage.pageNumber > 1);
  assert.equal(model.downloadText(), originalExport);
  assert.equal(model.liveText('en'), english);
  assert.equal(model.liveText('vi'), vietnamese);
  enPager.reset();
  assert.equal(enPager.page('New session', 'en', capacity(25)).pageNumber, 1);
  assert.equal(viPager.page(model.liveText('vi'), 'vi', capacity(20)), vietnamesePage,
    'Resetting one visual pager does not affect the other language');
});
