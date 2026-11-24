/**
 * Helpers for crafting concise, professional WhatsApp messages and
 * previewing how they appear before sending.
 *
 * NOTE: WhatsApp controls the native "Read more" fold inside the
 * recipient's app — no CRM or Cloud API flag can disable it.
 *
 * Observed WhatsApp Android / iOS folding behaviour:
 *  - Plain free-form text (with `preview_url: false`): ~650 chars / ~14 visual lines.
 *  - Marketing templates & messages with a Link Preview card: ~5 visual lines.
 *  - Document / media captions & Marketing templates with a PDF/image header: ~3 visual lines.
 *  - Utility templates (no raw URL preview): do not enforce the 5-line marketing fold,
 *    though raw URLs in the body still trigger an automatic link preview card for the
 *    FIRST URL and can cause earlier folding.
 *
 * Blank lines count toward WhatsApp's visible line budget, and WhatsApp does NOT
 * parse Markdown `[label](url)` syntax (it renders the brackets literally).
 */

export const WHATSAPP_READ_MORE_CHAR_THRESHOLD = 650;
export const WHATSAPP_READ_MORE_LINE_THRESHOLD = 14;
export const WHATSAPP_RECOMMENDED_CHAR_TARGET = 400;

/** Approximate characters per wrapped line inside a mobile WhatsApp bubble. */
export const WHATSAPP_MOBILE_CHARS_PER_LINE = 36;

export type OutgoingMessageContext =
  | 'text'
  | 'media_caption'
  | 'marketing_template'
  | 'utility_template';

export interface AnalyzeMessageOptions {
  context?: OutgoingMessageContext;
  hasMediaHeader?: boolean;
  previewUrl?: boolean;
}

export interface MessageFormattingAnalysis {
  charCount: number;
  lineCount: number;
  /** Estimated visual lines on mobile including wrapped lines and blank lines. */
  estimatedMobileLines: number;
  /** Threshold of visible lines before WhatsApp likely adds "Read more" for this context. */
  foldLineLimit: number;
  hasExcessiveBlankLines: boolean;
  hasGreetingBlankLine: boolean;
  hasMarkdownLinks: boolean;
  urls: string[];
  /** True when a link preview card for the first URL may hijack a multi-link message. */
  multiLinkPreviewRisk: boolean;
  likelyTruncated: boolean;
  /** Preview of the opening 3 non-empty lines (what customers see first). */
  openingLines: string[];
  /** Actionable, concise formatting tips (empty when the message is crisp). */
  tips: string[];
}

const MARKDOWN_LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>()[\]]+/gi;
const GREETING_BLANK_LINE_RE = /^([^\n]{1,36}[,!:]?)\n\n+(?=\S)/;

/**
 * Extract all `http(s)://` URLs in appearance order (preserving first-URL order,
 * which is the URL WhatsApp previews when link previews are active).
 */
export function extractUrls(text: string): string[] {
  const matches = text.match(URL_RE) ?? [];
  return matches.map((u) => u.replace(/[.,;:!?)]+$/, ''));
}

export function hasMarkdownLinks(text: string): boolean {
  MARKDOWN_LINK_RE.lastIndex = 0;
  return MARKDOWN_LINK_RE.test(text);
}

/**
 * Convert Markdown links (`[label](https://...)`) to plain WhatsApp-friendly URLs.
 * - If the label is just the URL or domain (e.g. `[vimsenterprise.com](https://vimsenterprise.com/)`),
 *   replaces it with the clean URL (`https://vimsenterprise.com/`).
 * - If the label is descriptive (e.g. `[View Demo](https://demo.example.com)`),
 *   replaces it with `View Demo: https://demo.example.com`.
 */
export function convertMarkdownLinks(text: string): string {
  return text.replace(MARKDOWN_LINK_RE, (_match, rawLabel: string, url: string) => {
    const label = rawLabel.trim();
    const normalizedLabel = label
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '');
    const normalizedUrl = url
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '');
    if (!label || normalizedLabel === normalizedUrl || normalizedUrl.startsWith(`${normalizedLabel}/`)) {
      return url;
    }
    return `${label}: ${url}`;
  });
}

/**
 * Estimate how many visual lines a message takes on a mobile WhatsApp screen.
 * Blank lines count as 1 full visual line (matching WhatsApp Android's fold counter).
 */
export function estimateMobileLines(text: string): number {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return 0;
  return normalized.split('\n').reduce((sum, line) => {
    const len = line.trim().length;
    if (len === 0) return sum + 1;
    return sum + Math.max(1, Math.ceil(len / WHATSAPP_MOBILE_CHARS_PER_LINE));
  }, 0);
}

