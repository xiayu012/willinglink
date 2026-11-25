import assert from 'node:assert/strict';
import { buildIdrReply, IDR_REPLY_BODY, isIdrRequest } from './reply.mjs';

assert.equal(isIdrRequest('Please start an IDR.'), true);
assert.equal(isIdrRequest('internal dispute resolution request'), true);
assert.equal(isIdrRequest('This is an identification request'), false);
assert.equal(isIdrRequest(''), false);

const mailbox = 'contact@fretgone.com';
const message = { id: 'source-1', threadId: 'thread-1', payload: { headers: [
  { name: 'From', value: 'Example Owner <owner@example.com>' },
  { name: 'To', value: 'board@example.com, contact@fretgone.com, second@example.com' },
  { name: 'Cc', value: 'contact@fretgone.com, neighbor@example.com, OWNER@example.com' },
  { name: 'Subject', value: 'Formal IDR Request' },
  { name: 'Message-ID', value: '<original@example.com>' },
  { name: 'References', value: '<earlier@example.com>\r\n <older@example.com>' },
] } };
const reply = buildIdrReply(message, mailbox);
// Sender, To and Cc are merged into one To list; our mailbox and duplicates
// are removed, and no Cc list is produced.
assert.deepEqual(reply.to, ['owner@example.com', 'board@example.com', 'second@example.com', 'neighbor@example.com']);
assert.equal('cc' in reply, false);
assert.equal(reply.sourceMessageId, 'source-1');
assert.equal(reply.threadId, 'thread-1');
assert.equal(reply.originalId, '<original@example.com>');
assert.equal(reply.references, '<earlier@example.com> <older@example.com>');
assert.equal(reply.subject, 'Formal IDR Request');
assert.equal(reply.body, IDR_REPLY_BODY);
assert.equal(IDR_REPLY_BODY.trim(), 'test idr');

const noReferences = structuredClone(message);
noReferences.payload.headers = noReferences.payload.headers.filter(h => h.name !== 'References');
assert.equal(buildIdrReply(noReferences, mailbox).references, null);

const noCc = structuredClone(message); noCc.payload.headers = noCc.payload.headers.filter(h => h.name !== 'Cc');
assert.equal(buildIdrReply(noCc, mailbox), null);
const invalidId = structuredClone(message); invalidId.payload.headers.find(h => h.name === 'Message-ID').value = 'bad\r\nBcc: bad@example.com';
assert.equal(buildIdrReply(invalidId, mailbox), null);
const invalidReferences = structuredClone(message); invalidReferences.payload.headers.find(h => h.name === 'References').value = '<ok@example.com> bad';
assert.equal(buildIdrReply(invalidReferences, mailbox), null);
const noMessageId = structuredClone(message); delete noMessageId.id;
assert.equal(buildIdrReply(noMessageId, mailbox), null);
const ownSender = structuredClone(message); ownSender.payload.headers.find(h => h.name === 'From').value = 'contact@fretgone.com';
assert.equal(buildIdrReply(ownSender, mailbox), null);
const badSubject = structuredClone(message); badSubject.payload.headers.find(h => h.name === 'Subject').value = 'bad\r\nBcc: bad@example.com';
assert.equal(buildIdrReply(badSubject, mailbox), null);
const tooMany = structuredClone(message);
tooMany.payload.headers.find(h => h.name === 'To').value = Array.from({ length: 100 }, (_, i) => `person${i}@example.com`).join(', ');
assert.equal(buildIdrReply(tooMany, mailbox), null);

console.log('IDR reply eligibility and combined-To participant tests passed; no email was sent.');
