import { describe, expect, it } from 'vitest';
import {
  analyzeOutgoingMessage,
  optimizeMessageSpacing,
  WHATSAPP_READ_MORE_CHAR_THRESHOLD,
} from './message-formatting';

describe('analyzeOutgoingMessage', () => {
  it('marks concise messages as not truncated with no tips', () => {
    const res = analyzeOutgoingMessage(
      'Hi Priya,\nYour order #4821 is confirmed for delivery tomorrow at 10 AM.',
    );
    expect(res.likelyTruncated).toBe(false);
    expect(res.hasExcessiveBlankLines).toBe(false);
    expect(res.tips).toEqual([]);
    expect(res.openingLines).toHaveLength(2);
  });

  it('flags messages exceeding the WhatsApp Read more char threshold', () => {
    const longMsg = 'A'.repeat(WHATSAPP_READ_MORE_CHAR_THRESHOLD + 20);
    const res = analyzeOutgoingMessage(longMsg);
    expect(res.likelyTruncated).toBe(true);
    expect(res.tips.some((t) => t.includes('Read more'))).toBe(true);
  });

  it('flags excessive blank lines without altering the text', () => {
    const res = analyzeOutgoingMessage('Hello\n\n\n\nImportant update');
    expect(res.hasExcessiveBlankLines).toBe(true);
    expect(res.tips.some((t) => t.includes('blank lines'))).toBe(true);
  });
});

describe('optimizeMessageSpacing', () => {
  it('collapses 3+ consecutive newlines and preserves all words', () => {
    const input = '  Hello Priya   \n\n\n\nYour invoice is attached.\n\n\nRegards  ';
    expect(optimizeMessageSpacing(input)).toBe(
      'Hello Priya\n\nYour invoice is attached.\n\nRegards',
    );
  });
});
