import assert from 'node:assert/strict';
import test from 'node:test';
import { CaptionModel } from '../public/caption-model.js';

test('independent streaming captions retain partial words and repeated elapsed timestamps verbatim', () => {
  const model = new CaptionModel();
  const update = (type, delta) => model.update({ type, delta, itemId: 'stream:0', targetLanguage: 'vi', elapsedMs: 800 });
  update('target_delta', 'Điều');
  update('source_delta', 'The treat');
  update('target_delta', ' trị');
  update('source_delta', 'ment');
  update('target_delta', ' hiệu quả.');
  update('source_delta', ' is effective.');
  assert.equal(model.liveText('en'), 'The treatment is effective.');
  assert.equal(model.liveText('vi'), 'Điều trị hiệu quả.');
  assert.equal(model.history.length, 1);
});

test('switching translation language preserves previous captions and restarting preserves history', () => {
  const model = new CaptionModel();
  model.update({ type: 'source_delta', delta: 'The result is uncertain.', itemId: 'stream:0', targetLanguage: 'vi' });
  model.update({ type: 'target_delta', delta: 'Kết quả chưa chắc chắn.', itemId: 'stream:0', targetLanguage: 'vi' });
  model.update({ type: 'source_delta', delta: 'Chúng tôi chưa biết.', itemId: 'stream:1', targetLanguage: 'en' });
  model.update({ type: 'target_delta', delta: 'We do not know yet.', itemId: 'stream:1', targetLanguage: 'en' });
  assert.equal(model.liveText('en'), 'We do not know yet.\nThe result is uncertain.');
  assert.equal(model.liveText('vi'), 'Chúng tôi chưa biết.\nKết quả chưa chắc chắn.');
  model.reset();
  assert.equal(model.liveText('vi'), '');
  model.update({ type: 'target_delta', delta: 'Phiên mới.', itemId: 'new-stream:0', targetLanguage: 'vi' });
  assert.equal(model.liveText('vi'), 'Phiên mới.');
  const text = model.downloadText();
  assert.ok(text.includes('We do not know yet.'));
  assert.ok(text.includes('Phiên mới.'));
  assert.equal(model.history.length, 3);
});

test('live rendering is bounded while export retains the complete continuous transcript', () => {
  const model = new CaptionModel();
  const source = 'The conference results remain uncertain. '.repeat(500);
  model.update({ type: 'source_delta', delta: source, itemId: 'stream:0', targetLanguage: 'vi' });
  assert.ok(model.liveText('en').length <= 12000);
  assert.ok(model.liveText('en').length > 11000);
  assert.ok(model.downloadText().includes(source));
});

test('final source text replaces partial text by item ID even when finals arrive out of order', () => {
  const model = new CaptionModel();
  model.update({ type: 'source_turn', itemId: 'source:a', targetLanguage: 'vi' });
  model.update({ type: 'source_delta', itemId: 'source:a', delta: 'Treatment includes metho', targetLanguage: 'vi' });
  model.update({ type: 'source_turn', itemId: 'source:b', previousItemId: 'source:a', targetLanguage: 'vi' });
  model.update({ type: 'source_delta', itemId: 'source:b', delta: 'The dose is ', targetLanguage: 'vi' });
  model.update({ type: 'target_delta', itemId: 'translation:0', delta: 'Điều trị bao gồm methotrexate.', targetLanguage: 'vi' });
  model.update({ type: 'source_transcript', itemId: 'source:b', text: 'The dose is five milligrams.', targetLanguage: 'vi' });
  model.update({ type: 'source_transcript', itemId: 'source:a', text: 'Treatment includes methotrexate.', targetLanguage: 'vi' });
  assert.equal(model.liveText('en'), 'The dose is five milligrams.\nTreatment includes methotrexate.');
  assert.equal(model.liveText('vi'), 'Điều trị bao gồm methotrexate.');
  assert.equal(model.history.length, 3);
  assert.ok(!model.downloadText().includes('methomethotrexate'));
  model.reset();
  model.update({ type: 'source_transcript', itemId: 'source:new:a', text: 'DM', targetLanguage: 'vi' });
  assert.equal(model.liveText('en'), 'DM');
});

