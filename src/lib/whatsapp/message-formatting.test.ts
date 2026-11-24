import { describe, expect, it } from 'vitest';
import {
  analyzeOutgoingMessage,
  convertMarkdownLinks,
  extractUrls,
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
    expect(res.hasMarkdownLinks).toBe(false);
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

  it('flags Markdown links that render literally in WhatsApp', () => {
    const res = analyzeOutgoingMessage(
      'Visit [vimsenterprise.com](https://vimsenterprise.com/) for more details.',
    );
    expect(res.hasMarkdownLinks).toBe(true);
    expect(res.tips.some((t) => t.includes('Markdown'))).toBe(true);
  });

  it('flags 3-line fold on document/media captions and greeting blank line', () => {
    const res = analyzeOutgoingMessage(
      'Hello Sir,\n\nPlease find attached our company brochure for an overview of VIMS Enterprise and the services we offer.',
      { context: 'media_caption' },
    );
    expect(res.foldLineLimit).toBe(3);
    expect(res.likelyTruncated).toBe(true);
    expect(res.hasGreetingBlankLine).toBe(true);
  });

  it('warns when a template has multiple URLs without a media header (first-URL preview hijack)', () => {
    const res = analyzeOutgoingMessage(
      'Hello Sir,\nDemo 1: https://biriyanitherapy.jilljill.in\nDemo 2: https://vimsenterprise.com',
      { context: 'marketing_template', hasMediaHeader: false },
    );
    expect(res.multiLinkPreviewRisk).toBe(true);
    expect(res.urls).toEqual([
      'https://biriyanitherapy.jilljill.in',
      'https://vimsenterprise.com',
    ]);
    expect(res.tips.some((t) => t.includes('first link'))).toBe(true);
  });

  it('does not flag multiLinkPreviewRisk on plain text when previewUrl is false', () => {
    const res = analyzeOutgoingMessage(
      'Demo 1: https://biriyanitherapy.jilljill.in\nDemo 2: https://vimsenterprise.com',
      { context: 'text', previewUrl: false },
    );
    expect(res.multiLinkPreviewRisk).toBe(false);
    expect(res.likelyTruncated).toBe(false);
  });
});

describe('convertMarkdownLinks & extractUrls', () => {
  it('converts domain-matching markdown links to bare URLs and labeled links to Label: URL', () => {
    expect(
      convertMarkdownLinks(
        'Site: [vimsenterprise.com](https://vimsenterprise.com/) and [View Demo](https://demo.example.com)',
      ),
    ).toBe('Site: https://vimsenterprise.com/ and View Demo: https://demo.example.com');
  });

  it('extracts URLs in appearance order without trailing punctuation', () => {
    expect(
      extractUrls('Check https://a.example.com, then https://b.example.com.'),
    ).toEqual(['https://a.example.com', 'https://b.example.com']);
  });
});

describe('optimizeMessageSpacing', () => {
  it('collapses 3+ consecutive newlines, cleans markdown links, and preserves all words', () => {
    const input =
      '  Hello Priya   \n\n\n\nYour invoice is at [vimsenterprise.com](https://vimsenterprise.com/).\n\n\nRegards  ';
    expect(optimizeMessageSpacing(input)).toBe(
      'Hello Priya\n\nYour invoice is at https://vimsenterprise.com/.\n\nRegards',
    );
  });

  it('compacts the blank line after a greeting when compactGreeting is enabled', () => {
    expect(
      optimizeMessageSpacing('Hello Sir,\n\nPlease find attached our brochure.', {
        compactGreeting: true,
      }),
    ).toBe('Hello Sir,\nPlease find attached our brochure.');
  });
});
