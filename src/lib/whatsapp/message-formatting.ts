/**
 * Helpers for crafting concise, professional WhatsApp messages and
 * previewing how they appear before sending.
 *
 * NOTE: WhatsApp controls the native "Read more" fold inside the
 * recipient's app — no CRM or Cloud API flag can disable it. In
 * practice, WhatsApp mobile typically folds plain text messages around
 * ~700 characters or ~15 line breaks. These helpers flag likely fold
 * points and let agents opt in to cleaning excessive blank lines
 * without ever splitting or altering the message automatically.
 */

export const WHATSAPP_READ_MORE_CHAR_THRESHOLD = 650;
export const WHATSAPP_READ_MORE_LINE_THRESHOLD = 14;
export const WHATSAPP_RECOMMENDED_CHAR_TARGET = 400;

export interface MessageFormattingAnalysis {
  charCount: number;
  lineCount: number;
  hasExcessiveBlankLines: boolean;
  likelyTruncated: boolean;
  /** Preview of the opening 3 non-empty lines (what customers see first). */
  openingLines: string[];
  /** Actionable, concise formatting tips (empty when the message is crisp). */
  tips: string[];
}

export function analyzeOutgoingMessage(text: string): MessageFormattingAnalysis {
  const normalized = text.replace(/\r\n/g, '\n');
  const trimmed = normalized.trim();
  const charCount = trimmed.length;
  const lines = trimmed ? normalized.split('\n') : [];
  const lineCount = lines.length;
  const hasExcessiveBlankLines = /\n{3,}/.test(normalized);
  const likelyTruncated =
    charCount > WHATSAPP_READ_MORE_CHAR_THRESHOLD ||
    lineCount > WHATSAPP_READ_MORE_LINE_THRESHOLD;

  const openingLines = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 3);

  const tips: string[] = [];
  if (likelyTruncated) {
    tips.push(
      `Over ${WHATSAPP_READ_MORE_CHAR_THRESHOLD} chars or ${WHATSAPP_READ_MORE_LINE_THRESHOLD} lines — WhatsApp may collapse this behind "Read more". Put key details in the first 2–3 lines.`,
    );
  }
  if (hasExcessiveBlankLines) {
    tips.push(
      'Contains extra blank lines that push key details down in the WhatsApp preview.',
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
    hasExcessiveBlankLines,
    likelyTruncated,
    openingLines,
    tips,
  };
}

/**
 * Opt-in whitespace tidy: removes leading/trailing whitespace, trims
 * trailing spaces on lines, and collapses 3+ consecutive newlines to a
 * single blank line. Preserves 100% of the message's words and never
 * splits messages.
 */
export function optimizeMessageSpacing(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
