/**
 * FretGone IDR auto-reply Apps Script.
 *
 * The Gmail poller invokes this through the Apps Script API `scripts.run`
 * method with parameters: [sourceMessageId, displayName, body].
 *
 * GmailApp.replyAll keeps the original thread and replies to the original
 * sender plus all original To/Cc recipients. The `name` option sets the
 * sender display name; there is intentionally no nameless fallback.
 *
 * GmailMessage.replyAll returns the original GmailMessage for chaining, not the
 * message it sent. Its getId() is therefore the original message ID, never a
 * sent-message ID, so this function reports only that the send was accepted and
 * the original thread ID.
 *
 * @param {string} sourceMessageId Gmail message ID of the inbound IDR request.
 * @param {string} displayName Sender display name in the form "Name | FretGone".
 * @param {string} body Plain-text reply body.
 * @return {{accepted: boolean, threadId: string}}
 */
function sendIdrReply(sourceMessageId, displayName, body) {
  if (typeof sourceMessageId !== 'string' || !sourceMessageId.trim() || /[\s\x00-\x1f\x7f]/.test(sourceMessageId)) {
    throw new Error('sourceMessageId is required and must not contain whitespace');
  }
  if (
    typeof displayName !== 'string' ||
    !displayName.trim() ||
    !displayName.endsWith(' | FretGone') ||
    /[\r\n]/.test(displayName)
  ) {
    throw new Error('displayName is required in the form "Name | FretGone"');
  }
  if (typeof body !== 'string' || !body.trim() || body.includes('\0')) {
    throw new Error('body is required');
  }

  const original = GmailApp.getMessageById(sourceMessageId);
  const threadId = original.getThread().getId();
  // Do not inspect the return value: replyAll returns the original message for
  // chaining, so any getId() on it is the source message, not the sent message.
  // A thrown error means the send was not accepted; returning means it was.
  original.replyAll(body, { name: displayName });

  return { accepted: true, threadId };
}

/** Run once from the Apps Script editor to grant the script's Gmail access. */
function authorize() {
  GmailApp.getInboxUnreadCount();
}
