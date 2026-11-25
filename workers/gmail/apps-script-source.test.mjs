import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./apps-script/Code.gs', import.meta.url), 'utf8');

function load(context) {
  const sandbox = vm.createContext(context);
  vm.runInContext(source, sandbox);
  return sandbox;
}

function gmailStub(calls, { threadId = 'thread-1' } = {}) {
  return {
    getMessageById(id) {
      calls.push(['getMessageById', id]);
      const original = {
        // GmailMessage.replyAll returns the original message for chaining, so
        // reading this ID would produce the source message ID, not a sent ID.
        getId() {
          throw new Error('the original message ID must not be treated as a sent message ID');
        },
        getThread() {
          calls.push(['getThread']);
          return { getId: () => threadId };
        },
        replyAll(body, options) {
          calls.push(['replyAll', body, options]);
          return original;
        },
      };
      return original;
    },
  };
}

const calls = [];
const context = load({ GmailApp: gmailStub(calls) });
const result = context.sendIdrReply('source-1', 'Daniel | FretGone', 'test idr');
// Compare fields individually: the VM realm creates its own object prototypes.
assert.equal(result.accepted, true);
assert.equal(result.threadId, 'thread-1');
assert.equal('messageId' in result, false);
assert.equal(calls[0][0], 'getMessageById');
assert.equal(calls[0][1], 'source-1');
const replyAllCall = calls.find((call) => call[0] === 'replyAll');
assert.equal(replyAllCall[1], 'test idr');
assert.equal(replyAllCall[2].name, 'Daniel | FretGone');
assert.equal(calls.some((call) => call[0] === 'getId'), false);

const invalidCalls = [];
const invalid = load({ GmailApp: gmailStub(invalidCalls) });
assert.throws(() => invalid.sendIdrReply('source-1', 'Daniel', 'test idr'), /displayName/);
assert.throws(() => invalid.sendIdrReply('source-1', 'Daniel | FretGone', ''), /body/);
assert.throws(() => invalid.sendIdrReply('', 'Daniel | FretGone', 'test idr'), /sourceMessageId/);
assert.throws(() => invalid.sendIdrReply('source-1', 'Daniel | FretGone\r\nBcc: x@example.com', 'test idr'), /displayName/);
assert.equal(invalidCalls.length, 0);

const failure = load({
  GmailApp: {
    getMessageById() {
      return {
        getThread: () => ({ getId: () => 'thread-1' }),
        replyAll() {
          throw new Error('quota exceeded');
        },
      };
    },
  },
});
assert.throws(() => failure.sendIdrReply('source-1', 'Daniel | FretGone', 'test idr'), /quota exceeded/);

console.log('Apps Script source tests passed; no email was sent.');