test('source predecessor links repair a later partial arriving before the first source item', () => {
  const model = new CaptionModel();
  model.update({ type: 'source_delta', itemId: 'source:b', delta: 'Second part', targetLanguage: 'vi' });
  model.update({ type: 'target_delta', itemId: 'translation:0', delta: 'Bản dịch riêng.', targetLanguage: 'vi' });
  const targetRow = model.byId.get('translation:0');
  const before = model.historyOrderVersion;
  model.update({ type: 'source_turn', itemId: 'source:b', previousItemId: 'source:a', targetLanguage: 'vi' });
  assert.equal(model.byId.get('source:a').source, '', 'An unknown predecessor is a placeholder, not generated transcript');
  assert.equal(model.historyOrderVersion, before + 1);
  model.update({ type: 'source_transcript', itemId: 'source:a', text: 'First part.', targetLanguage: 'vi' });
  model.update({ type: 'source_transcript', itemId: 'source:b', text: 'Second part.', targetLanguage: 'vi' });
  assert.equal(model.liveText('en'), 'Second part.\nFirst part.');
  assert.equal(model.liveText('vi'), 'Bản dịch riêng.');
  assert.equal(model.turns[1], targetRow, 'An independent translated stream retains its own row and position');
  assert.equal(model.history[1], targetRow);
  assert.ok(model.downloadText().indexOf('First part.') < model.downloadText().indexOf('Second part.'));
  assert.equal(model.historyOrderVersion, before + 1, 'Text replacements do not count as reordering');
});

test('late predecessor chains order A, B and C even when C and its final arrive first', () => {
  const model = new CaptionModel();
  model.update({ type: 'source_delta', itemId: 'source:c', delta: 'Third provisional', targetLanguage: 'vi' });
  model.update({ type: 'source_turn', itemId: 'source:c', previousItemId: 'source:b', targetLanguage: 'vi' });
  model.update({ type: 'source_transcript', itemId: 'source:c', text: 'Third.', targetLanguage: 'vi' });
  model.update({ type: 'source_turn', itemId: 'source:b', previousItemId: 'source:a', targetLanguage: 'vi' });
  model.update({ type: 'source_transcript', itemId: 'source:b', text: 'Second.', targetLanguage: 'vi' });
  model.update({ type: 'source_turn', itemId: 'source:a', previousItemId: null, targetLanguage: 'vi' });
  model.update({ type: 'source_transcript', itemId: 'source:a', text: 'First.', targetLanguage: 'vi' });
  assert.deepEqual(model.turns.map(turn => turn.id), ['source:a', 'source:b', 'source:c']);
  assert.equal(model.liveText('en'), 'Third.\nSecond.\nFirst.');
  assert.deepEqual(model.history, model.turns);
  assert.equal(model.history.length, 3);
});

test('source ordering after reset leaves historical sessions and target direction unchanged', () => {
  const model = new CaptionModel();
  model.update({ type: 'source_transcript', itemId: 'old:a', text: 'The previous conference.', targetLanguage: 'vi' });
  model.update({ type: 'target_delta', itemId: 'old:translation', delta: 'Hội nghị trước.', targetLanguage: 'vi' });
  const historicalRows = [...model.history];
  model.reset();
  const orderVersion = model.historyOrderVersion;
  model.update({ type: 'source_delta', itemId: 'new:b', delta: 'Câu thứ hai', targetLanguage: 'en' });
  model.update({ type: 'target_delta', itemId: 'new:translation', delta: 'Separate translation.', targetLanguage: 'en' });
  model.update({ type: 'source_turn', itemId: 'new:b', previousItemId: 'new:a', targetLanguage: 'en' });
  model.update({ type: 'source_transcript', itemId: 'new:a', text: 'Câu thứ nhất.', targetLanguage: 'en' });
  model.update({ type: 'source_transcript', itemId: 'new:b', text: 'Câu thứ hai.', targetLanguage: 'en' });
  assert.deepEqual(model.history.slice(0, 2), historicalRows);
  assert.equal(model.liveText('vi'), 'Câu thứ hai.\nCâu thứ nhất.');
  assert.equal(model.liveText('en'), 'Separate translation.');
  assert.ok(model.historyOrderVersion > orderVersion);
  const latestVersion = model.historyOrderVersion;
  model.reset();
  assert.equal(model.historyOrderVersion, latestVersion, 'Ordering version remains monotonic across sessions');
  model.update({ type: 'target_delta', itemId: 'next:translation', delta: 'Next conference.', targetLanguage: 'en' });
  assert.equal(model.historyOrderVersion, latestVersion, 'Appending a row does not reorder existing history');
});

