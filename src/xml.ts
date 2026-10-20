import { escapeHtml } from './html';

// Normalize line endings and replace characters forbidden by XML 1.0.
export function xmlText(text: string): string {
  return escapeHtml(text.replace(/\r\n?/g, '\n').replace(/[^\u0009\u000a\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '\ufffd'));
}
