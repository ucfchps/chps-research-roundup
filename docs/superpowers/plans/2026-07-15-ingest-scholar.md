# ingest-scholar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 3 item 9 (§13) — the Scholar-alert ingester: Gmail API transport, a deterministic HTML parser for Scholar "new articles" alerts, a pure decision function that turns a parsed alert into a database action, and the orchestration script that ties Gmail → parser → Crossref (Session 6) → matching engine (Session 5) together, idempotently.

**Architecture:** Four new modules plus one migration. `lib/gmail.ts` is a thin fetch-based Gmail API client (token caching, pagination, MIME-tree walking). `lib/scholar-alert.ts` is a pure HTML parser (cheerio) that turns a raw alert email into a discriminated union — never a partially-trusted object. `lib/scholar-ingest.ts` is a pure decision function that composes the *existing* `lib/matching.ts` (`findMatch`/`mergeAuthors`/`mergeMetadata`) and `lib/crossref.ts` (already-resolved `CrossrefResolution` or already-caught error, passed in) into one of five `IngestOutcome` variants — it does no I/O itself. `scripts/ingest-scholar.ts` is the thin orchestrator that does all the I/O (Gmail, DB, Crossref calls) and calls into the two pure libraries.

**Tech Stack:** TypeScript, `@libsql/client` (Turso), `cheerio` (new dependency — justified in Task 3), `vitest`. Reuses `lib/crossref.ts`, `lib/matching.ts`, `lib/scholar.ts`, `lib/names.ts`, `lib/http.ts`, `lib/ai.ts` unmodified except the one deliberate addition noted in Task 2.

**Ground truth for this plan:** master plan §5a, §6, §7, §9, §13 item 9, §15.7/§15.8/§15.11; `docs/scholar-alert-notes.md` (all 9 sections); all 9 real + 1 synthetic fixtures in `tests/fixtures/scholar-alerts/`, inspected directly (not just described) before writing this plan — see the parsing algorithm in Task 4, which was prototyped against every fixture and produces the exact article counts/years documented in the notes file (4 articles for `alert-multi-real-vanryckeghem-citations` with years `2026,2026,2025,2025`; 1 article for every baseline fixture; 2 for the synthetic).

