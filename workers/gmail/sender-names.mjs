import { randomInt } from 'node:crypto';

// Familiar first names, rendered in the required "Name | FretGone" format.
// The assignment is persisted with the first auto-reply claim for a Gmail
// thread, so every later message in that thread keeps the same sender name.
export const SENDER_NAMES = Object.freeze([
  'Daniel | FretGone',
  'Michael | FretGone',
  'David | FretGone',
  'James | FretGone',
  'Robert | FretGone',
  'John | FretGone',
  'Thomas | FretGone',
  'Christopher | FretGone',
  'Matthew | FretGone',
  'Andrew | FretGone',
  'Joshua | FretGone',
  'William | FretGone',
  'Joseph | FretGone',
  'Ryan | FretGone',
  'Nicholas | FretGone',
  'Anthony | FretGone',
  'Eric | FretGone',
  'Jonathan | FretGone',
  'Stephen | FretGone',
  'Brian | FretGone',
  'Kevin | FretGone',
  'Jason | FretGone',
  'Mark | FretGone',
  'Paul | FretGone',
  'Steven | FretGone',
  'Richard | FretGone',
  'Timothy | FretGone',
  'Jeffrey | FretGone',
  'Adam | FretGone',
  'Benjamin | FretGone',
  'Patrick | FretGone',
  'Scott | FretGone',
  'Frank | FretGone',
  'Gregory | FretGone',
  'Samuel | FretGone',
  'Alexander | FretGone',
  'Nathan | FretGone',
  'Peter | FretGone',
  'Henry | FretGone',
  'Jack | FretGone',
]);

const NAME_FORMAT = /^[A-Za-z]+ \| FretGone$/;

export function validateSenderName(name) {
  if (typeof name !== 'string' || !NAME_FORMAT.test(name)) {
    throw new Error('Invalid sender name; expected "Name | FretGone"');
  }
  return name;
}

export function pickSenderName(randomIndex = randomInt) {
  if (typeof randomIndex !== 'function') throw new TypeError('randomIndex must be a function');
  return validateSenderName(SENDER_NAMES[randomIndex(SENDER_NAMES.length)]);
}
