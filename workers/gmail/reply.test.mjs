import assert from 'node:assert/strict';
import { buildIdrReply, composeReply } from './reply.mjs';
const mailbox = 'contact@fretgone.com';
const message = { threadId: 'thread-1', payload: { headers: [
  { name: 'From', value: 'Example Owner <owner@example.com>' },
  { name: 'To', value: 'board@example.com' },
  { name: 'Cc', value: 'contact@fretgone.com' },
  { name: 'Subject', value: 'Formal IDR Request' },
  { name: 'Message-ID', value: '<original@example.com>' },
] } };
const reply = buildIdrReply(message, mailbox);
assert.equal(reply.to, 'owner@example.com');
const raw = Buffer.from(composeReply(reply), 'base64url').toString();
assert.match(raw, /In-Reply-To: <original@example.com>/);
assert.match(raw, /References: <original@example.com>/);
assert.match(raw, /\r\n\r\ntest idr$/);
assert.doesNotMatch(raw, /board@example.com/);
const noCc = structuredClone(message); noCc.payload.headers = noCc.payload.headers.filter(h => h.name !== 'Cc');
assert.equal(buildIdrReply(noCc, mailbox), null);
const invalidId = structuredClone(message); invalidId.payload.headers.find(h => h.name === 'Message-ID').value = 'bad\r\nBcc: bad@example.com';
assert.equal(buildIdrReply(invalidId, mailbox), null);
console.log('IDR reply format and recipient tests passed');
