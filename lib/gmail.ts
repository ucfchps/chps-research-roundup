// Gmail API transport for the Scholar-alert ingester. Plain fetch — no
// googleapis SDK dependency, same reasoning as lib/ai.ts and lib/crossref.ts:
// we use four endpoints (OAuth token exchange, messages.list, messages.get,
// messages.modify) of a REST API, not enough surface to justify an SDK.
import { fetchWithRetry } from "./http";

export class GmailUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GmailUnavailableError";
  }
}

export interface GmailMessagePart {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload: GmailMessagePart;
  internalDate?: string;
}

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_SAFETY_MARGIN_MS = 60_000;

let cachedToken: { token: string; expiresAt: number } | null = null;

// Test-only escape hatch — mirrors the in-process cache being a module-level
// singleton, which would otherwise leak state between test cases.
export function __resetTokenCacheForTests(): void {
  cachedToken = null;
}

async function gmailFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetchWithRetry(url, init);
  } catch (err) {
    throw new GmailUnavailableError("Gmail request failed after exhausting retries", { cause: err });
  }
  if (!res.ok) throw new GmailUnavailableError(`Gmail request returned ${res.status}`);
  return res;
}

export async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN must be set (see .env.example)");
  }

  const res = await gmailFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 - TOKEN_SAFETY_MARGIN_MS };
  return cachedToken.token;
}

export interface ListMessagesOptions {
  maxResults?: number; // per-page size hint; default 100
}

// Follows nextPageToken to the end — a job that silently reads only page 1
// is the roster-truncation bug from Session 4 wearing a different hat.
// Capped at SCHOLAR_INGEST_MAX_EMAILS as a hard backstop.
export async function listMessages(query: string, opts: ListMessagesOptions = {}): Promise<string[]> {
  const cap = Number(process.env.SCHOLAR_INGEST_MAX_EMAILS ?? "200");
  const perPage = opts.maxResults ?? 100;
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const token = await getAccessToken();
    const url = new URL(`${GMAIL_BASE}/messages`);
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", String(Math.min(perPage, cap - ids.length)));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await gmailFetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const json = (await res.json()) as { messages?: { id: string }[]; nextPageToken?: string };
    for (const m of json.messages ?? []) ids.push(m.id);
    pageToken = json.nextPageToken;
  } while (pageToken && ids.length < cap);

  return ids.slice(0, cap);
}

export async function getMessage(id: string): Promise<GmailMessage> {
  const token = await getAccessToken();
  const res = await gmailFetch(`${GMAIL_BASE}/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await res.json()) as GmailMessage;
}

export async function applyLabel(id: string, labelId: string): Promise<void> {
  const token = await getAccessToken();
  await gmailFetch(`${GMAIL_BASE}/messages/${id}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds: [labelId] }),
  });
}

export interface SendMessageInput {
  to: string;
  from: string;
  replyTo: string;
  subject: string;
  body: string; // plain text
}

// MIME encoded-word (RFC 2047) — a faculty display_name can carry diacritics
// (this roster includes names like "Étoilé"), and a raw UTF-8 Subject header
// is not valid RFC 2822.
function encodeSubject(subject: string): string {
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
}

function buildRawMessage(input: SendMessageInput): string {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Reply-To: ${input.replyTo}`,
    `Subject: ${encodeSubject(input.subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
  ].join("\r\n");
  const message = `${headers}\r\n\r\n${input.body}`;
  return Buffer.from(message, "utf-8").toString("base64url");
}

// §8b "The email" — sent via the same OAuth flow as the read/label calls
// above (one Gmail client module, per this codebase's per-API-module
// convention). Throws GmailUnavailableError on failure rather than
// swallowing it — the caller (the campaign loop) is responsible for
// catching per-recipient so one bad address doesn't abort the batch.
export async function sendMessage(input: SendMessageInput): Promise<void> {
  const token = await getAccessToken();
  const raw = buildRawMessage(input);
  await gmailFetch(`${GMAIL_BASE}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
}

function findPart(node: GmailMessagePart, mimeType: string): GmailMessagePart | null {
  if (node.mimeType === mimeType && node.body?.data) return node;
  for (const child of node.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

// ★ Prefer HTML over text/plain always — the plain-text part does not carry
// the footer href, and the footer href is the join key. No HTML part found
// anywhere in the tree → null, never guess from text/plain.
export function extractHtmlBody(message: GmailMessage): string | null {
  const htmlPart = findPart(message.payload, "text/html");
  if (!htmlPart?.body?.data) return null;
  return Buffer.from(htmlPart.body.data, "base64url").toString("utf-8");
}
