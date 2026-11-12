import { safeLink } from './conversation-normalize';
import type { ConversationText, ConversationTextSpan } from './conversation-types';

function trimPlainUrl(value: string): string {
  const balance = { ')': 0, ']': 0, '}': 0 };
  for (const char of value) {
    switch (char) {
      case '(': balance[')']--; break;
      case '[': balance[']']--; break;
      case '{': balance['}']--; break;
      case ')': case ']': case '}': balance[char]++; break;
    }
  }
  let end = value.length;
  while (end > 0) {
    const last = value[end - 1]!;
    if (/[.,!?;:…。，！？；：]/u.test(last)) end--;
    else if ((last === ')' || last === ']' || last === '}') && balance[last] > 0) {
      balance[last]--;
      end--;
    } else break;
  }
  return value.slice(0, end);
}

export function conversationLinks(content: ConversationText): readonly string[] {
  const spans = content.spans.filter((span): span is Extract<ConversationTextSpan, { kind: 'link' }> => span.kind === 'link')
    .sort((a, b) => a.start - b.start);
  const links: { at: number; url: string }[] = spans.map(span => ({ at: span.start, url: span.url }));
  let nextSpan = 0;
  for (const match of content.text.matchAll(/\bhttps?:\/\/[^\s<>"'«»“”]+/giu)) {
    const at = match.index;
    while (nextSpan < spans.length && spans[nextSpan]!.start + spans[nextSpan]!.length <= at) nextSpan++;
    // A formatted link's visible label can look like a URL itself.
    if (nextSpan < spans.length && spans[nextSpan]!.start < at + match[0].length) continue;
    const url = safeLink(trimPlainUrl(match[0]));
    if (url) links.push({ at, url });
  }
  links.sort((a, b) => a.at - b.at);
  return [...new Set(links.map(link => link.url))];
}
