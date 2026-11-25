import assert from 'node:assert/strict';
import { buildIdrReply, IDR_REPLY_BODY, isIdrRequest } from './reply.mjs';

assert.equal(isIdrRequest('Please start an IDR.'), true);
assert.equal(isIdrRequest('internal dispute resolution request'), true);
assert.equal(isIdrRequest('This is an identification request'), false);
assert.equal(isIdrRequest(''), false);

const mailbox = 'contact@fretgone.com';
const message = { id: 'source-1', threadId: 'thread-1', payload: { headers: [
  { name: 'From', value: 'Example Owner <owner@example.com>' },
  { name: 'To', value: 'board@example.com' },
  { name: 'Cc', value: 'contact@fretgone.com, neighbor@example.com, OWNER@example.com' },
  { name: 'Subject', value: 'Formal IDR Request' },
  { name: 'Message-ID', value: '<original@example.com>' },
] } };
const reply = buildIdrReply(message, mailbox);
assert.deepEqual(reply.to, ['owner@example.com', 'board@example.com']);
assert.deepEqual(reply.cc, ['neighbor@example.com']);
assert.equal(reply.sourceMessageId, 'source-1');
assert.equal(reply.threadId, 'thread-1');
assert.equal(reply.originalId, '<original@example.com>');
assert.equal(reply.subject, 'Formal IDR Request');
assert.equal(reply.body, IDR_REPLY_BODY);
assert.equal(IDR_REPLY_BODY.trim(), 'test idr');

const noCc = structuredClone(message); noCc.payload.headers = noCc.payload.headers.filter(h => h.name !== 'Cc');
assert.equal(buildIdrReply(noCc, mailbox), null);
const invalidId = structuredClone(message); invalidId.payload.headers.find(h => h.name === 'Message-ID').value = 'bad\r\nBcc: bad@example.com';
assert.equal(buildIdrReply(invalidId, mailbox), null);
const noMessageId = structuredClone(message); delete noMessageId.id;
assert.equal(buildIdrReply(noMessageId, mailbox), null);
const ownSender = structuredClone(message); ownSender.payload.headers.find(h => h.name === 'From').value = 'contact@fretgone.com';
assert.equal(buildIdrReply(ownSender, mailbox), null);
const badSubject = structuredClone(message); badSubject.payload.headers.find(h => h.name === 'Subject').value = 'bad\r\nBcc: bad@example.com';
assert.equal(buildIdrReply(badSubject, mailbox), null);

console.log('IDR reply eligibility and reply-all participant tests passed; no email was sent.');
