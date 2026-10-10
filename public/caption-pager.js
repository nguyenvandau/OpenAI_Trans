const graphemes = new Intl.Segmenter('und', {granularity: 'grapheme'});

function boundaryAfter(boundaries, offset){
  let low = 0, high = boundaries.length;
  while(low < high){
    const middle = Math.floor((low + high) / 2);
    if(boundaries[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function longestFittingBoundary(text, start, boundaries, fits, first = 0, last = boundaries.length - 1){
  if(first > last) return null;
  let probe = first, stride = 1, best = first - 1;
  // Find a nearby failing candidate before binary search. Large incoming
  // transcripts must not force layout of thousands of lines for every page.
  while(fits(text.slice(start, boundaries[probe]).trimEnd())){
    best = probe;
    if(probe === last) return boundaries[best];
    probe = Math.min(last, first + stride);
    stride *= 2;
  }
  if(best < first) return null;
  let low = best + 1, high = probe - 1;
  while(low <= high){
    const middle = Math.floor((low + high) / 2);
    const end = boundaries[middle];
    if(fits(text.slice(start, end).trimEnd())){
      best = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return boundaries[best];
}

function nextPageEnd(text, start, fits, words, glyphBoundaries){
  const firstWord = boundaryAfter(words, start);
  const wordEnd = longestFittingBoundary(text, start, words, fits, firstWord);
  if(wordEnd !== null) return wordEnd;

  // A single exceptionally long token (e.g. a URL) can exceed a whole window.
  // Split it only between grapheme clusters, never through an accent or emoji.
  const firstWordEnd = words[firstWord] ?? text.length;
  const glyphs = glyphBoundaries();
  const first = boundaryAfter(glyphs, start);
  const last = boundaryAfter(glyphs, firstWordEnd) - 1;
  return longestFittingBoundary(text, start, glyphs, fits, first, last) ?? glyphs[first] ?? text.length;
}

// Visual pages are separate from the transcript. The caller measures a slice
// with the actual caption font, wrapping width and available viewport height.
export class CaptionPager {
  constructor(){ this.reset(); }

  reset(){
    this.previousText = '';
    this.layout = null;
    this.pageStarts = [0];
    this.result = null;
  }

  page(text, layout, fits){
    if(text === this.previousText && layout === this.layout && this.result) return this.result;
    const continuing = layout === this.layout && text.startsWith(this.previousText);
    const starts = continuing ? this.pageStarts.slice() : [0];
    let start = starts.at(-1);
    // Only the growing page needs measuring when new words append. Completed
    // page boundaries remain stable until a correction or layout change.
    if(start < text.length && !fits(text.slice(start).trimEnd())){
      // Attach inter-word whitespace to the preceding page, so the next page
      // starts with the next word while conserving every original character.
      const words = Array.from(text.matchAll(/\S+\s*/gu), match => match.index + match[0].length);
      let glyphs;
      const glyphBoundaries = ()=> glyphs ??= Array.from(graphemes.segment(text),
        ({index, segment}) => index + segment.length);
      while(start < text.length){
        const end = nextPageEnd(text, start, fits, words, glyphBoundaries);
        if(end <= start || end >= text.length) break;
        starts.push(end);
        start = end;
      }
    }
    const pages = starts.map((offset, index) => text.slice(offset, starts[index + 1] ?? text.length));
    this.previousText = text;
    this.layout = layout;
    this.pageStarts = starts;
    this.result = {text: pages.at(-1), offset: start, pageNumber: pages.length, pages};
    return this.result;
  }
}
