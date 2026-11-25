import assert from 'node:assert/strict';
import { composeIdrReplyMime, sendIdrReplyViaGmailApi } from './gmail-send.mjs';
import { buildIdrReply } from './reply.mjs';

const message = { id: 'source', threadId: 'thread', payload: { headers: [
  { name: 'From', value: 'Owner <owner@example.com>' },
  { name: 'To', value: 'board@example.com' },
  { name: 'Cc', value: 'contact@fretgone.com' },
  { name: 'Subject', value: 'Formal IDR Request' },
  { name: 'Message-ID', value: '<original@example.com>' },
] } };
const reply = { ...buildIdrReply(message, 'contact@fretgone.com'), mailbox: 'contact@fretgone.com', displayName: 'Jack | FretGone' };
const mime = Buffer.from(composeIdrReplyMime(reply), 'base64url').toString();
assert.match(mime, /^From: Jack \| FretGone <contact@fretgone\.com>\r?$/m);
assert.match(mime, /^To: owner@example\.com,\r?\n board@example\.com\r?$/m);
assert.doesNotMatch(mime, /^Cc:/mi);
assert.match(mime, /^In-Reply-To: <original@example\.com>\r?$/m);
let sent;
const result = await sendIdrReplyViaGmailApi(reply, {
  accessToken: async () => 'token',
  request: async (_url, options) => { sent = JSON.parse(options.body); return { ok: true, json: async () => ({ id: 'sent', threadId: 'thread' }) }; },
});
assert.equal(sent.threadId, 'thread');
assert.equal(Buffer.from(sent.raw, 'base64url').toString(), mime);
assert.equal(result.gmailMessageId, 'sent');
await assert.rejects(() => sendIdrReplyViaGmailApi(reply, { accessToken: async () => 'token', request: async () => { throw new Error('timeout'); } }), e => e.outcome === 'unknown');
assert.throws(() => composeIdrReplyMime({ ...reply, displayName: 'Jack\r\nBcc: attacker@example.com' }));
console.log('Gmail reply To, thread, sender name and unknown outcome tests passed.');
