import assert from 'node:assert/strict';
import { appsScriptConfig, AppsScriptSendError, sendIdrReplyViaAppsScript } from './apps-script.mjs';

const config = { deploymentId: 'deployment-1', functionName: 'sendIdrReply' };
const reply = {
  sourceMessageId: 'source-1',
  displayName: 'Daniel | FretGone',
  body: 'test idr',
  threadId: 'thread-1',
};

assert.deepEqual(appsScriptConfig({ GOOGLE_APPS_SCRIPT_DEPLOYMENT_ID: ' deployment-1 ' }), config);
assert.deepEqual(
  appsScriptConfig({ GOOGLE_APPS_SCRIPT_DEPLOYMENT_ID: 'deployment-1', GOOGLE_APPS_SCRIPT_FUNCTION: 'otherFunction' }),
  { deploymentId: 'deployment-1', functionName: 'otherFunction' },
);
// Missing optional Apps Script configuration disables replies; it must not
// throw and stop receipt ingestion.
assert.equal(appsScriptConfig({}), null);
// The old script-ID variable must not be accepted: scripts.run needs the
// deployment ID.
assert.equal(appsScriptConfig({ GOOGLE_APPS_SCRIPT_ID: 'script-1' }), null);
assert.throws(
  () => appsScriptConfig({ GOOGLE_APPS_SCRIPT_DEPLOYMENT_ID: 'deployment-1', GOOGLE_APPS_SCRIPT_FUNCTION: 'bad name' }),
  /Invalid GOOGLE_APPS_SCRIPT_FUNCTION/,
);

let captured;
let tokenCalls = 0;
const deps = {
  accessToken: async () => {
    tokenCalls++;
    return 'test-token';
  },
  request: async (url, init) => {
    captured = { url, init };
    return Response.json({
      done: true,
      response: { result: { accepted: true, threadId: 'thread-1' } },
    });
  },
};

const sent = await sendIdrReplyViaAppsScript(config, reply, deps);
assert.deepEqual(sent, { accepted: true, threadId: 'thread-1' });
// replyAll's return value is the original message, so no sent message ID may
// be reported even if a response contains one.
assert.equal('messageId' in sent, false);
assert.equal(tokenCalls, 1);
assert.equal(captured.url, 'https://script.googleapis.com/v1/scripts/deployment-1:run');
assert.equal(captured.init.method, 'POST');
assert.equal(captured.init.headers.authorization, 'Bearer test-token');
assert.deepEqual(JSON.parse(captured.init.body), {
  function: 'sendIdrReply',
  parameters: ['source-1', 'Daniel | FretGone', 'test idr'],
  devMode: false,
});

const ignoredMessageId = await sendIdrReplyViaAppsScript(config, reply, {
  ...deps,
  request: async () =>
    Response.json({
      done: true,
      response: { result: { accepted: true, threadId: 'thread-1', messageId: 'source-1' } },
    }),
});
assert.deepEqual(ignoredMessageId, { accepted: true, threadId: 'thread-1' });
assert.equal('messageId' in ignoredMessageId, false);

// Invalid configuration must be rejected before requesting a token or sending.
tokenCalls = 0;
await assert.rejects(
  sendIdrReplyViaAppsScript(null, reply, deps),
  (error) => error instanceof AppsScriptSendError && error.outcome === 'rejected',
);
await assert.rejects(
  sendIdrReplyViaAppsScript({ scriptId: 'script-1', functionName: 'sendIdrReply' }, reply, deps),
  (error) => error instanceof AppsScriptSendError && error.outcome === 'rejected',
);
// Invalid names must be rejected before requesting a token or sending.
await assert.rejects(
  sendIdrReplyViaAppsScript(config, { ...reply, displayName: 'Daniel' }, deps),
  (error) => error instanceof AppsScriptSendError && error.outcome === 'rejected',
);
await assert.rejects(
  sendIdrReplyViaAppsScript(config, { ...reply, displayName: '' }, deps),
  (error) => error instanceof AppsScriptSendError && error.outcome === 'rejected',
);
await assert.rejects(
  sendIdrReplyViaAppsScript(config, { ...reply, sourceMessageId: '' }, deps),
  (error) => error instanceof AppsScriptSendError && error.outcome === 'rejected',
);
await assert.rejects(
  sendIdrReplyViaAppsScript(config, { ...reply, body: '' }, deps),
  (error) => error instanceof AppsScriptSendError && error.outcome === 'rejected',
);
assert.equal(tokenCalls, 0);

const unknown = (error) => error instanceof AppsScriptSendError && error.outcome === 'unknown';
await assert.rejects(
  sendIdrReplyViaAppsScript(config, reply, { ...deps, request: async () => { throw new Error('timeout'); } }),
  unknown,
);
await assert.rejects(
  sendIdrReplyViaAppsScript(config, reply, { ...deps, request: async () => new Response('nope', { status: 500 }) }),
  unknown,
);
await assert.rejects(
  sendIdrReplyViaAppsScript(config, reply, { ...deps, request: async () => Response.json({ done: true, error: { message: 'boom' } }) }),
  unknown,
);
await assert.rejects(
  sendIdrReplyViaAppsScript(config, reply, { ...deps, request: async () => Response.json({ done: false }) }),
  unknown,
);
await assert.rejects(
  sendIdrReplyViaAppsScript(config, reply, { ...deps, request: async () => Response.json({ done: true, response: {} }) }),
  unknown,
);
// The old claimed sent-message shape is not proof of a sent ID and must not be
// accepted as a complete result.
await assert.rejects(
  sendIdrReplyViaAppsScript(
    config,
    reply,
    { ...deps, request: async () => Response.json({ done: true, response: { result: { messageId: 'source-1', threadId: 'thread-1' } } }) },
  ),
  unknown,
);
await assert.rejects(
  sendIdrReplyViaAppsScript(
    config,
    reply,
    { ...deps, request: async () => Response.json({ done: true, response: { result: { accepted: false, threadId: 'thread-1' } } }) },
  ),
  unknown,
);
await assert.rejects(
  sendIdrReplyViaAppsScript(
    config,
    reply,
    { ...deps, request: async () => Response.json({ done: true, response: { result: { accepted: true } } }) },
  ),
  unknown,
);
await assert.rejects(
  sendIdrReplyViaAppsScript(
    config,
    reply,
    { ...deps, request: async () => Response.json({ done: true, response: { result: { accepted: true, threadId: 'other-thread' } } }) },
  ),
  unknown,
);

await assert.rejects(
  sendIdrReplyViaAppsScript(config, reply, {
    accessToken: async () => { throw new Error('no token'); },
    request: deps.request,
  }),
  (error) => error instanceof AppsScriptSendError && error.outcome === 'rejected',
);

console.log('Apps Script request/response tests passed; no email was sent.');
