import assert from 'node:assert/strict';
import { pickSenderName, SENDER_NAMES, validateSenderName } from './sender-names.mjs';

assert.ok(SENDER_NAMES.includes('Daniel | FretGone'));
assert.ok(SENDER_NAMES.includes('Michael | FretGone'));
assert.ok(SENDER_NAMES.includes('David | FretGone'));
assert.equal(new Set(SENDER_NAMES).size, SENDER_NAMES.length);
for (const name of SENDER_NAMES) assert.match(name, /^[A-Za-z]+ \| FretGone$/);

assert.equal(pickSenderName(() => 0), SENDER_NAMES[0]);
assert.equal(pickSenderName(() => SENDER_NAMES.length - 1), SENDER_NAMES[SENDER_NAMES.length - 1]);
assert.equal(pickSenderName(() => 2), SENDER_NAMES[2]);

assert.equal(validateSenderName('Daniel | FretGone'), 'Daniel | FretGone');
assert.throws(() => validateSenderName('Daniel'), /Invalid sender name/);
assert.throws(() => validateSenderName('Daniel | FretGone\r\nBcc: x@example.com'), /Invalid sender name/);
assert.throws(() => validateSenderName(''), /Invalid sender name/);
assert.throws(() => pickSenderName(() => SENDER_NAMES.length), /Invalid sender name/);
assert.throws(() => pickSenderName(null), /randomIndex must be a function/);

console.log('Sender name format and random selection tests passed; no email was sent.');