export function analyzeOutgoingMessage(
  text: string,
  options: AnalyzeMessageOptions = {},
): MessageFormattingAnalysis {
  const context: OutgoingMessageContext = options.context ?? 'text';
  const hasMediaHeader = options.hasMediaHeader ?? false;
  const previewUrl = options.previewUrl ?? false;

  const normalized = text.replace(/\r\n/g, '\n');
  const trimmed = normalized.trim();
  const charCount = trimmed.length;
  const lines = trimmed ? normalized.split('\n') : [];
  const lineCount = lines.length;
  const estimatedMobileLines = estimateMobileLines(trimmed);

  const hasExcessiveBlankLines = /\n{3,}/.test(normalized);
  const hasGreetingBlankLine = GREETING_BLANK_LINE_RE.test(trimmed);
  const markdownLinksFound = hasMarkdownLinks(trimmed);
  const urls = extractUrls(trimmed);

  const isTemplate =
    context === 'marketing_template' || context === 'utility_template';
  const willRenderLinkPreview =
    urls.length > 0 &&
    ((context === 'text' && previewUrl) || (isTemplate && !hasMediaHeader));

  // Determine the realistic mobile line budget before WhatsApp shows "Read more".
  let foldLineLimit = WHATSAPP_READ_MORE_LINE_THRESHOLD;
  if (context === 'media_caption' || (context === 'marketing_template' && hasMediaHeader)) {
    foldLineLimit = 3;
  } else if (context === 'marketing_template' || willRenderLinkPreview) {
    foldLineLimit = 5;
  }

  const isTightContext = foldLineLimit <= 5;
  const likelyTruncated = isTightContext
    ? estimatedMobileLines > foldLineLimit || charCount > (foldLineLimit === 3 ? 130 : 220)
    : charCount > WHATSAPP_READ_MORE_CHAR_THRESHOLD ||
      lineCount > WHATSAPP_READ_MORE_LINE_THRESHOLD;

  const multiLinkPreviewRisk = willRenderLinkPreview && urls.length >= 2;

  const openingLines = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 3);

  const tips: string[] = [];

  if (markdownLinksFound) {
    tips.push(
      'Contains Markdown links like [text](url) — WhatsApp shows brackets literally. Click "Fix formatting" to convert to clean clickable links.',
    );
  }

  if (multiLinkPreviewRisk) {
    tips.push(
      isTemplate
        ? `Template has ${urls.length} URLs: WhatsApp auto-shows a large preview card ONLY for the first link (${urls[0]}). Put your main company website first or add an Image/Document header.`
        : `Link preview is ON with ${urls.length} URLs — WhatsApp will highlight only the first link (${urls[0]}). Turn Link preview OFF to avoid a single-link card and early "Read more".`,
    );
  }

  if (likelyTruncated) {
    if (context === 'media_caption') {
      tips.push(
        'WhatsApp folds document/media captions after ~3 lines on mobile. Keep the caption to 1–2 concise lines and share detailed links in a separate text message.',
      );
    } else if (context === 'marketing_template') {
      tips.push(
        hasMediaHeader
          ? 'Marketing templates with a PDF/media header fold after ~3 lines on WhatsApp mobile. Use Utility category when eligible, or keep the opening hook inside lines 1–2.'
          : 'Meta folds Marketing templates after ~5 lines on WhatsApp mobile. Use Utility category when eligible, remove blank lines, or front-load key details in lines 1–2.',
      );
    } else if (willRenderLinkPreview) {
      tips.push(
        isTemplate
          ? 'Raw URLs in a template trigger an automatic link preview card, which folds the body earlier behind "Read more".'
          : 'Link preview cards reduce visible lines on mobile — turn Link preview OFF to show up to ~14 lines without "Read more".',
      );
    } else {
      tips.push(
        `Over ${WHATSAPP_READ_MORE_CHAR_THRESHOLD} chars or ${WHATSAPP_READ_MORE_LINE_THRESHOLD} lines — WhatsApp may collapse this behind "Read more". Put key details in the first 2–3 lines.`,
      );
    }
  }

  if (hasExcessiveBlankLines) {
    tips.push(
      'Contains extra blank lines that push key details down in the WhatsApp preview.',
    );
  } else if (hasGreetingBlankLine && isTightContext) {
    tips.push(
      'The blank line after your greeting uses 1 of WhatsApp\'s 3–5 visible lines before "Read more". Remove it to show more content upfront.',
    );
  }

  if (
    openingLines.length > 0 &&
    openingLines[0].length > 140 &&
    !likelyTruncated
  ) {
    tips.push(
      'Opening line is long — a shorter first line makes the message easier to scan.',
    );
  }

  return {
    charCount,
    lineCount,
    estimatedMobileLines,
    foldLineLimit,
    hasExcessiveBlankLines,
    hasGreetingBlankLine,
    hasMarkdownLinks: markdownLinksFound,
    urls,
    multiLinkPreviewRisk,
    likelyTruncated,
    openingLines,
    tips,
  };
}

/**
 * Opt-in formatter: removes leading/trailing whitespace, trims trailing
 * spaces on lines, collapses 3+ consecutive newlines to a single blank line,
 * and converts Markdown `[label](url)` links into clean WhatsApp URLs.
 * Preserves 100% of the message's words and never splits messages.
 */
export function optimizeMessageSpacing(
  text: string,
  options: { compactGreeting?: boolean } = {},
): string {
  let cleaned = convertMarkdownLinks(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (options.compactGreeting) {
    cleaned = cleaned.replace(GREETING_BLANK_LINE_RE, '$1\n');
  }

  return cleaned;
}
