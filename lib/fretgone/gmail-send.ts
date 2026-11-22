import "server-only";

import { OAuth2Client } from "google-auth-library";

export type GmailOutgoingMessage = {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
};

export type GmailSendResult = { gmailMessageId: string; gmailThreadId: string };

/** An unknown outcome must be reconciled before another send is attempted. */
export class GmailSendError extends Error {
  constructor(message: string, readonly outcome: "rejected" | "unknown", readonly status?: number) {
    super(message);
    this.name = "GmailSendError";
  }
}

type Dependencies = { accessToken: () => Promise<string>; request: typeof fetch };

function addresses(values: string[], required: boolean): string {
  if ((required && values.length === 0) || values.length > 100) throw new Error("Invalid recipient count");
  return values.map((value) => {
    const address = value.trim();
    if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(address) || address.length > 254) {
      throw new Error("Invalid email address");
    }
    return address;
  }).join(",\r\n ");
}

function encodedSubject(subject: string): string {
  if (!subject.trim() || /[\r\n\x00-\x1f\x7f]/.test(subject) || subject.length > 998) throw new Error("Invalid email subject");
  // Encode UTF-8 in small RFC 2047 encoded words without splitting code points.
  const words: string[] = [];
  let chunk = "";
  for (const char of subject) {
    if (Buffer.byteLength(chunk + char, "utf8") > 30) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`);
  return words.join("\r\n ");
}

export function composeGmailMessage(message: GmailOutgoingMessage): string {
  const to = addresses(message.to, true);
  const cc = addresses(message.cc || [], false);
  if (!message.text.trim() || message.text.includes("\0")) throw new Error("Email body is empty or invalid");
  const body = Buffer.from(message.text.replace(/\r\n|\r|\n/g, "\r\n"), "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") || "";
  const mime = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodedSubject(message.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

async function accessToken(): Promise<string> {
  const { GOOGLE_GMAIL_CLIENT_ID: id, GOOGLE_GMAIL_CLIENT_SECRET: secret, GOOGLE_GMAIL_REFRESH_TOKEN: refresh } = process.env;
  if (!id?.trim() || !secret?.trim() || !refresh?.trim()) throw new Error("Gmail OAuth credentials are not configured");
  const oauth = new OAuth2Client(id.trim(), secret.trim());
  oauth.setCredentials({ refresh_token: refresh.trim() });
  const { token } = await oauth.getAccessToken();
  if (!token) throw new Error("Gmail access token unavailable");
  return token;
}

/** Server-only primitive. It never decides when, what, or to whom to send. */
export async function sendGmailMessage(message: GmailOutgoingMessage, deps: Dependencies = { accessToken, request: fetch }): Promise<GmailSendResult> {
  const raw = composeGmailMessage(message);
  const token = await deps.accessToken();
  let response: Response;
  try {
    response = await deps.request("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new GmailSendError("Gmail send outcome is unknown; check Sent before retrying", "unknown");
  }
  if (!response.ok) {
    const unknown = response.status >= 500 || response.status === 408;
    throw new GmailSendError(`Gmail send returned HTTP ${response.status}${unknown ? "; check Sent before retrying" : ""}`, unknown ? "unknown" : "rejected", response.status);
  }
  let result: { id?: string; threadId?: string };
  try { result = await response.json(); } catch { throw new GmailSendError("Gmail accepted the request but the result could not be read; check Sent before retrying", "unknown"); }
  if (!result.id || !result.threadId) throw new GmailSendError("Gmail returned an incomplete result; check Sent before retrying", "unknown");
  return { gmailMessageId: result.id, gmailThreadId: result.threadId };
}
