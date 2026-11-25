import { validateSenderName } from './sender-names.mjs';

const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const TIMEOUT_MS = 30_000;
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const MESSAGE_ID = /^<[^<>\s\x00-\x1f\x7f]+>$/;
const REFERENCES = /^(<[^<>\s\x00-\x1f\x7f]+>)(\s+<[^<>\s\x00-\x1f\x7f]+>)*$/;
const THREAD_ID = /^[^\s\x00-\x1f\x7f]+$/;

/**
 * Any failure after the send request is attempted is reported as an unknown
 * outcome. Gmail may have accepted the reply before the failure surfaced, so
 * the worker must not retry automatically.
 */
export class GmailReplySendError extends Error {
  constructor(message, outcome = 'unknown', status) {
    super(message);
    this.name = 'GmailReplySendError';
    this.outcome = outcome;
    this.status = status;
  }
}

function rejected(message) {
  return new GmailReplySendError(message, 'rejected');
}

function addressList(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 100) {
    throw rejected('Invalid recipient count');
  }
  return values.map((value) => {
    const address = typeof value === 'string' ? value.trim() : '';
    if (!ADDRESS.test(address) || address.length > 254) throw rejected('Invalid recipient address');
    return address;
  }).join(',\r\n ');
}

function encodedSubject(subject) {
  if (typeof subject !== 'string' || !subject.trim() || /[\r\n\x00-\x1f\x7f]/.test(subject) || subject.length > 998) {
    throw rejected('Invalid email subject');
  }
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  // Encode UTF-8 in small RFC 2047 encoded words without splitting code points.
  const words = [];
  let chunk = '';
  for (const char of subject) {
    if (Buffer.byteLength(chunk + char, 'utf8') > 30) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  return words.join('\r\n ');
}

function encodedBody(body) {
  if (typeof body !== 'string' || !body.trim() || body.includes('\0')) throw rejected('Invalid reply body');
  return Buffer.from(body.replace(/\r\n|\r|\n/g, '\r\n'), 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
}

/**
 * Builds the raw MIME message for an IDR reply. The original sender and the
 * original To/Cc recipients are already merged into `to` by buildIdrReply and
 * are sent in one To header. No Cc header is emitted.
 */
export function composeIdrReplyMime(reply) {
  if (!reply || typeof reply !== 'object') throw rejected('Invalid reply payload');
  const mailbox = typeof reply.mailbox === 'string' ? reply.mailbox.trim() : '';
  if (!ADDRESS.test(mailbox) || mailbox.length > 254) throw rejected('Invalid mailbox address');
  let displayName;
  try {
    displayName = validateSenderName(reply.displayName);
  } catch {
    throw rejected('Invalid sender display name');
  }
  if (typeof reply.threadId !== 'string' || !THREAD_ID.test(reply.threadId)) throw rejected('Invalid threadId');
  if (typeof reply.originalId !== 'string' || !MESSAGE_ID.test(reply.originalId)) throw rejected('Invalid original Message-ID');
  const references = reply.references == null ? '' : String(reply.references).replace(/\s+/g, ' ').trim();
  if (references && !REFERENCES.test(references)) throw rejected('Invalid References header');

  const mime = [
    `From: ${displayName} <${mailbox}>`,
    `To: ${addressList(reply.to)}`,
    `Subject: ${encodedSubject(reply.subject)}`,
    `In-Reply-To: ${reply.originalId}`,
    `References: ${references ? `${references} ` : ''}${reply.originalId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodedBody(reply.body),
  ].join('\r\n');
  return Buffer.from(mime, 'utf8').toString('base64url');
}

/**
 * Sends the IDR reply through the Gmail API as the authorized mailbox. The
 * `threadId` field keeps the message in the original Gmail thread, and the
 * In-Reply-To / References headers keep it threaded for other mail clients.
 */
export async function sendIdrReplyViaGmailApi(reply, deps) {
  if (!deps || typeof deps.accessToken !== 'function' || typeof deps.request !== 'function') {
    throw rejected('Invalid Gmail transport');
  }
  const raw = composeIdrReplyMime(reply);

  let token;
  try {
    token = await deps.accessToken();
  } catch (error) {
    throw rejected(`Gmail authorization failed before sending: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!token) throw rejected('Gmail access token unavailable before sending');

  let response;
  try {
    response = await deps.request(SEND_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw, threadId: reply.threadId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GmailReplySendError('Gmail API request failed; send outcome is unknown', 'unknown');
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {
      // The status alone is enough; do not mask the unknown outcome.
    }
    throw new GmailReplySendError(
      `Gmail API HTTP ${response.status}${detail ? `: ${detail}` : ''}; send outcome is unknown`,
      'unknown',
      response.status,
    );
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new GmailReplySendError('Gmail API response could not be read; send outcome is unknown', 'unknown');
  }
  if (!result || typeof result.id !== 'string' || !result.id || typeof result.threadId !== 'string' || !result.threadId) {
    throw new GmailReplySendError('Gmail API returned an incomplete result; send outcome is unknown', 'unknown');
  }
  if (result.threadId !== reply.threadId) {
    throw new GmailReplySendError('Gmail API reply left the original thread; send outcome is unknown', 'unknown');
  }

  return { gmailMessageId: result.id, gmailThreadId: result.threadId };
}
