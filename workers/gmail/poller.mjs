import { OAuth2Client } from 'google-auth-library';
import postgres from 'postgres';
import { buildIdrReply, composeReply } from './reply.mjs';

const required = (name) => { const v = process.env[name]?.trim(); if (!v) throw new Error(`Missing ${name}`); return v; };
const mailbox = (process.env.GOOGLE_GMAIL_WATCHED_ADDRESS || 'contact@fretgone.com').trim().toLowerCase();
const oauth = new OAuth2Client(required('GOOGLE_GMAIL_CLIENT_ID'), required('GOOGLE_GMAIL_CLIENT_SECRET'));
oauth.setCredentials({ refresh_token: required('GOOGLE_GMAIL_REFRESH_TOKEN') });
const sql = postgres(required('POSTGRES_URL'), { max: 1, idle_timeout: 0 });
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; });

async function api(path) {
  const { token } = await oauth.getAccessToken();
  if (!token) throw new Error('Gmail access token unavailable');
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) { const e = new Error(`Gmail API ${response.status}`); e.status = response.status; throw e; }
  return response.json();
}
const decode = (v) => Buffer.from(v || '', 'base64url').toString('utf8');
async function bodyOf(part, messageId) {
  if (!part || part.filename) return '';
  const children = part.parts || [];
  const plain = children.filter(p => p.mimeType?.toLowerCase() === 'text/plain');
  const selected = plain.length ? plain : children;
  if (selected.length) return (await Promise.all(selected.map(p => bodyOf(p, messageId)))).filter(Boolean).join('\n');
  let data = part.body?.data;
  if (!data && part.body?.attachmentId && part.mimeType?.toLowerCase().startsWith('text/')) {
    data = (await api(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`)).data;
  }
  const text = decode(data);
  return part.mimeType?.toLowerCase() === 'text/html' ? text.replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').trim() : text;
}
async function saveMessage(db, id, enableReply = false) {
  let m;
  try { m = await api(`/messages/${encodeURIComponent(id)}?format=full`); } catch (e) { if (e.status === 404) { console.warn('Message no longer available', id); return; } throw e; }
  if ((m.labelIds || []).some(x => x === 'SENT' || x === 'DRAFT')) return;
  const h = new Map((m.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value]));
  const body = await bodyOf(m.payload, id);
  const to = h.get('to') || null, cc = h.get('cc') || null;
  await db`insert into fretgone.gmail_inbound_email (gmail_message_id,gmail_thread_id,history_id,received_at,sender,recipients,subject,body,body_truncated,to_header,cc_header)
    values (${m.id},${m.threadId || null},${m.historyId || '0'},${m.internalDate ? new Date(Number(m.internalDate)) : null},${h.get('from') || null},${db.array([to,cc].filter(Boolean))}::text[],${h.get('subject') || ''},${body},false,${to},${cc}) on conflict (gmail_message_id) do nothing`;
  if (!enableReply || !/\b(?:internal dispute resolution|idr)\b/i.test(body)) return null;
  const reply = buildIdrReply(m, mailbox);
  if (!reply) return null;
  const claimed = await db`insert into fretgone.gmail_idr_auto_reply (gmail_thread_id, source_message_id, status) values (${reply.threadId}, ${m.id}, 'sending') on conflict do nothing returning gmail_thread_id`;
  return claimed.length ? reply : null;
}
async function sendIdrReply(reply) {
  try {
    const { token } = await oauth.getAccessToken();
    if (!token) throw new Error('Gmail access token unavailable');
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw: composeReply(reply), threadId: reply.threadId }), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Gmail send HTTP ${response.status}`);
    const data = await response.json();
    if (!data.id || data.threadId !== reply.threadId) throw new Error('Gmail returned an incomplete or mismatched reply');
    await sql`update fretgone.gmail_idr_auto_reply set status='sent',sent_message_id=${data.id},updated_at=now() where gmail_thread_id=${reply.threadId}`;
    console.log('IDR reply sent', data.id);
  } catch (e) {
    console.error('IDR reply needs review; will not retry automatically:', e.message);
    await sql`update fretgone.gmail_idr_auto_reply set status='unknown',updated_at=now() where gmail_thread_id=${reply.threadId}`;
  }
}
async function profile() {
  const p = await api('/profile');
  if (p.emailAddress?.toLowerCase() !== mailbox || !p.historyId) throw new Error('Authenticated Gmail mailbox does not match configuration');
  return p.historyId;
}
async function fullSync(db) {
  // Capture cursor before listing so changes during the scan are replayed next poll.
  const start = await profile();
  let token;
  do {
    const q = new URLSearchParams({ maxResults: '500', q: '-in:sent -in:drafts' });
    if (token) q.set('pageToken', token);
    const page = await api(`/messages?${q}`);
    for (const m of page.messages || []) { if (stopping) throw new Error('Stopping during full sync'); await saveMessage(db, m.id); }
    token = page.nextPageToken;
  } while (token);
  return start;
}
async function tick() {
  // Transaction-scoped locking also works with transaction-mode connection pools.
  const replies = [];
  await sql.begin(async db => {
    const [{ locked }] = await db`select pg_try_advisory_xact_lock(hashtext('fretgone-gmail-poller'), hashtext(${mailbox})) as locked`;
    if (!locked) return;
    const rows = await db`select history_id from fretgone.gmail_poll_state where mailbox=${mailbox}`;
    if (!rows.length) {
      const id = await profile();
      await db`insert into fretgone.gmail_poll_state (mailbox,history_id) values (${mailbox},${id}) on conflict do nothing`;
      console.log('Gmail polling baseline established');
      return;
    }
    const cursor = rows[0].history_id;
    let token, newest = cursor;
    const ids = new Set();
    try {
      do {
        const q = new URLSearchParams({ startHistoryId: cursor, historyTypes: 'messageAdded', maxResults: '500' });
        if (token) q.set('pageToken', token);
        const page = await api(`/history?${q}`);
        newest = page.historyId || newest;
        for (const h of page.history || []) for (const item of h.messagesAdded || []) if (item.message?.id) ids.add(item.message.id);
        token = page.nextPageToken;
      } while (token);
    } catch (e) {
      if (e.status !== 404) throw e;
      console.warn('Gmail history expired; full mailbox resync started');
      newest = await fullSync(db);
      await db`update fretgone.gmail_poll_state set history_id=${newest},updated_at=now() where mailbox=${mailbox}`;
      console.log('Gmail full resync completed');
      return;
    }
    for (const id of ids) { if (stopping) throw new Error('Stopping before cursor update'); const reply = await saveMessage(db, id, true); if (reply) replies.push(reply); }
    await db`update fretgone.gmail_poll_state set history_id=${newest},updated_at=now() where mailbox=${mailbox}`;
    if (ids.size) console.log(`Gmail processed ${ids.size} changed messages`);
  });
  for (const reply of replies) await sendIdrReply(reply);
}
let failures = 0;
while (!stopping) {
  try { await tick(); failures = 0; } catch (e) { failures++; console.error('Gmail polling failed:', e.message); }
  if (!stopping) await new Promise(resolve => setTimeout(resolve, failures ? Math.min(300000, 15000 * 2 ** Math.min(failures - 1, 5)) : 15000));
}
await sql.end({ timeout: 10 });