test('cyclic source metadata preserves every row and transcript instead of losing caption text', () => {
  const model = new CaptionModel();
  model.update({ type: 'source_turn', itemId: 'source:a', previousItemId: 'source:b', targetLanguage: 'vi' });
  model.update({ type: 'source_transcript', itemId: 'source:a', text: 'First.', targetLanguage: 'vi' });
  model.update({ type: 'source_turn', itemId: 'source:b', previousItemId: 'source:a', targetLanguage: 'vi' });
  model.update({ type: 'source_transcript', itemId: 'source:b', text: 'Second.', targetLanguage: 'vi' });
  assert.equal(new Set(model.turns).size, 2);
  assert.ok(model.liveText('en').includes('First.'));
  assert.ok(model.liveText('en').includes('Second.'));
});

test('a continuous transcript shows its newest sentence first without reversing words or title abbreviations', () => {
  const model = new CaptionModel();
  model.update({ type: 'source_delta', itemId: 'stream:0', delta: 'Dr. Nguyen spoke. The dose is 2.5 mg. The treat', targetLanguage: 'vi' });
  assert.equal(model.liveText('en'), 'The treat\nThe dose is 2.5 mg.\nDr. Nguyen spoke.');
  model.update({ type: 'source_delta', itemId: 'stream:0', delta: 'ment is effective.', targetLanguage: 'vi' });
  assert.equal(model.liveText('en'), 'The treatment is effective.\nThe dose is 2.5 mg.\nDr. Nguyen spoke.');
  model.update({ type: 'target_delta', itemId: 'stream:0', delta: 'Bác sĩ Nguyễn trình bày. Liều dùng là 2,5 mg. Điều trị hiệu quả.', targetLanguage: 'vi' });
  assert.equal(model.liveText('vi'), 'Điều trị hiệu quả.\nLiều dùng là 2,5 mg.\nBác sĩ Nguyễn trình bày.');
  assert.equal(model.byId.get('stream:0').source, 'Dr. Nguyen spoke. The dose is 2.5 mg. The treatment is effective.');
  assert.ok(model.downloadText().includes('Dr. Nguyen spoke. The dose is 2.5 mg. The treatment is effective.'));
});

