const SCRIPT_API = 'https://script.googleapis.com/v1/scripts';
const DEFAULT_FUNCTION = 'sendIdrReply';
const TIMEOUT_MS = 60_000;

/**
 * Any transport, API, or execution failure is reported as an unknown outcome.
 * Gmail may have accepted the reply before the failure surfaced, so the worker
 * must never retry automatically.
 */
export class AppsScriptSendError extends Error {
  constructor(message, outcome = 'unknown', status) {
    super(message);
    this.name = 'AppsScriptSendError';
    this.outcome = outcome;
    this.status = status;
  }
}

// The Apps Script API requires an API Executable deployment ID in the
// scripts.run URL, not the script ID from Project Settings. A missing value
// disables only IDR auto-replies; receipt ingestion must keep running.
export function appsScriptConfig(env = process.env) {
  const deploymentId = env.GOOGLE_APPS_SCRIPT_DEPLOYMENT_ID?.trim();
  if (!deploymentId) return null;
  const functionName = env.GOOGLE_APPS_SCRIPT_FUNCTION?.trim() || DEFAULT_FUNCTION;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(functionName)) {
    throw new Error('Invalid GOOGLE_APPS_SCRIPT_FUNCTION');
  }
  return { deploymentId, functionName };
}

function validateReply(reply) {
  if (!reply || typeof reply !== 'object') {
    throw new AppsScriptSendError('Invalid reply payload', 'rejected');
  }
  const sourceMessageId = typeof reply.sourceMessageId === 'string' ? reply.sourceMessageId.trim() : '';
  if (!sourceMessageId || /[\s\x00-\x1f\x7f]/.test(sourceMessageId)) {
    throw new AppsScriptSendError('Invalid sourceMessageId', 'rejected');
  }
  const displayName = typeof reply.displayName === 'string' ? reply.displayName.trim() : '';
  if (!displayName || !displayName.endsWith(' | FretGone') || /[\r\n]/.test(displayName)) {
    throw new AppsScriptSendError('Invalid displayName; expected "Name | FretGone"', 'rejected');
  }
  const body = typeof reply.body === 'string' ? reply.body : '';
  if (!body.trim() || body.includes('\0')) {
    throw new AppsScriptSendError('Invalid reply body', 'rejected');
  }
  const threadId = typeof reply.threadId === 'string' ? reply.threadId : '';
  if (!threadId) throw new AppsScriptSendError('Invalid threadId', 'rejected');
  return { sourceMessageId, displayName, body, threadId };
}

/**
 * Runs the Apps Script `sendIdrReply` function through the Apps Script API.
 * Reuses the caller's existing OAuth access token; it never sends through the
 * Gmail API directly and never omits the display name.
 */
export async function sendIdrReplyViaAppsScript(config, reply, deps) {
  if (!config || typeof config.deploymentId !== 'string' || !config.deploymentId) {
    throw new AppsScriptSendError('Invalid Apps Script configuration', 'rejected');
  }
  if (!deps || typeof deps.accessToken !== 'function' || typeof deps.request !== 'function') {
    throw new AppsScriptSendError('Invalid Apps Script transport', 'rejected');
  }

  const parameters = validateReply(reply);

  let token;
  try {
    token = await deps.accessToken();
  } catch (error) {
    throw new AppsScriptSendError(
      `Apps Script authorization failed before sending: ${error instanceof Error ? error.message : String(error)}`,
      'rejected',
    );
  }
  if (!token) {
    throw new AppsScriptSendError('Apps Script access token unavailable before sending', 'rejected');
  }

  let response;
  try {
    response = await deps.request(`${SCRIPT_API}/${encodeURIComponent(config.deploymentId)}:run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        function: config.functionName || DEFAULT_FUNCTION,
        parameters: [parameters.sourceMessageId, parameters.displayName, parameters.body],
        devMode: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AppsScriptSendError('Apps Script request failed; send outcome is unknown', 'unknown');
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {
      // The status alone is enough; do not mask the unknown outcome.
    }
    throw new AppsScriptSendError(
      `Apps Script HTTP ${response.status}${detail ? `: ${detail}` : ''}; send outcome is unknown`,
      'unknown',
      response.status,
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new AppsScriptSendError('Apps Script response could not be read; send outcome is unknown', 'unknown');
  }

  if (payload?.error) {
    const message = typeof payload.error.message === 'string' ? payload.error.message : 'Apps Script execution failed';
    throw new AppsScriptSendError(`${message}; send outcome is unknown`, 'unknown');
  }
  if (payload?.done !== true) {
    throw new AppsScriptSendError('Apps Script did not report completion; send outcome is unknown', 'unknown');
  }

  const result = payload?.response?.result;
  if (!result || result.accepted !== true || typeof result.threadId !== 'string' || !result.threadId) {
    throw new AppsScriptSendError('Apps Script returned an incomplete result; send outcome is unknown', 'unknown');
  }
  if (result.threadId !== parameters.threadId) {
    throw new AppsScriptSendError('Apps Script reply left the original thread; send outcome is unknown', 'unknown');
  }

  // GmailMessage.replyAll returns the original message for chaining, so its ID
  // is not a sent-message ID. Never surface one as verified; callers record a
  // null sent_message_id. A separately verified ID may be added later.
  return { accepted: true, threadId: result.threadId };
}
