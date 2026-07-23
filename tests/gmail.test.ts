import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.GMAIL_CLIENT_ID ??= "test-client-id";
process.env.GMAIL_CLIENT_SECRET ??= "test-client-secret";
process.env.GMAIL_REFRESH_TOKEN ??= "test-refresh-token";

const { getAccessToken, listMessages, getMessage, applyLabel, extractHtmlBody, sendMessage, GmailUnavailableError, __resetTokenCacheForTests } =
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

function decodeRawFromLastCall(): string {
  const [, init] = vi.mocked(fetch).mock.calls[vi.mocked(fetch).mock.calls.length - 1] as [string, RequestInit];
  const { raw } = JSON.parse(String(init.body)) as { raw: string };
  return Buffer.from(raw, "base64url").toString("utf-8");
}

describe("sendMessage", () => {
  it("POSTs to messages/send with a base64url-encoded RFC 2822 message containing From/To/Reply-To/Subject/body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: 3600 }));
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ id: "sent-1" }));

    await sendMessage({
      to: "faculty@ucf.edu",
      from: "roundup@ucf.edu",
      replyTo: "roundup@ucf.edu",
      subject: "You have publications to review",
      body: "Dr. Stock — you have 3 publications queued.",
    });

    const [url, init] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");

    const decoded = decodeRawFromLastCall();
    expect(decoded).toContain("From: roundup@ucf.edu");
    expect(decoded).toContain("To: faculty@ucf.edu");
    expect(decoded).toContain("Reply-To: roundup@ucf.edu");
    expect(decoded).toContain("Subject: You have publications to review");
    expect(decoded).toContain("Dr. Stock — you have 3 publications queued.");
  });

  it("MIME-encodes a non-ASCII subject line (e.g. an accented faculty name) rather than sending it raw", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: 3600 }));
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ id: "sent-1" }));

    await sendMessage({
      to: "faculty@ucf.edu",
      from: "roundup@ucf.edu",
      replyTo: "roundup@ucf.edu",
      subject: "Bonjour Dr. Étoilé",
      body: "body",
    });

    const decoded = decodeRawFromLastCall();
    expect(decoded).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(decoded).not.toContain("Subject: Bonjour Dr. Étoilé");
  });

  it("throws GmailUnavailableError when the send request fails, so the caller can catch it per-recipient", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: 3600 }));
    vi.mocked(fetch).mockResolvedValue(new Response("bad address", { status: 400 }));

    await expect(
      sendMessage({ to: "bad@ucf.edu", from: "roundup@ucf.edu", replyTo: "roundup@ucf.edu", subject: "s", body: "b" })
    ).rejects.toBeInstanceOf(GmailUnavailableError);
  });
});