for (const [targetLanguage, initialTranslation, nextTranslation, sourceSentence] of [
  ['en', 'The treatment is effective.', 'We will present the results.', index => `Nội dung nguồn ${index}.`],
  ['vi', 'Điều trị có hiệu quả.', 'Chúng tôi trình bày kết quả.', index => `Source sentence ${index}.`],
]) {
  test(`continuous ${targetLanguage} translation remains visible while many independent source turns arrive`, () => {
    const model = new CaptionModel();
    const sourceLanguage = targetLanguage === 'en' ? 'vi' : 'en';
    model.update({ type: 'target_delta', itemId: 'translation:0', targetLanguage, delta: initialTranslation });
    const sourceTexts = Array.from({ length: 80 }, (_, index) => sourceSentence(index));
    for (const [index, text] of sourceTexts.entries()) {
      model.update({ type: 'source_turn', itemId: `source:${index}`, targetLanguage });
      model.update({ type: 'source_transcript', itemId: `source:${index}`, targetLanguage, text });
    }
    assert.equal(model.liveText(targetLanguage), initialTranslation, 'Source turns must not remove the independently streaming translation');
    model.update({ type: 'target_delta', itemId: 'translation:0', targetLanguage, delta: ` ${nextTranslation}` });
    assert.equal(model.liveText(targetLanguage), `${nextTranslation}\n${initialTranslation}`, 'Fresh translated sentences continue appearing newest first');
    assert.equal(model.liveText(sourceLanguage), sourceTexts.slice(-40).reverse().join('\n'), 'The source pane still shows its latest 40 populated turns');
    assert.equal(model.byId.get('translation:0').target, `${initialTranslation} ${nextTranslation}`);
    assert.deepEqual(model.history.filter(turn => turn.source).map(turn => turn.source), sourceTexts);
    const exported = model.downloadText();
    assert.ok(exported.includes(`${initialTranslation} ${nextTranslation}`));
    for (const text of sourceTexts) assert.ok(exported.includes(text));
    assert.ok(exported.indexOf(sourceTexts[0]) < exported.indexOf(sourceTexts.at(-1)), 'Export preserves chronological source text');
  });
}

