import type { ConversationMessage, ConversationSearchMatch, ConversationSearchRange, ConversationText } from './conversation-types';

const noRanges: readonly ConversationSearchRange[] = Object.freeze([]);

function foldCase(text: string): string {
  return text.toLowerCase().toUpperCase();
}

function findRanges(text: string, term: string): readonly ConversationSearchRange[] {
  const folded = foldCase(text);
  let index = folded.indexOf(term);
  if (index < 0) return noRanges;

  // Case folding can expand one character into several.
  // Map match boundaries back to whole characters in the original text.
  let offsets: Int32Array | undefined;
  if (folded.length !== text.length) {
    offsets = new Int32Array(folded.length + 1).fill(-1);
    offsets[0] = 0;
    let sourceEnd = 0, foldedEnd = 0;
    for (const char of text) {
      sourceEnd += char.length;
      foldedEnd += foldCase(char).length;
      offsets[foldedEnd] = sourceEnd;
    }
  }

  const ranges: ConversationSearchRange[] = [];
  while (index >= 0) {
    const end = index + term.length;
    const startInSource = offsets ? offsets[index]! : index;
    const endInSource = offsets ? offsets[end]! : end;
    const complete = startInSource >= 0 && endInSource >= 0;
    if (complete) ranges.push(Object.freeze({ start: startInSource, length: endInSource - startInSource }));
    index = folded.indexOf(term, complete ? end : index + 1);
  }
  return ranges.length ? Object.freeze(ranges) : noRanges;
}

export function createConversationSearchIndex(query: string) {
  const term = foldCase(query);
  const byText = new WeakMap<ConversationText, readonly ConversationSearchRange[]>();
  return (messages: readonly ConversationMessage[]): readonly ConversationSearchMatch[] => {
    const matches: ConversationSearchMatch[] = [];
    if (term.length === 0) return Object.freeze(matches);
    for (const { serverSeq, content: { text } } of messages) {
      let ranges = byText.get(text);
      if (!ranges) {
        ranges = findRanges(text.text, term);
        byText.set(text, ranges);
      }
      if (ranges.length) matches.push(Object.freeze({ serverSeq, ranges }));
    }
    return Object.freeze(matches);
  };
}
