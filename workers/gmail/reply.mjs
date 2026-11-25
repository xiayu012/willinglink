const EMAIL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?/g;
const ID = /^<[^<>\s\x00-\x1f\x7f]+>$/;

// Recognize the website's IDR request, not unrelated messages or subsequent replies.
export function buildIdrReply(message, mailbox) {
  const headers = new Map((message.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value || '']));
  const subject = headers.get('subject') || '';
  const original = headers.get('message-id') || '';
  const senderHeader = headers.get('from') || '';
  const sender = senderHeader.match(EMAIL) || [];
  const cc = (headers.get('cc') || '').match(EMAIL) || [];
  if (sender.length !== 1 || sender[0].toLowerCase() === mailbox || !cc.some(v => v.toLowerCase() === mailbox) || !message.threadId || !ID.test(original)) return null;
  if (!subject || /[\r\n\x00-\x1f\x7f]/.test(subject)) return null;
  const seen = new Set([mailbox, sender[0].toLowerCase()]);
  const unique = values => values.filter(value => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const to = [sender[0], ...unique((headers.get('to') || '').match(EMAIL) || [])];
  const replyCc = unique(cc);
  return { to, cc: replyCc, threadId: message.threadId, originalId: original, subject };
}

export function composeReply(reply) {
  const words = [];
  let chunk = '';
  for (const c of `Re: ${reply.subject.replace(/^re:\s*/i, '')}`) {
    if (Buffer.byteLength(chunk + c) > 30) { words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`); chunk = ''; }
    chunk += c;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  return Buffer.from([`To: ${reply.to.join(',\r\n ')}`, ...(reply.cc.length ? [`Cc: ${reply.cc.join(',\r\n ')}`] : []), `Subject: ${words.join('\r\n ')}`, `In-Reply-To: ${reply.originalId}`, `References: ${reply.originalId}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', 'test idr'].join('\r\n')).toString('base64url');
}