for (const [targetLanguage, sourceText, unexpectedSource, initialTranslation, resumedTranslation] of [
  ['en', 'Chúng tôi trình bày kết quả.', 'We are speaking English from the microphone.', 'We present the results.', 'The translation continues'],
  ['vi', 'We present the results.', 'Chúng tôi đang nói tiếng Việt vào mic.', 'Chúng tôi trình bày kết quả.', 'Bản dịch tiếp tục'],
]) {
  test(`fixed ${targetLanguage} output resumes at the top after microphone speech in the target language`, () => {
    const model = new CaptionModel();
    const sourceLanguage = targetLanguage === 'en' ? 'vi' : 'en';
    model.update({ type: 'source_transcript', itemId: 'source:initial', targetLanguage, text: sourceText });
    model.update({ type: 'target_delta', itemId: 'translation:continuous', targetLanguage, delta: initialTranslation });
    const heldSourcePane = model.liveText(sourceLanguage);
    model.update({ type: 'source_transcript', itemId: 'source:unexpected', targetLanguage, text: unexpectedSource });
    assert.ok(model.liveText(targetLanguage).startsWith(unexpectedSource));
    assert.equal(model.liveText(sourceLanguage), heldSourcePane, 'Unexpected source language does not invent a reverse translation');
    model.update({ type: 'source_transcript', itemId: 'source:resumed', targetLanguage, text: sourceText });
    model.update({ type: 'target_delta', itemId: 'translation:continuous', targetLanguage, delta: ` ${resumedTranslation}` });
    assert.ok(model.liveText(targetLanguage).startsWith(resumedTranslation), 'Resumed translated partial must replace the stale source head immediately');
    model.update({ type: 'target_delta', itemId: 'translation:continuous', targetLanguage, delta: '.' });
    assert.ok(model.liveText(targetLanguage).startsWith(`${resumedTranslation}.`));
    assert.ok(model.liveText(targetLanguage).includes(unexpectedSource));
    assert.equal(model.byId.get('translation:continuous').target, `${initialTranslation} ${resumedTranslation}.`);
    assert.ok(model.history.every(turn => turn.targetLanguage === targetLanguage), 'Displayed input language never changes selected translation output');
    const exported = model.downloadText();
    assert.ok(exported.includes(unexpectedSource));
    assert.ok(exported.includes(`${initialTranslation} ${resumedTranslation}.`));
  });

  for (const [count, repetitions] of [[65, 1], [3, 160]]) {
    test(`resumed ${targetLanguage} translation survives ${count} same-language source rows and ${repetitions} repetitions per row`, () => {
      const model = new CaptionModel();
      model.update({ type: 'target_delta', itemId: 'translation:continuous', targetLanguage, delta: initialTranslation });
      const rows = [];
      for (let index = 0; index < count; index++) {
        const text = `${index} ${unexpectedSource} `.repeat(repetitions);
        rows.push(text);
        model.update({ type: 'source_turn', itemId: `source:${index}`, previousItemId: index ? `source:${index - 1}` : null, targetLanguage });
        model.update({ type: 'source_transcript', itemId: `source:${index}`, targetLanguage, text });
      }
      const originalOrder = [...model.history];
      const originalVersion = model.historyOrderVersion;
      model.update({ type: 'source_transcript', itemId: 'source:return', targetLanguage, text: sourceText });
      model.update({ type: 'target_delta', itemId: 'translation:continuous', targetLanguage, delta: ` ${resumedTranslation}.` });
      assert.ok(model.liveText(targetLanguage).startsWith(`${resumedTranslation}.`));
      assert.ok(model.liveText(targetLanguage).length <= 12000);
      assert.deepEqual(model.history.slice(0, originalOrder.length), originalOrder, 'Live priority never moves transcript rows');
      assert.equal(model.historyOrderVersion, originalVersion, 'New text changes live priority without changing history order');
      const exported = model.downloadText();
      assert.ok(exported.includes(`${initialTranslation} ${resumedTranslation}.`));
      for (const row of rows) assert.ok(exported.includes(row), 'History/export retain verbatim source captions beyond the live window');
    });
  }

  test(`same-item ${targetLanguage} source and translation follow independent text activity`, () => {
    const model = new CaptionModel();
    model.update({ type: 'source_delta', itemId: 'fallback:continuous', targetLanguage, delta: unexpectedSource });
    model.update({ type: 'target_delta', itemId: 'fallback:continuous', targetLanguage, delta: initialTranslation });
    assert.ok(model.liveText(targetLanguage).startsWith(initialTranslation));
    model.update({ type: 'source_delta', itemId: 'fallback:continuous', targetLanguage, delta: ` ${unexpectedSource}` });
    assert.ok(model.liveText(targetLanguage).startsWith(unexpectedSource), 'New source words remain visible even when the same item also contains target text');
    model.update({ type: 'target_delta', itemId: 'fallback:continuous', targetLanguage, delta: ` ${resumedTranslation}.` });
    assert.ok(model.liveText(targetLanguage).startsWith(`${resumedTranslation}.`));
    const turn = model.byId.get('fallback:continuous');
    assert.equal(turn.source, `${unexpectedSource} ${unexpectedSource}`);
    assert.equal(turn.target, `${initialTranslation} ${resumedTranslation}.`);
  });

  test(`late source corrections and whitespace do not hide fresh ${targetLanguage} translation`, () => {
    const model = new CaptionModel();
    model.update({ type: 'source_turn', itemId: 'source:later', previousItemId: 'source:earlier', targetLanguage });
    model.update({ type: 'source_delta', itemId: 'source:later', targetLanguage, delta: unexpectedSource });
    model.update({ type: 'source_transcript', itemId: 'source:earlier', targetLanguage, text: unexpectedSource });
    model.update({ type: 'target_delta', itemId: 'translation:continuous', targetLanguage, delta: `${resumedTranslation}.` });
    model.update({ type: 'source_transcript', itemId: 'source:later', targetLanguage, text: `1 ${unexpectedSource}` });
    model.update({ type: 'source_transcript', itemId: 'source:earlier', targetLanguage, text: `2 ${unexpectedSource}` });
    model.update({ type: 'source_delta', itemId: 'source:later', targetLanguage, delta: ' \t ' });
    assert.ok(model.liveText(targetLanguage).startsWith(`${resumedTranslation}.`));
    assert.deepEqual(model.turns.filter(turn => turn.isSource).map(turn => turn.id), ['source:earlier', 'source:later']);
    assert.ok(model.downloadText().indexOf(`2 ${unexpectedSource}`) < model.downloadText().indexOf(`1 ${unexpectedSource}`));
  });
}