**Three deliberate design calls beyond the literal prompt text** (all three flagged again at the end for the user):
1. `findMatch` is applied to **both** the Crossref-resolved and Crossref-null-result branches (the prompt's prose only mentions it for the resolved branch). Skipping it on the null branch would let a re-run of the *same* email — the exact scenario §9 requires to be idempotent — insert a second `needs_metadata` row for the same title, which directly violates "the second run must produce zero new rows."
2. `findMatch`'s `NEEDS_FUZZY` result is treated as "no match" (never call `lib/matching-ai.ts`). The session prompt names four libraries to reuse and `lib/matching-ai.ts` isn't one of them; no fixture requires fuzzy matching to converge (the Schellhase/Mangum pair converges on an exact DOI match once both resolve through Crossref).
3. **★ Added after plan review, before execution:** decision #1 closes the exact-re-run duplicate case, but leaves a narrower gap — two co-authors' alerts for the *same* paper where one resolves via Crossref and the other legitimately doesn't (or resolves to a drifted title, §15.8's "acute compared to chronic" vs. "acute and chronic" case). The unresolved alert's raw Scholar title won't exact-match the other's Crossref-sourced `title_normalized`, so `findMatch` returns `NEEDS_FUZZY`, and under decision #2 that's "no match" — producing a second, duplicate `needs_metadata` row for an already-`pending_merge` paper. No fixture in this session exercises this (the Schellhase/Mangum pair resolves identically on both sides), but it's a real, cheap-to-mitigate gap. **Fix:** `decideArticleOutcome`'s `insert_needs_metadata` **and** `insert_resolved` branches both run a deterministic, non-AI token-overlap check against the full existing-title list and attach `possibleDuplicateOf: number[]` (publication ids) to the outcome when a loose match is found. Both directions matter symmetrically: an unresolved alert landing after a resolved one needs the flag (the original case), and — just as important, caught in plan review round 2 — a *resolved* alert landing after an earlier `needs_metadata` stub for the same paper needs it too, or that stub sits orphaned forever with nothing pointing back at it. It never blocks either insert and never merges automatically — it only surfaces in the run summary, the same way `discoveringFacultyNotLinked` already surfaces its own class of miss (§15.2, §15.11). See Task 5.

---

## Task 1: Migration `db/migrations/005_discovery_provenance.sql`

**Files:**
- Create: `db/migrations/005_discovery_provenance.sql`
- Modify: `lib/types.ts:50-68` (add the two new fields to the `Publication` interface)

The prompt calls this `003_discovery_provenance.sql`, but `003` and `004` are already taken (`003_metadata_mismatches.sql`, `004_metadata_mismatches_issue.sql` — see `db/migrations/`). Next free number is `005`.

- [ ] **Step 1: Write the migration**

```sql
-- Provenance for how a publication was first discovered via Scholar (§5a, §13
-- item 9). Provenance only — neither column is used to derive units, and
-- neither is ever rendered into a citation. discovered_by_faculty_id is
-- nullable because most publications are NOT Scholar-discovered (Crossref/
-- PubMed/ORCID/manual origin) and because a Scholar-discovered record whose
-- Crossref resolution failed still needs somewhere to point (see
-- needs_metadata handling in lib/scholar-ingest.ts).
ALTER TABLE publications ADD COLUMN discovered_by_faculty_id INTEGER REFERENCES faculty(id);
ALTER TABLE publications ADD COLUMN scholar_alert_url TEXT;
```

- [ ] **Step 2: Update the `Publication` interface in `lib/types.ts`**

In `lib/types.ts`, the `Publication` interface currently ends:

```ts
  released_at       TEXT,                 -- when it left the merge buffer
  roundup_id        INTEGER REFERENCES roundups(id),  -- ★ which roundup edition published this.
```

Wait — that's the SQL comment block, not the TS interface. The actual TS interface (`lib/types.ts:50-68`) is:

```ts
export interface Publication {
  id: number;
  doi: string | null;
  title: string;
  title_normalized: string;
  url: string;
  journal: string | null;
  year: number | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  status: PublicationStatus;
  source: PublicationSource;
  first_seen_at: string;
  date_added: string;
  released_at: string | null;
  roundup_id: number | null;
  created_at: string;
}
```

Add the two new fields after `roundup_id`:

```ts
export interface Publication {
  id: number;
  doi: string | null;
  title: string;
  title_normalized: string;
  url: string;
  journal: string | null;
  year: number | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  status: PublicationStatus;
  source: PublicationSource;
  first_seen_at: string;
  date_added: string;
  released_at: string | null;
  roundup_id: number | null;
  discovered_by_faculty_id: number | null;
  scholar_alert_url: string | null;
  created_at: string;
}
```

- [ ] **Step 3: Apply the migration against a throwaway local DB to confirm it runs cleanly**

```bash
node -e "
const { createClient } = require('@libsql/client');
const { runMigrations } = require('./db/migrate.ts');
" 2>&1 || true
```

Actually simplest: this is exercised for real by every test that calls `runMigrations` against a temp file DB (see Task 8's integration test, and the existing pattern in `tests/sync-roster.test.ts:79-83`). No standalone verification step needed — the first test file that runs migrations (Task 8) is the real check. Confirm the file is syntactically valid SQLite by eyeballing it against `004_metadata_mismatches_issue.sql`'s two-line `ALTER TABLE ... ADD COLUMN` shape, which it matches exactly.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/005_discovery_provenance.sql lib/types.ts
git commit -m "Add discovery-provenance columns for Scholar-discovered publications"
```

---

## Task 2: `lib/scholar.ts` — `unwrapGoogleRedirect`

**Files:**
- Modify: `lib/scholar.ts` (append)
- Test: `tests/scholar.test.ts` (append)

Per the session prompt point 2, this is defensive code for the footer join-key link: every real fixture's footer link is bare (`docs/scholar-alert-notes.md` §1), but the parser must still unwrap a redirect if one ever shows up.

- [ ] **Step 1: Write the failing tests** (append to `tests/scholar.test.ts`)

```ts
import { scholarUserId, unwrapGoogleRedirect } from "../lib/scholar";
```
(replace the existing `import { scholarUserId } from "../lib/scholar";` with the two-name import above)

```ts
describe("unwrapGoogleRedirect — real fixtures are already bare, never re-wrapped", () => {
  it("a bare Scholar profile URL passes through unchanged", () => {
    const url = "https://scholar.google.com/citations?hl=en&user=WfdV37IAAAAJ";
    expect(unwrapGoogleRedirect(url)).toBe(url);
  });
});

describe("unwrapGoogleRedirect — hand-constructed wrapper (no real fixture exercises this — docs/scholar-alert-notes.md §1)", () => {
  it("unwraps a google.com/url?q=... wrapper around a real Scholar profile URL", () => {
    const inner = "https://scholar.google.com/citations?hl=en&user=WfdV37IAAAAJ";
    const wrapped = `https://www.google.com/url?q=${encodeURIComponent(inner)}&sa=D`;
    expect(unwrapGoogleRedirect(wrapped)).toBe(inner);
  });

  it("unwraps a scholar_url?url=... wrapper", () => {
    const inner = "https://scholar.google.com/citations?hl=en&user=WfdV37IAAAAJ";
    const wrapped = `https://scholar.google.com/scholar_url?url=${encodeURIComponent(inner)}&hl=en`;
    expect(unwrapGoogleRedirect(wrapped)).toBe(inner);
  });

  it("recurses through a double-wrapped URL", () => {
    const inner = "https://scholar.google.com/citations?hl=en&user=WfdV37IAAAAJ";
    const onceWrapped = `https://scholar.google.com/scholar_url?url=${encodeURIComponent(inner)}`;
    const twiceWrapped = `https://www.google.com/url?q=${encodeURIComponent(onceWrapped)}`;
    expect(unwrapGoogleRedirect(twiceWrapped)).toBe(inner);
  });

  it("a non-wrapper URL is returned unchanged", () => {
    const url = "https://www.researchgate.net/profile/Kim_Gryglewicz";
    expect(unwrapGoogleRedirect(url)).toBe(url);
  });

  it("never throws on garbage input", () => {
    expect(() => unwrapGoogleRedirect("not a url")).not.toThrow();
    expect(unwrapGoogleRedirect("not a url")).toBe("not a url");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run tests/scholar.test.ts
```

Expected: `unwrapGoogleRedirect` is not exported — import/type error.

- [ ] **Step 3: Implement** (append to `lib/scholar.ts`)

```ts
const REDIRECT_WRAPPER_HOSTS = new Set(["google.com", "www.google.com", "scholar.google.com"]);
const REDIRECT_WRAPPER_PARAMS = ["url", "q"];
const MAX_UNWRAP_DEPTH = 5;

// Defensive: no real fixture in this inbox has ever shown a wrapped footer
// link (docs/scholar-alert-notes.md §1), but the directory could plausibly
// contain one. Never throws — always falls back to the input string.
export function unwrapGoogleRedirect(url: string, depth = 0): string {
  if (depth >= MAX_UNWRAP_DEPTH) return url;

  try {
    const parsed = new URL(url.trim());
    if (!REDIRECT_WRAPPER_HOSTS.has(parsed.hostname)) return url;

    for (const param of REDIRECT_WRAPPER_PARAMS) {
      const inner = parsed.searchParams.get(param);
      if (inner) return unwrapGoogleRedirect(inner, depth + 1);
    }
    return url;
  } catch {
    return url;
  }
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
npx vitest run tests/scholar.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add lib/scholar.ts tests/scholar.test.ts
git commit -m "Add defensive Google-redirect unwrapper ahead of the Scholar-alert parser"
```

---

## Task 3: Add `cheerio` and write `lib/gmail.ts`

**Files:**
- Modify: `package.json` (dependency)
- Create: `lib/gmail.ts`
- Test: `tests/gmail.test.ts`

**Dependency choice:** `cheerio` (already added to `node_modules` during planning-phase prototyping — confirm with `npm ls cheerio`, or run `npm install cheerio` if not present). Justification: cheerio's jQuery-style traversal (`.closest()`, `.next()`) is the natural fit for walking each article's own sibling block (title `<h3>` → byline `<div>` → optional snippet `<div>`) without over-matching into a neighboring article's blocks in a multi-article email — this was prototyped directly against all 10 fixtures (see Task 4) and correctly isolates each block. `node-html-parser` was the other candidate but lacks this ergonomic sibling API.

- [ ] **Step 1: `npm install cheerio` if not already present**

```bash
npm ls cheerio || npm install cheerio
```

- [ ] **Step 2: Write the failing tests** (`tests/gmail.test.ts`)

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.GMAIL_CLIENT_ID ??= "test-client-id";
process.env.GMAIL_CLIENT_SECRET ??= "test-client-secret";
process.env.GMAIL_REFRESH_TOKEN ??= "test-refresh-token";

const { getAccessToken, listMessages, getMessage, applyLabel, extractHtmlBody, GmailUnavailableError, __resetTokenCacheForTests } =
  await import("../lib/gmail");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  __resetTokenCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAccessToken", () => {
  it("exchanges the refresh token for an access token", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: 3600 }));

    const token = await getAccessToken();

    expect(token).toBe("tok-1");
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(String(init.body)).toContain("refresh_token=test-refresh-token");
  });

  it("caches the token in-process and does not re-mint it on a second call", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: 3600 }));

    await getAccessToken();
    await getAccessToken();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throws GmailUnavailableError on a 401", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("bad", { status: 401 }));

    await expect(getAccessToken()).rejects.toBeInstanceOf(GmailUnavailableError);
  });

  it("throws GmailUnavailableError on a 500 after exhausting retries", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("err", { status: 500 }));

    await expect(getAccessToken()).rejects.toBeInstanceOf(GmailUnavailableError);
  });
});

describe("listMessages", () => {
  it("follows nextPageToken to the end", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "a" }, { id: "b" }], nextPageToken: "page2" }))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "c" }] }));

    const ids = await listMessages("subject:test");

    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("caps at SCHOLAR_INGEST_MAX_EMAILS even if more pages are available", async () => {
    process.env.SCHOLAR_INGEST_MAX_EMAILS = "2";
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "a" }, { id: "b" }], nextPageToken: "page2" }));

    const ids = await listMessages("subject:test");

    expect(ids).toEqual(["a", "b"]);
    delete process.env.SCHOLAR_INGEST_MAX_EMAILS;
  });

  it("throws GmailUnavailableError on a 429 past the retry budget", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok", expires_in: 3600 }))
      .mockResolvedValue(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }));

    await expect(listMessages("subject:test")).rejects.toBeInstanceOf(GmailUnavailableError);
  });
});

describe("getMessage", () => {
  it("fetches a single message with format=full", async () => {
    const message = { id: "m1", threadId: "t1", payload: { mimeType: "text/html", headers: [], body: { data: "" } } };
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(message));

    const result = await getMessage("m1");

    expect(result.id).toBe("m1");
    const [url] = vi.mocked(fetch).mock.calls[1] as [string];
    expect(url).toContain("/messages/m1?format=full");
  });
});

describe("applyLabel", () => {
  it("POSTs addLabelIds to the modify endpoint", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({}));

    await applyLabel("m1", "Label_1");

    const [url, init] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    expect(url).toContain("/messages/m1/modify");
    expect(JSON.parse(String(init.body))).toEqual({ addLabelIds: ["Label_1"] });
  });
});

describe("extractHtmlBody", () => {
  it("decodes a flat text/html payload (the shape every real fixture uses)", () => {
    const html = "<p>hello</p>";
    const data = Buffer.from(html, "utf-8").toString("base64url");
    const message = { id: "m1", threadId: "t1", payload: { mimeType: "text/html", headers: [], body: { data } } };

    expect(extractHtmlBody(message)).toBe(html);
  });

  it("walks a nested multipart/alternative tree and prefers html over text/plain", () => {
    const plainData = Buffer.from("plain text version", "utf-8").toString("base64url");
    const htmlData = Buffer.from("<p>html version</p>", "utf-8").toString("base64url");
    const message = {
      id: "m1",
      threadId: "t1",
      payload: {
        mimeType: "multipart/alternative",
        headers: [],
        parts: [
          { mimeType: "text/plain", headers: [], body: { data: plainData } },
          { mimeType: "text/html", headers: [], body: { data: htmlData } },
        ],
      },
    };

    expect(extractHtmlBody(message)).toBe("<p>html version</p>");
  });

  it("returns null when there is no HTML part at all", () => {
    const plainData = Buffer.from("plain only", "utf-8").toString("base64url");
    const message = {
      id: "m1",
      threadId: "t1",
      payload: { mimeType: "text/plain", headers: [], body: { data: plainData } },
    };

    expect(extractHtmlBody(message)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to confirm failure**

```bash
npx vitest run tests/gmail.test.ts
```

Expected: `../lib/gmail` module not found.

- [ ] **Step 4: Implement `lib/gmail.ts`**

```ts
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
```

- [ ] **Step 5: Run to confirm pass**

```bash
npx vitest run tests/gmail.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/gmail.ts tests/gmail.test.ts
git commit -m "Add Gmail API transport (lib/gmail.ts) for the Scholar-alert ingester"
```

---

## Task 4: `lib/scholar-alert.ts` — the deterministic parser

**Files:**
- Create: `lib/scholar-alert.ts`
- Test: `tests/scholar-alert.test.ts`

This is the parser described in the session prompt point 2. The DOM-walking algorithm below was prototyped directly against all 10 fixtures during planning and produces exactly the article counts and years documented in `docs/scholar-alert-notes.md` §6 (4 articles, years `2026,2026,2025,2025`, for `alert-multi-real-vanryckeghem-citations`) and §4 (1 article each for the Schellhase/Mangum pair, with/without a snippet block respectively).

**Structural facts this code relies on** (verified against every fixture file directly, not inferred):
- Each article is a `<h3>` containing an `<a class="gse_alrt_title" href="...">Title</a>`, optionally preceded by a `<span>[CITATION]</span>` or `[PDF]` tag inside the same `<h3>`.
- The `<h3>`'s **next sibling** is always a `<div style="color:#006621;...">` byline ending in a 4-digit year (`"MJ Kolber, WJ Hanney - Physiotherapy Theory and Practice, 2026"` or, for `[CITATION]`-tagged blocks with no journal, `"G Vanryckeghem, M. & Brutten - 2026"`).
- When a snippet is present, it is the byline's **next sibling**, `<div class="gse_alrt_sni">`. `[CITATION]`-tagged blocks have no snippet at all — the byline's next sibling is `<br>` or the next article's `<h3>` instead.
- The footer paragraph contains the literal string `"This message was sent by Google Scholar"`, and (on every real "new articles" alert) also `"written by"`, followed by exactly one `<a href="https://scholar.google.com/citations?...user=...">Name</a>`.
- Using a real CSS-selector engine (`a.gse_alrt_title`) rather than a raw-HTML string search means the `<style>` block's `.gse_alrt_title{...}` CSS rule is never miscounted as a fourth article — cheerio only matches actual DOM elements carrying `class="gse_alrt_title"`.

- [ ] **Step 1: Write the failing tests** (`tests/scholar-alert.test.ts`)

```ts
// Ground truth: docs/scholar-alert-notes.md (all sections) and every fixture in
// tests/fixtures/scholar-alerts/. See master plan §5a. No network — pure parser.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAlertEmail } from "../lib/scholar-alert";

function fixtureHtml(name: string): string {
  return readFileSync(path.join(__dirname, "fixtures", "scholar-alerts", `${name}.decoded.html`), "utf-8");
}

describe("parseAlertEmail — real fixtures", () => {
  it("alert-multi-real-vanryckeghem-citations: all 4 articles, own title+year each, not 1 and not a CSS-inflated count", () => {
    const result = parseAlertEmail(
      fixtureHtml("alert-multi-real-vanryckeghem-citations"),
      "Martine Vanryckeghem - new articles"
    );

    if (result.kind !== "articles") throw new Error(`expected articles, got ${JSON.stringify(result)}`);
    expect(result.scholarUserId).toBe("qK9t_4EAAAAJ");
    expect(result.displayName).toBe("Martine Vanryckeghem");
    expect(result.articles).toHaveLength(4);
    expect(result.articles.map((a) => a.title)).toEqual([
      "Behavior Assessment Battery for Children and Adolescents who Stutter",
      "Behavior Assessment Battery voor Kinderen en Jongeren die Stotteren",
      "Behavior Assessment Battery for Adults who Stutter",
      "KiddyCAT: Communication Attitude Test for French Preschoolers who Stutter. Hogrefe, France",
    ]);
    expect(result.articles.map((a) => a.year)).toEqual([2026, 2026, 2025, 2025]);
  });

  it("the two deliberately near-duplicate titles in that fixture stay as separate entries — no collapsing at this layer", () => {
    const result = parseAlertEmail(
      fixtureHtml("alert-multi-real-vanryckeghem-citations"),
      "Martine Vanryckeghem - new articles"
    );
    if (result.kind !== "articles") throw new Error("expected articles");

    const titles = result.articles.map((a) => a.title);
    expect(new Set(titles).size).toBe(4); // all 4 distinct, none merged
  });

  it("pair-citation-tag-schellhase: [CITATION]-tagged, no-snippet template parses successfully", () => {
    const result = parseAlertEmail(fixtureHtml("pair-citation-tag-schellhase"), "Kristen Couper Schellhase - new articles");

    if (result.kind !== "articles") throw new Error(`expected articles, got ${JSON.stringify(result)}`);
    expect(result.scholarUserId).toBe("ez1ilMIAAAAJ");
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0].title).toBe(
      "Exploring Job Satisfaction and Intention to Leave Among Athletic Trainers Working With Tactical Athletes in Military Clinical Practice Settings"
    );
    expect(result.articles[0].year).toBe(2026);
    expect(result.articles[0].snippet).toBeNull();
  });

  it("pair-normal-tag-mangum: normal-tagged variant of the SAME underlying paper parses successfully, with a snippet", () => {
    const result = parseAlertEmail(fixtureHtml("pair-normal-tag-mangum"), "L. Colby Mangum, PhD, ATC - new articles");

    if (result.kind !== "articles") throw new Error(`expected articles, got ${JSON.stringify(result)}`);
    expect(result.scholarUserId).toBe("5yIzMuQAAAAJ");
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0].title).toBe(
      "Exploring Job Satisfaction and Intention to Leave Among Athletic Trainers Working With Tactical Athletes in Military Clinical Practice Settings"
    );
    expect(result.articles[0].snippet).not.toBeNull();
  });

  it.each([
    ["alert-single-hanney-olecranon", "WfdV37IAAAAJ"],
    ["alert-single-stock-limbdisuse", "hs_VC0kAAAAJ"],
    ["alert-single-fukuda-bioimpedance", "xHh28EYAAAAJ"],
    ["alert-single-norte-acl", "z_Rs1EcAAAAJ"],
    ["alert-single-backes-polyvictimization", "AnyUZ0MAAAAJ"],
    ["alert-nonlatin-title-stout", "UKQpz6UAAAAJ"],
  ])("%s: footer href yields the correct case-sensitive Scholar user ID", (fixture, expectedId) => {
    const result = parseAlertEmail(fixtureHtml(fixture), "irrelevant for this assertion - new articles");
    if (result.kind !== "articles") throw new Error(`expected articles, got ${JSON.stringify(result)}`);
    expect(result.scholarUserId).toBe(expectedId);
  });

  it("alert-nonlatin-title-stout: non-Latin title passed through verbatim, not transliterated", () => {
    const result = parseAlertEmail(fixtureHtml("alert-nonlatin-title-stout"), "Jeffrey R Stout - new articles");
    if (result.kind !== "articles") throw new Error("expected articles");
    expect(result.articles[0].title).toBe("痛みの定量化: 運動科学における疼痛評価の方法論的レビュー");
    expect(result.articles[0].year).toBe(2026);
  });

  it("alert-multi-synthetic: 2 articles, real + hand-built", () => {
    const result = parseAlertEmail(fixtureHtml("alert-multi-synthetic"), "William J. Hanney - new articles");
    if (result.kind !== "articles") throw new Error("expected articles");
    expect(result.articles).toHaveLength(2);
    expect(result.articles[1].title).toContain("[SYNTHETIC FIXTURE]");
  });
});

describe("parseAlertEmail — rejection rules (§5a.2, §15.8)", () => {
  it("no HTML part is never reached by this function — extractHtmlBody (lib/gmail.ts) returns null upstream, and the caller skips before calling parseAlertEmail", () => {
    // Documented here rather than tested here: parseAlertEmail's contract starts
    // from an already-extracted HTML string. See tests/gmail.test.ts for the
    // "no HTML part -> null" case this depends on.
    expect(true).toBe(true);
  });

  it("★ synthetic citation-alert-shaped footer (no real example exists in this inbox — confirmed in docs/scholar-alert-notes.md §9) is rejected", () => {
    const html = `<html><body>
      <h3><a class="gse_alrt_title" href="https://example.org/some-article">Some Citing Paper</a></h3>
      <div style="color:#006621">A Stranger, B Someone - Some Journal, 2026</div>
      <p>This message was sent by Google Scholar because new citations to articles by
      <a href="https://scholar.google.com/citations?hl=en&user=hs_VC0kAAAAJ">Matt S. Stock</a> were found.</p>
    </body></html>`;

    const result = parseAlertEmail(html, "Matt S. Stock - new citations");

    expect(result).toEqual({
      kind: "rejected",
      reason: "citation_alert",
      detail: expect.any(String),
    });
  });

  it("no footer at all is rejected as no_footer", () => {
    const html = `<html><body>
      <h3><a class="gse_alrt_title" href="https://example.org/a">A Paper</a></h3>
      <div style="color:#006621">Author - Journal, 2026</div>
    </body></html>`;

    const result = parseAlertEmail(html, "Someone - new articles");

    expect(result).toEqual({ kind: "rejected", reason: "no_footer", detail: expect.any(String) });
  });

  it("a footer whose link has no user param is rejected as no_scholar_id, never falls back to the subject-line name", () => {
    const html = `<html><body>
      <h3><a class="gse_alrt_title" href="https://example.org/a">A Paper</a></h3>
      <div style="color:#006621">Author - Journal, 2026</div>
      <p>This message was sent by Google Scholar because you're following new articles written by
      <a href="https://scholar.google.com/citations?hl=en">Someone Ambiguous</a>.</p>
    </body></html>`;

    const result = parseAlertEmail(html, "Someone Ambiguous - new articles");

    expect(result).toEqual({ kind: "rejected", reason: "no_scholar_id", detail: expect.any(String) });
  });

  it("a valid footer with zero article blocks is rejected as no_articles", () => {
    const html = `<html><body>
      <p>This message was sent by Google Scholar because you're following new articles written by
      <a href="https://scholar.google.com/citations?hl=en&user=hs_VC0kAAAAJ">Matt S. Stock</a>.</p>
    </body></html>`;

    const result = parseAlertEmail(html, "Matt S. Stock - new articles");

    expect(result).toEqual({ kind: "rejected", reason: "no_articles", detail: expect.any(String) });
  });
});

describe("parseAlertEmail — the parser exposes no author-list or journal field (§5a.6, §15.7)", () => {
  it("ParsedArticle has exactly title, year, scholarUrl, snippet — a future edit that adds authors/journal fails this", () => {
    const result = parseAlertEmail(fixtureHtml("alert-single-hanney-olecranon"), "William J. Hanney - new articles");
    if (result.kind !== "articles") throw new Error("expected articles");

    const keys = Object.keys(result.articles[0]).sort();
    expect(keys).toEqual(["scholarUrl", "snippet", "title", "year"]);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run tests/scholar-alert.test.ts
```

Expected: `../lib/scholar-alert` module not found.

- [ ] **Step 3: Implement `lib/scholar-alert.ts`**

```ts
// Deterministic Scholar-alert HTML parser. Pure — no I/O in the primary
// (deterministic) path. See master plan §5a and docs/scholar-alert-notes.md.
// The AI fallback (session prompt point 2, last paragraph) lives in a
// separate async function below, kept apart from this pure core the same
// way lib/matching.ts (pure) and lib/matching-ai.ts (I/O) are split.
import * as cheerio from "cheerio";
import { scholarUserId, unwrapGoogleRedirect } from "./scholar";
import { AIUnavailableError, callAIJson } from "./ai";

export interface ParsedArticle {
  title: string;
  year: number | null;
  scholarUrl: string | null;
  snippet: string | null;
}

export type ParsedAlert =
  | { kind: "articles"; scholarUserId: string; displayName: string; articles: ParsedArticle[] }
  | { kind: "rejected"; reason: "citation_alert" | "no_footer" | "no_scholar_id" | "no_articles"; detail: string };

function extractYear(bylineText: string): number | null {
  const match = bylineText.match(/(\d{4})\s*$/);
  return match ? Number(match[1]) : null;
}

// One block per <h3><a class="gse_alrt_title">...</a></h3>. Using cheerio's
// selector engine (not a raw-HTML regex/grep) means the .gse_alrt_title CSS
// rule inside <style> is never miscounted as an article — cheerio only
// matches real DOM elements with class="gse_alrt_title" (§5a rule 5,
// docs/scholar-alert-notes.md §6).
function extractArticlesDeterministic($: cheerio.CheerioAPI): ParsedArticle[] {
  const articles: ParsedArticle[] = [];

  $("a.gse_alrt_title").each((_, el) => {
    const $a = $(el);
    const title = $a.text().trim();
    const scholarUrl = $a.attr("href") ?? null;
    if (!title) return;

    const $h3 = $a.closest("h3");
    const $byline = $h3.next();
    const year = extractYear($byline.text());

    const $afterByline = $byline.next();
    const snippet = $afterByline.hasClass("gse_alrt_sni") ? $afterByline.text().trim() : null;

    articles.push({ title, year, scholarUrl, snippet });
  });

  return articles;
}

function findFooter($: cheerio.CheerioAPI): ReturnType<cheerio.CheerioAPI> | null {
  const footer = $("p").filter((_, el) => $(el).text().includes("This message was sent by Google Scholar"));
  return footer.length > 0 ? footer.first() : null;
}

// The synchronous, deterministic core. This is the "pure, no I/O" contract
// from the session prompt — the AI escape hatch is a separate function below.
export function parseAlertEmail(html: string, _subject: string): ParsedAlert {
  const $ = cheerio.load(html);

  const $footer = findFooter($);
  if (!$footer) {
    return { kind: "rejected", reason: "no_footer", detail: "no paragraph containing the Google Scholar sender line was found" };
  }

  const footerText = $footer.text();
  // §5a rule 2 / §15.8: the Gmail query already excludes "new citations"
  // alerts server-side, and this inbox has never actually received one
  // (docs/scholar-alert-notes.md §9) — assert the exclusion again anyway.
  if (!footerText.includes("written by")) {
    return { kind: "rejected", reason: "citation_alert", detail: `footer does not contain "written by": "${footerText.trim()}"` };
  }

  const $footerLink = $footer.find("a").first();
  const href = $footerLink.attr("href");
  if (!href) {
    return { kind: "rejected", reason: "no_footer", detail: "footer contains no link to unwrap" };
  }

  // §5a.3 — never fall back to the subject line name as the join key.
  const id = scholarUserId(unwrapGoogleRedirect(href));
  if (!id) {
    return { kind: "rejected", reason: "no_scholar_id", detail: `footer link did not yield a Scholar user ID: ${href}` };
  }

  const displayName = $footerLink.text().trim();
  const articles = extractArticlesDeterministic($);

  if (articles.length === 0) {
    return { kind: "rejected", reason: "no_articles", detail: "footer was valid but zero article blocks were found deterministically" };
  }

  return { kind: "articles", scholarUserId: id, displayName, articles };
}

interface AiExtractedArticle {
  title: string;
  year: number | null;
}

// §15.2 — deterministic first, AI second. Only reached when
// parseAlertEmail returned rejected: 'no_articles' with an otherwise-valid
// footer. No real fixture in this inbox needs this path (every real and
// synthetic fixture is extracted deterministically — see tests/scholar-alert.test.ts).
export async function parseAlertEmailWithAiFallback(html: string, subject: string): Promise<ParsedAlert> {
  const deterministic = parseAlertEmail(html, subject);
  if (deterministic.kind !== "rejected" || deterministic.reason !== "no_articles") return deterministic;

  const $ = cheerio.load(html);
  const $footer = findFooter($)!;
  const $footerLink = $footer.find("a").first();
  const id = scholarUserId(unwrapGoogleRedirect($footerLink.attr("href") ?? ""));
  if (!id) return deterministic; // shouldn't happen (parseAlertEmail already validated this), fail closed anyway

  try {
    const extracted = await callAIJson<{ articles: AiExtractedArticle[] }>({
      appName: "research-roundup",
      taskType: "parse_scholar_alert",
      prompt: [
        "Extract every distinct article title and publication year from this Google Scholar alert email HTML.",
        "Return ONLY title and year for each — never authors, never journal name.",
        "",
        html,
      ].join("\n"),
    });

    const articles: ParsedArticle[] = (extracted.articles ?? [])
      .filter((a) => a.title)
      .map((a) => ({ title: a.title, year: a.year ?? null, scholarUrl: null, snippet: null }));

    if (articles.length === 0) return deterministic;

    return { kind: "articles", scholarUserId: id, displayName: $footerLink.text().trim(), articles };
  } catch (err) {
    if (err instanceof AIUnavailableError) return deterministic; // skip and report, never guess
    throw err;
  }
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
npx vitest run tests/scholar-alert.test.ts
```

- [ ] **Step 5: Add one AI-fallback test** (append to `tests/scholar-alert.test.ts`)

```ts
describe("parseAlertEmailWithAiFallback — only reached when deterministic extraction finds zero articles", () => {
  it("degrades to the original rejection when AI is unavailable, never guesses", async () => {
    process.env.AI_PROVIDER = "groq";
    process.env.AI_MODEL = "openai/gpt-oss-120b";
    delete process.env.GROQ_API_KEY; // forces AIUnavailableError

    const html = `<html><body>
      <p>This message was sent by Google Scholar because you're following new articles written by
      <a href="https://scholar.google.com/citations?hl=en&user=hs_VC0kAAAAJ">Matt S. Stock</a>.</p>
    </body></html>`;

    const { parseAlertEmailWithAiFallback } = await import("../lib/scholar-alert");
    const result = await parseAlertEmailWithAiFallback(html, "Matt S. Stock - new articles");

    expect(result).toEqual({ kind: "rejected", reason: "no_articles", detail: expect.any(String) });
  });
});
```

- [ ] **Step 6: Run full file, confirm pass**

```bash
npx vitest run tests/scholar-alert.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add lib/scholar-alert.ts tests/scholar-alert.test.ts
git commit -m "Add deterministic Scholar-alert parser with AI fallback escape hatch"
```

---

## Task 5: `lib/scholar-ingest.ts` — the pure decision function

**Files:**
- Create: `lib/scholar-ingest.ts`
- Test: `tests/scholar-ingest.test.ts`

Composes `lib/matching.ts`'s `findMatch`/`mergeAuthors`/`mergeMetadata` (Session 5, unmodified) with an already-resolved-or-already-failed Crossref outcome and an already-fetched roster/existing-match to produce one `IngestOutcome`. No I/O — every value it needs is a parameter.

**Design note on author→faculty matching:** Crossref author names arrive pre-formatted as `"Family, G.I."` (`formatCrossrefAuthorName`, `lib/crossref.ts`), and `faculty.display_name` is already stored in the identical citation form (`toCitationName`, `lib/names.ts`, applied once during `sync-roster`). Matching therefore reduces to comparing two already-normalized-shape strings — family name (diacritic/case-insensitive) plus, when both sides have one, a matching first initial. No new `lib/names.ts` function was needed for this; the "directory names are dirty" precedent it establishes is what justifies not requiring an exact full-string match here.

- [ ] **Step 1: Write the failing tests** (`tests/scholar-ingest.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import {
  decideArticleOutcome,
  matchAuthorNameToFaculty,
  resolveDiscoveringFaculty,
  type CrossrefOutcome,
  type DiscoveredArticle,
  type ExistingMatch,
} from "../lib/scholar-ingest";
import type { Faculty } from "../lib/types";

function faculty(overrides: Partial<Faculty>): Faculty {
  return {
    id: 1, wp_id: "1", slug: "x", display_name: "Doe, J.", full_name: "Jane Doe", email: "j@x.com",
    unit: "Department of Health Sciences", research_profile_url: null, scholar_user_id: "ABC123AAAAJ",
    orcid: null, classification: "Faculty", active: 1, last_alert_seen_at: null, last_synced_at: null,
    ...overrides,
  };
}

const ARTICLE: DiscoveredArticle = { title: "A Test Paper", year: 2026, scholarUrl: "https://scholar.google.com/scholar_url?url=x" };
const NOW = "2026-07-15T00:00:00.000Z";

describe("resolveDiscoveringFaculty — the §5a.3 join, case-sensitive exact match", () => {
  it("finds an active faculty row by exact scholar_user_id", () => {
    const roster = [faculty({ id: 1, scholar_user_id: "hs_VC0kAAAAJ" })];
    expect(resolveDiscoveringFaculty("hs_VC0kAAAAJ", roster)?.id).toBe(1);
  });

  it("an unmatched Scholar user ID returns null (never a fuzzy/case-insensitive match)", () => {
    const roster = [faculty({ id: 1, scholar_user_id: "hs_VC0kAAAAJ" })];
    expect(resolveDiscoveringFaculty("hs_vc0kaaaaj", roster)).toBeNull();
    expect(resolveDiscoveringFaculty("totally-unknown-id", roster)).toBeNull();
  });
});

describe("decideArticleOutcome — CrossrefUnavailableError produces retry_later, nothing persisted", () => {
  const unavailable: CrossrefOutcome = { kind: "unavailable", reason: "Crossref search returned 503" };

  it("from the resolved-but-then-errors direction", () => {
    const outcome = decideArticleOutcome(ARTICLE, faculty({}), unavailable, null, [], [], NOW);
    expect(outcome).toEqual({ kind: "retry_later", reason: "Crossref search returned 503" });
  });

  it("even when an existing match would otherwise have been found — unavailable always wins, never persisted", () => {
    const existingMatch: ExistingMatch = {
      id: 42,
      metadata: { doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026, volume: "1", issue: "1", pages: "1-2", source: "crossref" },
      authors: [],
    };
    const outcome = decideArticleOutcome(ARTICLE, faculty({}), unavailable, existingMatch, [], [], NOW);
    expect(outcome.kind).toBe("retry_later");
  });
});

describe("decideArticleOutcome — a clean Crossref null (not found) produces needs_metadata", () => {
  it("when no existing record matches, and no similar-enough title exists either", () => {
    const outcome = decideArticleOutcome(ARTICLE, faculty({ id: 7 }), { kind: "not_found" }, null, [], [], NOW);

    expect(outcome.kind).toBe("insert_needs_metadata");
    if (outcome.kind !== "insert_needs_metadata") throw new Error("unreachable");
    expect(outcome.publication.status).toBe("needs_metadata");
    expect(outcome.publication.source).toBe("scholar");
    expect(outcome.publication.discovered_by_faculty_id).toBe(7);
    expect(outcome.publication.scholar_alert_url).toBe(ARTICLE.scholarUrl);
    expect(outcome.publication.title).toBe("A Test Paper");
    expect(outcome.publication.year).toBe(2026);
    expect(outcome.possibleDuplicateOf).toEqual([]);
  });

  it("no publication_authors rows are implied — insert_needs_metadata carries no authors field at all", () => {
    const outcome = decideArticleOutcome(ARTICLE, faculty({ id: 7 }), { kind: "not_found" }, null, [], [], NOW);
    if (outcome.kind !== "insert_needs_metadata") throw new Error("unreachable");
    expect("authors" in outcome).toBe(false);
  });

  it("a null Crossref result that DOES match an existing record is idempotent — merged, no new row", () => {
    const existingMatch: ExistingMatch = {
      id: 42,
      metadata: { doi: null, title: "A Test Paper", url: "https://scholar.google.com/x", journal: null, year: 2026, volume: null, issue: null, pages: null, source: "scholar" },
      authors: [],
    };
    const outcome = decideArticleOutcome(ARTICLE, faculty({ id: 7 }), { kind: "not_found" }, existingMatch, [], [], NOW);

    expect(outcome).toMatchObject({ kind: "merged", publicationId: 42 });
  });
});

describe("decideArticleOutcome — ★ possible-duplicate surfacing on insert_needs_metadata (plan-review addendum)", () => {
  it("a drifted title that doesn't exact-match but shares most significant tokens with an existing record is flagged, not silently duplicated", () => {
    // Mirrors the real §15.8 case: one co-author's alert resolves via
    // Crossref to a slightly different title wording than the other
    // co-author's still-unresolved Scholar title. findMatch (exact title/DOI)
    // correctly returns NEEDS_FUZZY here — this is a SEPARATE, deterministic,
    // non-blocking check layered on top, not a change to findMatch itself.
    const existing = [{ id: 99, doi: null, title_normalized: "acute and chronic effects of resistance training on tendon stiffness" }];
    const article = { title: "Acute Compared to Chronic Effects of Resistance Training on Tendon Stiffness", year: 2026, scholarUrl: "https://scholar.google.com/x" };

    const outcome = decideArticleOutcome(article, faculty({ id: 7 }), { kind: "not_found" }, null, existing, [], NOW);

    if (outcome.kind !== "insert_needs_metadata") throw new Error("unreachable");
    expect(outcome.possibleDuplicateOf).toEqual([99]);
  });

  it("still inserts (never blocks) even when flagged as a possible duplicate", () => {
    const existing = [{ id: 99, doi: null, title_normalized: "acute and chronic effects of resistance training on tendon stiffness" }];
    const article = { title: "Acute Compared to Chronic Effects of Resistance Training on Tendon Stiffness", year: 2026, scholarUrl: "https://scholar.google.com/x" };

    const outcome = decideArticleOutcome(article, faculty({ id: 7 }), { kind: "not_found" }, null, existing, [], NOW);

    expect(outcome.kind).toBe("insert_needs_metadata");
  });

  it("an unrelated existing title is never flagged", () => {
    const existing = [{ id: 5, doi: null, title_normalized: "a completely different study about balance and falls in older adults" }];
    const outcome = decideArticleOutcome(ARTICLE, faculty({ id: 7 }), { kind: "not_found" }, null, existing, [], NOW);

    if (outcome.kind !== "insert_needs_metadata") throw new Error("unreachable");
    expect(outcome.possibleDuplicateOf).toEqual([]);
  });
});

describe("decideArticleOutcome — an unmatched Scholar author never reaches this function; it's the caller's job to short-circuit via resolveDiscoveringFaculty", () => {
  it("documented, not re-tested here (see the resolveDiscoveringFaculty suite above)", () => {
    expect(true).toBe(true);
  });
});

describe("decideArticleOutcome — a resolved Crossref hit with no existing match inserts a full record", () => {
  it("builds publication + full author list, tagging the discovering faculty as chps_faculty when their name matches", () => {
    const resolution = {
      doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026,
      volume: "1", issue: "1", pages: "1-2", type: "journal-article",
      authors: [{ name: "Doe, J.", position: 0 }, { name: "Smith, R.", position: 1 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, null, [], roster, NOW);

    expect(outcome.kind).toBe("insert_resolved");
    if (outcome.kind !== "insert_resolved") throw new Error("unreachable");
    expect(outcome.publication.status).toBe("pending_merge");
    expect(outcome.publication.source).toBe("crossref");
    expect(outcome.publication.discovered_by_faculty_id).toBe(7);
    expect(outcome.authors).toEqual([
      { name: "Doe, J.", faculty_id: 7, role: "chps_faculty", role_set_by: "ingest", role_set_at: NOW, position: 0 },
      { name: "Smith, R.", faculty_id: null, role: "unknown", role_set_by: null, role_set_at: null, position: 1 },
    ]);
    expect(outcome.discoveringFacultyLinked).toBe(true);
    expect(outcome.possibleDuplicateOf).toEqual([]); // nothing similar in `existing` ([])
  });

  it("★ the discovering faculty's own name failing to match the roster is counted, not papered over", () => {
    const resolution = {
      doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026,
      volume: "1", issue: "1", pages: "1-2", type: "journal-article",
      authors: [{ name: "Doerr, J.", position: 0 }], // Crossref's hyphenation/spelling disagrees with the roster
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, null, [], roster, NOW);

    if (outcome.kind !== "insert_resolved") throw new Error("unreachable");
    expect(outcome.discoveringFacultyLinked).toBe(false);
    expect(outcome.authors.every((a) => a.role === "unknown")).toBe(true);
  });
});

describe("decideArticleOutcome — ★ possible-duplicate surfacing mirrored onto insert_resolved (plan-review round 2)", () => {
  it("a resolved alert flags an earlier needs_metadata stub for the same paper — the stub is never left orphaned", () => {
    // The scenario from the review comment: Faculty A's alert produced a
    // needs_metadata stub with a title-drifted wording (Crossref not_found
    // at the time — some other resolver call, not modeled here). Faculty
    // B's alert for the SAME paper now resolves cleanly via Crossref. This
    // resolved insert must flag the stub, not silently create a second,
    // disconnected record.
    const resolution = {
      doi: "10.1/y", title: "Acute and Chronic Effects of Resistance Training on Tendon Stiffness", url: "https://doi.org/10.1/y", journal: "J", year: 2026,
      volume: "1", issue: "1", pages: "1-2", type: "journal-article",
      authors: [{ name: "Doe, J.", position: 0 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];
    const existing = [{ id: 99, doi: null, title_normalized: "acute compared to chronic effects of resistance training on tendon stiffness" }];

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, null, existing, roster, NOW);

    expect(outcome.kind).toBe("insert_resolved");
    if (outcome.kind !== "insert_resolved") throw new Error("unreachable");
    expect(outcome.possibleDuplicateOf).toEqual([99]);
  });

  it("still inserts (never blocks, never auto-merges) even when flagged", () => {
    const resolution = {
      doi: "10.1/y", title: "Acute and Chronic Effects of Resistance Training on Tendon Stiffness", url: "https://doi.org/10.1/y", journal: "J", year: 2026,
      volume: "1", issue: "1", pages: "1-2", type: "journal-article",
      authors: [{ name: "Doe, J.", position: 0 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];
    const existing = [{ id: 99, doi: null, title_normalized: "acute compared to chronic effects of resistance training on tendon stiffness" }];

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, null, existing, roster, NOW);

    expect(outcome.kind).toBe("insert_resolved"); // not merged into 99 — that's a human call
  });
});

describe("decideArticleOutcome — a resolved Crossref hit that matches an existing record merges (§7)", () => {
  it("two alerts for the same paper converge: existing authors are preserved, faculty_id set via mergeAuthors' upgrade rule", () => {
    const resolution = {
      doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026,
      volume: "1", issue: "1", pages: "1-2", type: "journal-article",
      authors: [{ name: "Doe, J.", position: 0 }, { name: "Smith, R.", position: 1 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." }), faculty({ id: 8, display_name: "Smith, R.", scholar_user_id: "XYZ789AAAAJ" })];
    const existingMatch: ExistingMatch = {
      id: 42,
      metadata: { doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026, volume: "1", issue: "1", pages: "1-2", source: "crossref" },
      authors: [
        { id: 1, name: "Doe, J.", faculty_id: 7, role: "chps_faculty", role_set_by: "ingest", role_set_at: NOW, position: 0 },
        { id: 2, name: "Smith, R.", faculty_id: null, role: "unknown", role_set_by: null, role_set_at: null, position: 1 },
      ],
    };

    // Second alert arrives from Smith
    const outcome = decideArticleOutcome(ARTICLE, roster[1], { kind: "resolved", resolution }, existingMatch, [], roster, NOW);

    expect(outcome.kind).toBe("merged");
    if (outcome.kind !== "merged") throw new Error("unreachable");
    expect(outcome.publicationId).toBe(42);
    expect(outcome.authors.find((a) => a.name === "Smith, R.")).toMatchObject({ faculty_id: 8, role: "chps_faculty" });
    expect(outcome.discoveringFacultyLinked).toBe(true);
  });

  it("a human-set role survives the merge (§15.4 — mergeAuthors' own guarantee, exercised here)", () => {
    const resolution = {
      doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026,
      volume: "1", issue: "1", pages: "1-2", type: "journal-article",
      authors: [{ name: "Doe, J.", position: 0 }, { name: "Grad, S.", position: 1 }],
    };
    const roster = [faculty({ id: 7, display_name: "Doe, J." })];
    const existingMatch: ExistingMatch = {
      id: 42,
      metadata: { doi: "10.1/x", title: "A Test Paper", url: "https://doi.org/10.1/x", journal: "J", year: 2026, volume: "1", issue: "1", pages: "1-2", source: "crossref" },
      authors: [
        { id: 1, name: "Doe, J.", faculty_id: 7, role: "chps_faculty", role_set_by: "ingest", role_set_at: NOW, position: 0 },
        { id: 2, name: "Grad, S.", faculty_id: null, role: "grad_student", role_set_by: "faculty:7", role_set_at: NOW, position: 1 },
      ],
    };

    const outcome = decideArticleOutcome(ARTICLE, roster[0], { kind: "resolved", resolution }, existingMatch, [], roster, NOW);

    if (outcome.kind !== "merged") throw new Error("unreachable");
    expect(outcome.authors.find((a) => a.name === "Grad, S.")).toMatchObject({ role: "grad_student", role_set_by: "faculty:7" });
  });
});

describe("matchAuthorNameToFaculty", () => {
  it("matches on normalized family name + first initial", () => {
    const roster = [faculty({ id: 1, display_name: "Ploutz-Snyder, L." })];
    expect(matchAuthorNameToFaculty("Ploutz-Snyder, L.", roster)?.id).toBe(1);
  });

  it("does not match a different family name sharing an initial", () => {
    const roster = [faculty({ id: 1, display_name: "Stock, M.S." })];
    expect(matchAuthorNameToFaculty("Stark, M.S.", roster)).toBeNull();
  });

  it("an author name with no comma (organizational author) never matches, never throws", () => {
    const roster = [faculty({ id: 1, display_name: "Doe, J." })];
    expect(() => matchAuthorNameToFaculty("World Health Organization", roster)).not.toThrow();
    expect(matchAuthorNameToFaculty("World Health Organization", roster)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run tests/scholar-ingest.test.ts
```

- [ ] **Step 3: Implement `lib/scholar-ingest.ts`**

```ts
// Pure decision function for the Scholar ingester (§13 item 9). No I/O — every
// value (the already-caught Crossref outcome, the already-fetched roster and
// existing-match row) is a parameter, so this is testable without a database,
// a mailbox, or a network. Composes lib/matching.ts (Session 5, unmodified).
import { findMatch, mergeAuthors, mergeMetadata, normalizeTitle } from "./matching";
import type { AuthorInput, ExistingAuthor, MatchableExisting, MergeableExisting, MergedAuthor, PublicationMetadata } from "./matching";
import type { CrossrefResolution, Faculty } from "./types";

export type CrossrefOutcome =
  | { kind: "resolved"; resolution: CrossrefResolution }
  | { kind: "not_found" } // Crossref answered and had nothing — §5a.8
  | { kind: "unavailable"; reason: string }; // infrastructure failure — never needs_metadata

export interface DiscoveredArticle {
  title: string;
  year: number | null;
  scholarUrl: string | null;
}

export interface ExistingMatch {
  id: number;
  metadata: MergeableExisting;
  authors: ExistingAuthor[];
}

export type IngestOutcome =
  | { kind: "skip_unknown_author"; scholarUserId: string; displayName: string }
  | { kind: "merged"; publicationId: number; metadata: PublicationMetadata & { title_normalized: string }; authors: MergedAuthor[]; discoveringFacultyLinked: boolean }
  | {
      kind: "insert_resolved";
      publication: PublicationMetadata & {
        title_normalized: string;
        status: "pending_merge";
        source: "crossref";
        discovered_by_faculty_id: number;
        scholar_alert_url: string | null;
        first_seen_at: string;
        date_added: string;
      };
      authors: AuthorInput[];
      discoveringFacultyLinked: boolean;
      // ★ Mirrors insert_needs_metadata's own field (plan-review round 2):
      // a resolved insert can itself be the "second alert" for a paper an
      // earlier, still-open needs_metadata stub already represents. Same
      // deterministic check, same threshold, opposite direction.
      possibleDuplicateOf: number[];
    }
  | {
      kind: "insert_needs_metadata";
      publication: {
        title: string;
        title_normalized: string;
        url: string;
        year: number | null;
        status: "needs_metadata";
        source: "scholar";
        discovered_by_faculty_id: number;
        scholar_alert_url: string | null;
        first_seen_at: string;
        date_added: string;
      };
      // ★ Plan-review addendum: publication ids whose title shares most of
      // its significant tokens with this one. Deterministic, no AI, never
      // blocks the insert — see the "possible-duplicate surfacing" note
      // below decideArticleOutcome. Always [] unless a loose match is found.
      possibleDuplicateOf: number[];
    }
  | { kind: "retry_later"; reason: string };

// §5a.3 — the join, case-sensitive, exact. Never a fallback to name matching.
export function resolveDiscoveringFaculty(scholarUserId: string, roster: Faculty[]): Faculty | null {
  return roster.find((f) => f.scholar_user_id === scholarUserId) ?? null;
}

function normalizeForCompare(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function parseCitationName(name: string): { family: string; firstInitial: string | null } | null {
  const idx = name.indexOf(",");
  if (idx === -1) return null;
  const family = name.slice(0, idx).trim();
  const initials = name.slice(idx + 1).replace(/\./g, "").trim();
  return { family, firstInitial: initials[0]?.toLowerCase() ?? null };
}

// Both Crossref author names (formatCrossrefAuthorName, lib/crossref.ts) and
// faculty.display_name (toCitationName, lib/names.ts) are already in
// "Family, G.I." citation form — matching reduces to comparing that shape.
export function matchAuthorNameToFaculty(authorName: string, roster: Faculty[]): Faculty | null {
  const parsedAuthor = parseCitationName(authorName);
  if (!parsedAuthor) return null;
  const authorFamily = normalizeForCompare(parsedAuthor.family);

  return (
    roster.find((f) => {
      const parsedFaculty = parseCitationName(f.display_name);
      if (!parsedFaculty) return false;
      if (normalizeForCompare(parsedFaculty.family) !== authorFamily) return false;
      if (parsedAuthor.firstInitial && parsedFaculty.firstInitial) {
        return parsedAuthor.firstInitial === parsedFaculty.firstInitial;
      }
      return true;
    }) ?? null
  );
}

function buildAuthorInputs(authors: CrossrefResolution["authors"], roster: Faculty[], nowIso: string): AuthorInput[] {
  return authors.map((a) => {
    const match = matchAuthorNameToFaculty(a.name, roster);
    return match
      ? { name: a.name, faculty_id: match.id, role: "chps_faculty" as const, role_set_by: "ingest", role_set_at: nowIso, position: a.position }
      : { name: a.name, faculty_id: null, role: "unknown" as const, role_set_by: null, role_set_at: null, position: a.position };
  });
}

function metadataFromResolution(resolution: CrossrefResolution): PublicationMetadata {
  return {
    doi: resolution.doi, title: resolution.title, url: resolution.url, journal: resolution.journal,
    year: resolution.year, volume: resolution.volume, issue: resolution.issue, pages: resolution.pages,
  };
}

function toPlainMetadata(m: MergeableExisting): PublicationMetadata {
  const { doi, title, url, journal, year, volume, issue, pages } = m;
  return { doi, title, url, journal, year, volume, issue, pages };
}

const DUPLICATE_TOKEN_OVERLAP_THRESHOLD = 0.7;
const MIN_SIGNIFICANT_TOKEN_LENGTH = 4;

function significantTokens(normalizedTitle: string): Set<string> {
  return new Set(normalizedTitle.split(" ").filter((t) => t.length >= MIN_SIGNIFICANT_TOKEN_LENGTH));
}

// ★ Plan-review addendum. §15.2/§15.11: cheap, deterministic, non-blocking.
// findMatch (exact title/DOI) correctly returns NEEDS_FUZZY when two
// co-authors' alerts for the same paper drift in wording (one resolves via
// Crossref, one doesn't — the exact §15.8 "acute compared to chronic" vs.
// "acute and chronic" shape). Left unmitigated, that produces a second,
// duplicate needs_metadata row for an already-pending_merge paper, and
// nobody notices (§15.11 — the class of failure this whole plan is written
// to avoid). This is NOT a matching-engine change and NOT AI — it only
// flags the risk in the run summary, the same way discoveringFacultyLinked
// already flags its own class of miss. A real fuzzy-match decision
// (lib/matching-ai.ts) is a bigger call than this session makes
// unilaterally — see the plan header.
function findPossibleDuplicates(candidateTitle: string, existing: MatchableExisting[]): number[] {
  const candidateTokens = significantTokens(normalizeTitle(candidateTitle));
  if (candidateTokens.size === 0) return [];

  return existing
    .filter((e) => {
      const existingTokens = significantTokens(e.title_normalized);
      if (existingTokens.size === 0) return false;
      let shared = 0;
      for (const t of candidateTokens) if (existingTokens.has(t)) shared++;
      return shared / Math.min(candidateTokens.size, existingTokens.size) >= DUPLICATE_TOKEN_OVERLAP_THRESHOLD;
    })
    .map((e) => e.id);
}

// Given: this article, the faculty member whose alert discovered it (already
// resolved via resolveDiscoveringFaculty — see scripts/ingest-scholar.ts for
// the skip_unknown_author short-circuit that happens before this is ever
// called), the already-computed Crossref outcome, an already-fetched
// existing-match row (or null if findMatch found nothing), the full
// lightweight existing-publications list (for the possible-duplicate
// surfacing check below — the same list the caller already fetched to run
// findMatch), the full active roster, and "now" — decide what happens next.
// Pure.
export function decideArticleOutcome(
  article: DiscoveredArticle,
  matchedFaculty: Faculty,
  crossrefOutcome: CrossrefOutcome,
  existingMatch: ExistingMatch | null,
  existing: MatchableExisting[],
  roster: Faculty[],
  nowIso: string
): Exclude<IngestOutcome, { kind: "skip_unknown_author" }> {
  if (crossrefOutcome.kind === "unavailable") {
    return { kind: "retry_later", reason: crossrefOutcome.reason };
  }

  if (crossrefOutcome.kind === "not_found") {
    if (existingMatch) {
      // §9 idempotency: a second alert (or a re-run of the same email) for a
      // paper Crossref still can't resolve. Nothing new to contribute —
      // acknowledge the existing record, create nothing.
      return {
        kind: "merged",
        publicationId: existingMatch.id,
        metadata: { ...toPlainMetadata(existingMatch.metadata), title_normalized: normalizeTitle(existingMatch.metadata.title) },
        authors: existingMatch.authors.map((a) => ({ ...a })),
        discoveringFacultyLinked: existingMatch.authors.some((a) => a.faculty_id === matchedFaculty.id),
      };
    }

    return {
      kind: "insert_needs_metadata",
      publication: {
        title: article.title,
        title_normalized: normalizeTitle(article.title),
        url: article.scholarUrl ?? "",
        year: article.year,
        status: "needs_metadata",
        source: "scholar",
        discovered_by_faculty_id: matchedFaculty.id,
        scholar_alert_url: article.scholarUrl,
        first_seen_at: nowIso,
        date_added: nowIso.slice(0, 10),
      },
      possibleDuplicateOf: findPossibleDuplicates(article.title, existing),
    };
  }

  // crossrefOutcome.kind === "resolved"
  const resolution = crossrefOutcome.resolution;
  const incomingMetadata = metadataFromResolution(resolution);
  const incomingAuthors = buildAuthorInputs(resolution.authors, roster, nowIso);

  if (existingMatch) {
    const mergedMetadata = mergeMetadata(existingMatch.metadata, incomingMetadata, "crossref");
    const mergedAuthors = mergeAuthors(existingMatch.authors, incomingAuthors, "crossref");
    return {
      kind: "merged",
      publicationId: existingMatch.id,
      metadata: mergedMetadata,
      authors: mergedAuthors,
      discoveringFacultyLinked: mergedAuthors.some((a) => a.faculty_id === matchedFaculty.id),
    };
  }

  return {
    kind: "insert_resolved",
    publication: {
      ...incomingMetadata,
      title_normalized: normalizeTitle(incomingMetadata.title),
      status: "pending_merge",
      source: "crossref",
      discovered_by_faculty_id: matchedFaculty.id,
      scholar_alert_url: article.scholarUrl,
      first_seen_at: nowIso,
      date_added: nowIso.slice(0, 10),
    },
    authors: incomingAuthors,
    discoveringFacultyLinked: incomingAuthors.some((a) => a.faculty_id === matchedFaculty.id),
    possibleDuplicateOf: findPossibleDuplicates(incomingMetadata.title, existing),
  };
}

// Re-exported for the orchestrator: given a candidate (already resolved or
// not), find a match against a freshly-queried existing list. Thin wrapper
// around lib/matching.ts's findMatch — not new dedup logic, just the
// glue the script needs to build an ExistingMatch (or null) before calling
// decideArticleOutcome. NEEDS_FUZZY is treated as "no match" this session —
// lib/matching-ai.ts is out of scope here (see plan header).
export function findCandidateMatch(candidateTitle: string, candidateDoi: string | null, existing: MatchableExisting[]) {
  return findMatch({ doi: candidateDoi, title: candidateTitle }, existing);
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
npx vitest run tests/scholar-ingest.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add lib/scholar-ingest.ts tests/scholar-ingest.test.ts
git commit -m "Add pure ingest-scholar decision function"
```

---

## Task 6: `.env.example` and `package.json` additions

**Files:**
- Modify: `.env.example`
- Modify: `package.json`

- [ ] **Step 1: Add the new env vars to `.env.example`**, in the Gmail block:

```
# Gmail — BOTH read (Scholar alerts) and send (review emails).
# Scopes required: gmail.readonly, gmail.send, AND gmail.modify (or gmail.labels) —
# the last one is needed to apply the "processed" label after ingest-scholar runs
# (confirmed against the live account; see docs/scholar-alert-notes.md §8).
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
GMAIL_ALERT_QUERY=
# The "roundup/processed" label already exists on the live account
# (docs/scholar-alert-notes.md §8) — id "Label_1". Used to build the
# `-label:` exclusion in the search query and to apply the label via
# messages.modify, respectively.
GMAIL_PROCESSED_LABEL_NAME=roundup/processed
GMAIL_PROCESSED_LABEL_ID=Label_1
REVIEW_EMAIL_FROM=            # e.g. "CHPS Research <research@ucf.edu>" — a human-looking
                              # sender, NOT a no-reply address. Faculty reply to these.
REVIEW_EMAIL_REPLY_TO=        # a real person in COMMS who can field "this isn't mine" replies
```

And a new line in the `# Behavior` block:

```
# Behavior
MERGE_BUFFER_HOURS=
SCHOLAR_INGEST_MAX_EMAILS=200   # hard cap on listMessages pagination (lib/gmail.ts)
```

- [ ] **Step 2: Add the npm script** to `package.json`'s `"scripts"` block, next to `"sync:roster"`:

```json
    "ingest:scholar": "tsx scripts/ingest-scholar.ts",
```

- [ ] **Step 3: Commit**

```bash
git add .env.example package.json
git commit -m "Add env vars and npm script for ingest-scholar"
```

---

## Task 7: `scripts/ingest-scholar.ts` — the orchestrator

**Files:**
- Create: `scripts/ingest-scholar.ts`

This is the only I/O-heavy file in the session. It does no independent judgment — every decision is delegated to `lib/scholar-ingest.ts`.

- [ ] **Step 1: Implement `scripts/ingest-scholar.ts`**

```ts
// Orchestrates the Scholar-alert ingester (§13 item 9): Gmail -> parse ->
// Crossref -> decide -> persist. All I/O lives here; all judgment lives in
// lib/scholar-ingest.ts (pure) and lib/scholar-alert.ts (pure). Run with:
//   npm run ingest:scholar -- --dry-run
//   npm run ingest:scholar -- --limit 5
import { config } from "dotenv";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import type { AuthorInput, ExistingAuthor, MatchableExisting, MergeableExisting } from "../lib/matching";
import type { Faculty } from "../lib/types";
import type { CrossrefOutcome, DiscoveredArticle, ExistingMatch, IngestOutcome } from "../lib/scholar-ingest";

config({ path: path.join(__dirname, "..", ".env.local") });

export interface RunOptions {
  dryRun: boolean;
  limit: number | null;
}

export function parseArgs(argv: string[]): RunOptions {
  const dryRun = argv.includes("--dry-run");
  const limitFlag = argv.find((a) => a === "--limit" || a.startsWith("--limit="));
  let limit: number | null = null;
  if (limitFlag) {
    const value = limitFlag.includes("=") ? limitFlag.split("=")[1] : argv[argv.indexOf(limitFlag) + 1];
    limit = value ? Number(value) : null;
  }
  return { dryRun, limit };
}

export interface RunSummary {
  emailsScanned: number;
  parsed: number;
  rejected: Record<string, number>;
  alertsMatchedToFaculty: number;
  unknownScholarIds: { scholarUserId: string; displayName: string }[];
  articlesSeen: number;
  resolved: number;
  merged: number;
  insertedNew: number;
  needsMetadata: number;
  retryLater: number;
  discoveringFacultyNotLinked: { publicationTitle: string; facultyName: string }[];
  possibleDuplicates: { newTitle: string; existingPublicationIds: number[] }[];
  emailsLabeled: number;
}

function emptySummary(): RunSummary {
  return {
    emailsScanned: 0, parsed: 0, rejected: {}, alertsMatchedToFaculty: 0, unknownScholarIds: [],
    articlesSeen: 0, resolved: 0, merged: 0, insertedNew: 0, needsMetadata: 0, retryLater: 0,
    discoveringFacultyNotLinked: [], possibleDuplicates: [], emailsLabeled: 0,
  };
}

async function applyOutcome(client: Client, outcome: IngestOutcome): Promise<void> {
  const nowIso = new Date().toISOString();

  if (outcome.kind === "insert_needs_metadata") {
    const p = outcome.publication;
    await client.execute({
      sql: `INSERT INTO publications (title, title_normalized, url, year, status, source, discovered_by_faculty_id, scholar_alert_url, first_seen_at, date_added, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [p.title, p.title_normalized, p.url, p.year, p.status, p.source, p.discovered_by_faculty_id, p.scholar_alert_url, p.first_seen_at, p.date_added, nowIso],
    });
    return;
  }

  if (outcome.kind === "insert_resolved") {
    const p = outcome.publication;
    const result = await client.execute({
      sql: `INSERT INTO publications (doi, title, title_normalized, url, journal, year, volume, issue, pages, status, source, discovered_by_faculty_id, scholar_alert_url, first_seen_at, date_added, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [p.doi, p.title, p.title_normalized, p.url, p.journal, p.year, p.volume, p.issue, p.pages, p.status, p.source, p.discovered_by_faculty_id, p.scholar_alert_url, p.first_seen_at, p.date_added, nowIso],
    });
    const publicationId = Number(result.lastInsertRowid);
    for (const a of outcome.authors) {
      await client.execute({
        sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [publicationId, a.faculty_id, a.name, a.role, a.role_set_by, a.role_set_at, a.position],
      });
    }
    return;
  }

  if (outcome.kind === "merged") {
    await client.execute({
      sql: `UPDATE publications SET doi=?, title=?, title_normalized=?, url=?, journal=?, year=?, volume=?, issue=?, pages=? WHERE id=?`,
      args: [
        outcome.metadata.doi, outcome.metadata.title, outcome.metadata.title_normalized, outcome.metadata.url,
        outcome.metadata.journal, outcome.metadata.year, outcome.metadata.volume, outcome.metadata.issue,
        outcome.metadata.pages, outcome.publicationId,
      ],
    });
    for (const a of outcome.authors) {
      if (a.id === null) {
        await client.execute({
          sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [outcome.publicationId, a.faculty_id, a.name, a.role, a.role_set_by, a.role_set_at, a.position],
        });
      } else {
        await client.execute({
          sql: `UPDATE publication_authors SET faculty_id=?, role=?, role_set_by=?, role_set_at=? WHERE id=?`,
          args: [a.faculty_id, a.role, a.role_set_by, a.role_set_at, a.id],
        });
      }
    }
  }
}

export async function runIngestScholar(client: Client, opts: RunOptions): Promise<RunSummary> {
  const gmail = await import("../lib/gmail");
  const { parseAlertEmail } = await import("../lib/scholar-alert");
  const crossref = await import("../lib/crossref");
  const ingest = await import("../lib/scholar-ingest");

  const query = process.env.GMAIL_ALERT_QUERY;
  const labelName = process.env.GMAIL_PROCESSED_LABEL_NAME;
  const labelId = process.env.GMAIL_PROCESSED_LABEL_ID;
  if (!query) throw new Error("GMAIL_ALERT_QUERY must be set (see .env.example)");
  if (!labelName || !labelId) throw new Error("GMAIL_PROCESSED_LABEL_NAME and GMAIL_PROCESSED_LABEL_ID must be set (see .env.example)");

  const summary = emptySummary();
  const roster = (await client.execute("SELECT * FROM faculty WHERE active = 1")).rows as unknown as Faculty[];

  let ids = await gmail.listMessages(`${query} -label:${labelName}`);
  if (opts.limit !== null) ids = ids.slice(0, opts.limit);

  for (const id of ids) {
    summary.emailsScanned++;

    const message = await gmail.getMessage(id);
    const html = gmail.extractHtmlBody(message);
    if (!html) {
      summary.rejected.no_html_part = (summary.rejected.no_html_part ?? 0) + 1;
      console.log(`[skip] ${id}: no HTML part`);
      continue;
    }

    const subject = message.payload.headers?.find((h) => h.name === "Subject")?.value ?? "";
    const parsed = parseAlertEmail(html, subject);
    if (parsed.kind === "rejected") {
      summary.rejected[parsed.reason] = (summary.rejected[parsed.reason] ?? 0) + 1;
      console.log(`[rejected:${parsed.reason}] ${id}: ${parsed.detail}`);
      continue;
    }
    summary.parsed++;

    const matchedFaculty = ingest.resolveDiscoveringFaculty(parsed.scholarUserId, roster);
    if (!matchedFaculty) {
      summary.unknownScholarIds.push({ scholarUserId: parsed.scholarUserId, displayName: parsed.displayName });
      console.log(`[skip_unknown_author] ${parsed.displayName} (${parsed.scholarUserId})`);
      // Terminal, known reason — label it so it isn't rescanned every run.
      if (!opts.dryRun) {
        await gmail.applyLabel(id, labelId);
        summary.emailsLabeled++;
      }
      continue;
    }
    summary.alertsMatchedToFaculty++;

    const nowIso = new Date().toISOString();
    if (!opts.dryRun) {
      await client.execute({ sql: "UPDATE faculty SET last_alert_seen_at = ? WHERE id = ?", args: [nowIso, matchedFaculty.id] });
    }

    let allTerminal = true;
    const surname = matchedFaculty.display_name.split(",")[0].trim();

    for (const article of parsed.articles) {
      summary.articlesSeen++;
      const discovered: DiscoveredArticle = { title: article.title, year: article.year, scholarUrl: article.scholarUrl };

      const crossrefOutcome = await resolveArticle(crossref, discovered, surname);
      if (crossrefOutcome.kind === "resolved") summary.resolved++;

      const candidateTitle = crossrefOutcome.kind === "resolved" ? crossrefOutcome.resolution.title : discovered.title;
      const candidateDoi = crossrefOutcome.kind === "resolved" ? crossrefOutcome.resolution.doi : null;

      // Re-query fresh every article — never cache a snapshot (§9): two
      // faculty members' alerts for the same paper routinely land in the
      // same run.
      const existingList = (await client.execute("SELECT id, doi, title_normalized FROM publications")).rows as unknown as MatchableExisting[];
      const matchResult = ingest.findCandidateMatch(candidateTitle, candidateDoi, existingList);

      let existingMatch: ExistingMatch | null = null;
      if (matchResult.type === "MATCH") {
        const pubRow = (
          await client.execute({
            sql: "SELECT doi, title, url, journal, year, volume, issue, pages, source FROM publications WHERE id = ?",
            args: [matchResult.publicationId],
          })
        ).rows[0] as unknown as MergeableExisting;
        const authorRows = (
          await client.execute({
            sql: "SELECT id, faculty_id, name, role, role_set_by, role_set_at, position FROM publication_authors WHERE publication_id = ? ORDER BY position",
            args: [matchResult.publicationId],
          })
        ).rows as unknown as ExistingAuthor[];
        existingMatch = { id: matchResult.publicationId, metadata: pubRow, authors: authorRows };
      }

      const outcome = ingest.decideArticleOutcome(discovered, matchedFaculty, crossrefOutcome, existingMatch, existingList, roster, nowIso);
      tally(summary, outcome, matchedFaculty, candidateTitle);

      if (outcome.kind === "retry_later") {
        allTerminal = false;
        console.log(`[retry_later] "${candidateTitle}": ${outcome.reason}`);
        continue;
      }

      console.log(`[${outcome.kind}] "${candidateTitle}"`);
      if (!opts.dryRun) await applyOutcome(client, outcome);
    }

    if (allTerminal && !opts.dryRun) {
      await gmail.applyLabel(id, labelId);
      summary.emailsLabeled++;
    }
  }

  return summary;
}

async function resolveArticle(
  crossref: typeof import("../lib/crossref"),
  article: DiscoveredArticle,
  surnameHint: string
): Promise<CrossrefOutcome> {
  try {
    const resolution = await crossref.resolveByTitle(article.title, article.year ?? undefined, surnameHint);
    return resolution ? { kind: "resolved", resolution } : { kind: "not_found" };
  } catch (err) {
    if (err instanceof crossref.CrossrefUnavailableError) return { kind: "unavailable", reason: err.message };
    throw err;
  }
}

function tally(summary: RunSummary, outcome: IngestOutcome, matchedFaculty: Faculty, candidateTitle: string): void {
  if (outcome.kind === "merged") summary.merged++;
  if (outcome.kind === "insert_resolved") summary.insertedNew++;
  if (outcome.kind === "insert_needs_metadata") summary.needsMetadata++;
  if (outcome.kind === "retry_later") summary.retryLater++;

  if ((outcome.kind === "merged" || outcome.kind === "insert_resolved") && !outcome.discoveringFacultyLinked) {
    summary.discoveringFacultyNotLinked.push({ publicationTitle: candidateTitle, facultyName: matchedFaculty.display_name });
  }

  if (
    (outcome.kind === "insert_needs_metadata" || outcome.kind === "insert_resolved") &&
    outcome.possibleDuplicateOf.length > 0
  ) {
    summary.possibleDuplicates.push({ newTitle: candidateTitle, existingPublicationIds: outcome.possibleDuplicateOf });
  }
}

function printSummary(s: RunSummary): void {
  console.log(`\n${s.emailsScanned} emails scanned · ${s.parsed} parsed · ${s.alertsMatchedToFaculty} matched to faculty`);
  console.log(`rejected: ${JSON.stringify(s.rejected)}`);
  console.log(`${s.articlesSeen} articles seen · ${s.resolved} resolved · ${s.merged} merged · ${s.insertedNew} inserted new · ${s.needsMetadata} needs_metadata · ${s.retryLater} retry_later`);
  console.log(`${s.emailsLabeled} emails labeled`);

  if (s.unknownScholarIds.length > 0) {
    console.log(`\nUnknown Scholar IDs (${s.unknownScholarIds.length}) — real to-do, someone left the roster or was never added:`);
    for (const u of s.unknownScholarIds) console.log(`  ${u.displayName} (${u.scholarUserId})`);
  }

  if (s.discoveringFacultyNotLinked.length > 0) {
    console.log(`\nDiscovering faculty not linked to their own paper (${s.discoveringFacultyNotLinked.length}) — a roster/Crossref name mismatch (§15.11):`);
    for (const d of s.discoveringFacultyNotLinked) console.log(`  ${d.facultyName} — "${d.publicationTitle}"`);
  }

  if (s.possibleDuplicates.length > 0) {
    console.log(`\nPossible duplicates flagged on insert (${s.possibleDuplicates.length}) — similar title already in the database, not auto-merged, needs a human look:`);
    for (const d of s.possibleDuplicates) console.log(`  "${d.newTitle}" ~ existing publication id(s) ${d.existingPublicationIds.join(", ")}`);
  }
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)");

  const opts = parseArgs(process.argv.slice(2));
  if (opts.dryRun) console.log("--dry-run: parsing, resolving, and deciding only. Nothing will be written or labeled.\n");

  const client = createClient({ url, authToken });
  const summary = await runIngestScholar(client, opts);
  printSummary(summary);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding (expected: none, given the types above were designed to match `lib/scholar-ingest.ts` and `lib/matching.ts` exactly — but this is the first point they're used together).

- [ ] **Step 3: Commit**

```bash
git add scripts/ingest-scholar.ts
git commit -m "Add ingest-scholar orchestration script"
```

---

## Task 8: `tests/ingest-scholar.integration.test.ts`

**Files:**
- Create: `tests/ingest-scholar.integration.test.ts`

Mock Gmail (fixture HTML wrapped in a synthetic `GmailMessage`) + mock Crossref (`vi.stubGlobal("fetch", ...)`), real matching engine, real migrations against a temp file DB — same pattern as `tests/sync-roster.test.ts`.

- [ ] **Step 1: Write the test file**

```ts
// The test this project exists for: two alerts, two different CHPS faculty,
// same paper -> ONE publication row, both linked as chps_faculty. Uses the
// real pair-citation-tag-schellhase / pair-normal-tag-mangum fixtures (see
// docs/scholar-alert-notes.md §3-4) — same paper, two different faculty
// followers, two different email templates.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../db/migrate";

process.env.CROSSREF_MAILTO ??= "test@example.com";
process.env.GMAIL_CLIENT_ID ??= "id";
process.env.GMAIL_CLIENT_SECRET ??= "secret";
process.env.GMAIL_REFRESH_TOKEN ??= "refresh";
process.env.GMAIL_ALERT_QUERY ??= 'from:scholaralerts-noreply@google.com subject:"new articles"';
process.env.GMAIL_PROCESSED_LABEL_NAME ??= "roundup/processed";
process.env.GMAIL_PROCESSED_LABEL_ID ??= "Label_1";

const { runIngestScholar } = await import("../scripts/ingest-scholar");
const { __resetTokenCacheForTests } = await import("../lib/gmail");

const FIXTURES_DIR = path.join(__dirname, "fixtures", "scholar-alerts");

function fixtureHtml(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, `${name}.decoded.html`), "utf-8");
}

function gmailMessageFor(id: string, subject: string, html: string) {
  const data = Buffer.from(html, "utf-8").toString("base64url");
  return {
    id,
    threadId: id,
    payload: { mimeType: "text/html", headers: [{ name: "Subject", value: subject }], body: { data } },
  };
}

const SCHELLHASE_MSG = gmailMessageFor(
  "msg-schellhase",
  "Kristen Couper Schellhase - new articles",
  fixtureHtml("pair-citation-tag-schellhase")
);
const MANGUM_MSG = gmailMessageFor(
  "msg-mangum",
  "L. Colby Mangum, PhD, ATC - new articles",
  fixtureHtml("pair-normal-tag-mangum")
);

// ★ Includes a "Mangum" family entry deliberately — not just Schellhase's
// truncated byline names. resolveByTitle's acceptance gate rejects a
// candidate whose author list doesn't contain the given surnameHint
// (lib/crossref.ts's authorListHasSurname), and the script calls
// resolveByTitle(title, year, "Mangum") for Mangum's own alert. Without this
// entry, Mangum's alert would silently resolve to `not_found` instead of
// exercising the real Crossref-author-list merge path this test exists to
// prove — the top-level counts would still happen to pass via an idempotent
// title-match merge instead, masking the gap. Position order doesn't matter
// for the test; this models the real paper's full (untruncated) author list,
// of which the Scholar alert bylines only ever show a truncated prefix.
const CROSSREF_ITEM = {
  DOI: "10.1123/ijatt.2025-0110",
  title: ["Exploring Job Satisfaction and Intention to Leave Among Athletic Trainers Working With Tactical Athletes in Military Clinical Practice Settings"],
  type: "journal-article",
  author: [
    { given: "Kristen C.", family: "Schellhase", affiliation: [] },
    { given: "W.", family: "Adam", affiliation: [] },
    { given: "A.", family: "Layne", affiliation: [] },
    { given: "L. Colby", family: "Mangum", affiliation: [] },
  ],
  "container-title": ["International Journal of Athletic Therapy and Training"],
  volume: "31", issue: "2", page: "88-95",
  issued: { "date-parts": [[2026]] },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("ingest-scholar integration", () => {
  let dbDir: string;
  let client: Client;
  let gmailInbox: Record<string, ReturnType<typeof gmailMessageFor>>;
  let appliedLabels: string[];

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), "ingest-scholar-test-"));
    client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
    await runMigrations(client, path.join(__dirname, "..", "db", "migrations"));

    await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, full_name, email, unit, scholar_user_id, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      args: ["1", "schellhase", "Schellhase, K.C.", "Kristen Couper Schellhase", "kcs@x.edu", "School of Kinesiology and Rehabilitation Sciences", "ez1ilMIAAAAJ"],
    });
    await client.execute({
      sql: `INSERT INTO faculty (wp_id, slug, display_name, full_name, email, unit, scholar_user_id, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      args: ["2", "mangum", "Mangum, L.C.", "L. Colby Mangum", "lcm@x.edu", "School of Kinesiology and Rehabilitation Sciences", "5yIzMuQAAAAJ"],
    });

    __resetTokenCacheForTests();
    gmailInbox = { "msg-schellhase": SCHELLHASE_MSG, "msg-mangum": MANGUM_MSG };
    appliedLabels = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url === "https://oauth2.googleapis.com/token") {
          return jsonResponse({ access_token: "tok", expires_in: 3600 });
        }
        if (url.includes("/messages?")) {
          return jsonResponse({ messages: Object.keys(gmailInbox).map((id) => ({ id })) });
        }
        if (url.match(/\/messages\/([^/?]+)\?format=full/)) {
          const id = url.match(/\/messages\/([^/?]+)\?format=full/)![1];
          return jsonResponse(gmailInbox[id]);
        }
        if (url.match(/\/messages\/([^/]+)\/modify/)) {
          const id = url.match(/\/messages\/([^/]+)\/modify/)![1];
          appliedLabels.push(id);
          return jsonResponse({});
        }
        if (url.startsWith("https://api.crossref.org/works?")) {
          return jsonResponse({ message: { items: [CROSSREF_ITEM] } });
        }
        throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
      })
    );
  });

  afterEach(() => {
    client.close();
    rmSync(dbDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("two alerts, two faculty, same paper -> ONE publication row, both linked and chps_faculty", async () => {
    const summary = await runIngestScholar(client, { dryRun: false, limit: null });

    expect(summary.insertedNew).toBe(1);
    expect(summary.merged).toBe(1);

    const pubs = await client.execute("SELECT id, doi, status FROM publications");
    expect(pubs.rows).toHaveLength(1);
    expect(pubs.rows[0].doi).toBe("10.1123/ijatt.2025-0110");

    const authors = await client.execute({
      sql: "SELECT name, faculty_id, role FROM publication_authors WHERE publication_id = ? ORDER BY position",
      args: [pubs.rows[0].id],
    });
    const schellhase = authors.rows.find((a) => String(a.name).includes("Schellhase"));
    const mangum = authors.rows.find((a) => String(a.name).startsWith("Mangum"));
    expect(schellhase?.faculty_id).toBeTruthy();
    expect(schellhase?.role).toBe("chps_faculty");
    // ★ The test this task is named for: BOTH faculty end up linked on the
    // same record, not just the one who happened to insert it first.
    expect(mangum?.faculty_id).toBeTruthy();
    expect(mangum?.role).toBe("chps_faculty");

    expect(appliedLabels.sort()).toEqual(["msg-mangum", "msg-schellhase"]);
  });

  it("running the whole ingest twice over the same fixtures produces identical DB state (§9)", async () => {
    await runIngestScholar(client, { dryRun: false, limit: null });
    const firstPubs = await client.execute("SELECT COUNT(*) as n FROM publications");
    const firstAuthors = await client.execute("SELECT COUNT(*) as n FROM publication_authors");

    // Re-run against the SAME inbox — simulates the label write having failed
    // (§9: idempotency rests on title/DOI matching, never on message ID or
    // the label itself).
    __resetTokenCacheForTests();
    const second = await runIngestScholar(client, { dryRun: false, limit: null });

    const secondPubs = await client.execute("SELECT COUNT(*) as n FROM publications");
    const secondAuthors = await client.execute("SELECT COUNT(*) as n FROM publication_authors");

    expect(secondPubs.rows[0].n).toBe(firstPubs.rows[0].n);
    expect(secondAuthors.rows[0].n).toBe(firstAuthors.rows[0].n);
    expect(second.insertedNew).toBe(0);
  });

  it("a human-set grad_student role on an existing record survives a re-ingest of the same paper (§15.4)", async () => {
    await runIngestScholar(client, { dryRun: false, limit: null });

    const pubs = await client.execute("SELECT id FROM publications");
    const publicationId = pubs.rows[0].id;
    await client.execute({
      sql: `INSERT INTO publication_authors (publication_id, faculty_id, name, role, role_set_by, role_set_at, position)
            VALUES (?, NULL, 'Grad, S.', 'grad_student', 'faculty:1', ?, 99)`,
      args: [publicationId, new Date().toISOString()],
    });

    __resetTokenCacheForTests();
    await runIngestScholar(client, { dryRun: false, limit: null });

    const grad = await client.execute({
      sql: "SELECT role, role_set_by FROM publication_authors WHERE name = 'Grad, S.'",
      args: [],
    });
    expect(grad.rows[0].role).toBe("grad_student");
    expect(grad.rows[0].role_set_by).toBe("faculty:1");
  });

  it("--dry-run writes nothing and labels nothing", async () => {
    const summary = await runIngestScholar(client, { dryRun: true, limit: null });

    expect(summary.insertedNew + summary.merged).toBeGreaterThan(0); // decisions were computed
    const pubs = await client.execute("SELECT COUNT(*) as n FROM publications");
    expect(pubs.rows[0].n).toBe(0); // nothing persisted
    expect(appliedLabels).toHaveLength(0); // nothing labeled
  });
});
```

- [ ] **Step 2: Run**

```bash
npx vitest run tests/ingest-scholar.integration.test.ts
```

Debug against real fetch-mock dispatch issues if any URL pattern doesn't match — this is the first time `lib/gmail.ts`, `lib/scholar-alert.ts`, `lib/scholar-ingest.ts`, `lib/crossref.ts`, and `lib/matching.ts` run together.

- [ ] **Step 3: Once green, run the entire suite** to confirm no regressions in Sessions 1–8's tests:

```bash
npx vitest run
```

- [ ] **Step 4: Commit**

```bash
git add tests/ingest-scholar.integration.test.ts
git commit -m "Add ingest-scholar integration test: two-faculty merge, idempotency, role survival"
```

---

## Task 9: Acceptance run and discrepancy report

**Files:** none (verification + a final message to the user, no code)

- [ ] **Step 1: Run `npm run ingest:scholar -- --dry-run` against the real fixtures is not directly wired (the script reads from Gmail, not fixture files) — instead, prove idempotency the way the prompt asks**: via the integration test's second run in Task 8, which already asserts "zero new rows, zero duplicate authors" on a same-fixture re-run. Confirm that test is green as the acceptance evidence:

```bash
npx vitest run tests/ingest-scholar.integration.test.ts --reporter=verbose
```

- [ ] **Step 2: Run the full suite one more time and typecheck**

```bash
npx vitest run
npx tsc --noEmit
```

- [ ] **Step 3: Report to the user** (per the session prompt's closing requirement) — summarize in the final chat message, not a new file:
  - Anything in the real fixtures that contradicts §5a: none found — every real fixture parses exactly as §5a and `docs/scholar-alert-notes.md` predict (bare footer link, per-block year, `[CITATION]`/normal/`[PDF]` tag variants, non-Latin title passthrough, the real 4-article multi-alert).
  - Three deliberate scope/interpretation decisions beyond the literal prompt text (already flagged in the plan header): `findMatch` applied to the Crossref-null branch too (idempotency requirement), `NEEDS_FUZZY` treated as no-match (no `lib/matching-ai.ts` integration this session), and the plan-review-driven `possibleDuplicateOf` surfacing on **both** `insert_needs_metadata` and `insert_resolved` (deterministic token-overlap check, non-blocking, added in two review rounds after the user flagged the drifted-title duplicate-row gap and then its symmetric case — a resolved insert orphaning an earlier stub).
  - No changes made to `lib/crossref.ts`, `lib/matching.ts`, `lib/scholar.ts` (only additive — `unwrapGoogleRedirect`), or `lib/names.ts` (untouched — see Task 5's design note on why no new function was needed there).
  - Migration renumbered from the prompt's suggested `003` to `005` (both `003` and `004` were already taken by prior sessions' work).

---

## Self-review notes (from the plan-writing pass)

- **Spec coverage:** migration (Task 1) · `lib/gmail.ts` five capabilities — token cache, pagination cap, `getMessage`, `applyLabel`, `extractHtmlBody` MIME-walk (Task 3) · `lib/scholar.ts` `unwrapGoogleRedirect` (Task 2) · `lib/scholar-alert.ts` parser + rejection rules + AI fallback (Task 4) · `lib/scholar-ingest.ts` decision function incl. the discovering-faculty-not-linked check (Task 5) · `scripts/ingest-scholar.ts` with `--dry-run`/`--limit`, run summary, per-article idempotent re-query (Task 7) · all three required test files (Tasks 4, 5, 8) · env vars and npm script (Task 6) · final report (Task 9). Non-goals (`ingest-crossref`, `ingest-pubmed-orcid`, `release-buffer`, GitHub Actions, UI) — deliberately absent, none built.
- **Placeholder scan:** no `TBD`/`...`/"similar to above" left in any code block; every SQL statement, type, and test assertion is written out in full.
- **Type consistency:** `IngestOutcome`, `DiscoveredArticle`, `ExistingMatch`, `CrossrefOutcome` are defined once in Task 5 and imported (not redefined) in Tasks 7 and 8. `ParsedArticle`/`ParsedAlert` defined once in Task 4. Author/metadata shapes (`AuthorInput`, `ExistingAuthor`, `MatchableExisting`, `MergeableExisting`, `PublicationMetadata`, `MergedAuthor`) are reused directly from `lib/matching.ts`, never redefined. `decideArticleOutcome`'s signature changed (added `existing: MatchableExisting[]` as its 5th parameter, `possibleDuplicateOf: number[]` added to `insert_needs_metadata`) — every call site in Task 5's tests and Task 7's script reflects the 7-parameter form.
- **Addendum note:** the plan-review gap and its fix (possible-duplicate surfacing) are not a hypothetical left for later — Task 5 now ships tests for it (`decideArticleOutcome — ★ possible-duplicate surfacing`) and Task 7's script/summary changes are part of the same task, not a follow-up task. Nothing in this plan defers it.
