const EMAIL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?/g;
const ID = /^<[^<>\s\x00-\x1f\x7f]+>$/;
const MESSAGE_ID = /^[^\s\x00-\x1f\x7f]+$/;
const IDR_TRIGGER = /\b(?:internal dispute resolution|idr)\b/i;

export const IDR_REPLY_BODY = 'test idr';

// Recognize the website's IDR request, not unrelated messages or subsequent replies.
export function isIdrRequest(body) {
  return typeof body === 'string' && IDR_TRIGGER.test(body);
}

export function buildIdrReply(message, mailbox) {
  const headers = new Map((message.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value || '']));
  const subject = headers.get('subject') || '';
  const original = headers.get('message-id') || '';
  const senderHeader = headers.get('from') || '';
  const sender = senderHeader.match(EMAIL) || [];
  const cc = (headers.get('cc') || '').match(EMAIL) || [];
  if (sender.length !== 1 || sender[0].toLowerCase() === mailbox || !cc.some(v => v.toLowerCase() === mailbox) || !message.threadId || !ID.test(original)) return null;
  if (typeof message.id !== 'string' || !MESSAGE_ID.test(message.id)) return null;
  if (!subject || /[\r\n\x00-\x1f\x7f]/.test(subject)) return null;
  const seen = new Set([mailbox, sender[0].toLowerCase()]);
  const unique = values => values.filter(value => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // GmailApp.replyAll computes the actual recipients from the source message.
  // These fields document and test the expected reply-all participant set.
  const to = [sender[0], ...unique((headers.get('to') || '').match(EMAIL) || [])];
  const replyCc = unique(cc);
  return {
    sourceMessageId: message.id,
    to,
    cc: replyCc,
    threadId: message.threadId,
    originalId: original,
    subject,
    body: IDR_REPLY_BODY,
  };
}
