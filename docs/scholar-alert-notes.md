# Google Scholar Alert Emails — Gmail API Notes

**Purpose:** whichever session builds the Scholar ingester (`lib/gmail.ts`,
`lib/scholar-alert.ts`, `ingest-scholar`) codes against this file. Claude Code cannot
browse or read a live inbox. Everything here was pulled by hand from the live Gmail
account via the Gmail API — see `tests/fixtures/scholar-alerts/` for the raw messages.

**Verified:** July 2026, against a real sample of 20+ live "new articles" alert emails
(and, for the idempotency question, a targeted re-check of all 8 real Hanney alerts on
file). This is fixture-housekeeping and reconnaissance only — no ingester code exists
yet. See master plan §5a for the parsing spec this file supports.

---

## 1. The footer join-key link is bare — no redirect wrapper observed

Every real fixture pulled this session has the exact shape master plan §5a rule 3
expects, with no `google.com/url?q=...` (or any other) redirect wrapper around it:

```
This message was sent by Google Scholar because you're following new articles
written by <a href="https://scholar.google.com/citations?hl=en&user=WfdV37IAAAAJ">...
```

Confirmed across all 8 distinct real single/paired fixtures on file (different faculty,
different dates, different template variants — see §4 below). **Observed, not
guaranteed** — this is one Google Workspace account's mail over roughly a year, not a
formal guarantee from Google. `lib/scholar.ts`'s parser should still defensively unwrap
a redirect wrapper if one is present when the ingester is actually built; just don't
invent test fixtures for a shape that hasn't shown up once in real data.

---

## 2. Two other Scholar-internal link types per article — neither is the join key

Every article block carries two more `scholar.google.com` links besides the footer.
**Do not confuse either with the join key**, and do not parse a DOI out of either this
session — that's resolver territory (§5a rule 7, already built in `lib/crossref.ts`).

| Link | Shape | Purpose |
|---|---|---|
| **Headline link** (the title itself) | `scholar_url?url=<publisher URL>&hl=en&sa=X&d=...&ei=...&scisig=...&oi=scholaralrt&html=&pos=0&folt=art` | Redirects through Scholar's click-tracker to the real publisher page. |
| **Save icon link** | `citations?hl=en&update_op=email_library_add&info=<id>&citsig=...` | Adds the paper to the recipient's own Scholar library. Not useful to us at all. |

**Only the headline link is worth keeping**, stored **as-is** (the full `scholar_url?...`
redirect, not unwrapped) as `scholar_alert_url` for provenance — "here's where Scholar
said this came from." Do not parse it for a DOI this session.

> **Future enhancement, not now:** the headline link's `url=` query parameter is often
> the real publisher URL verbatim (e.g. `url=https://journals.humankinetics.com/view/...`
> or `url=https://www.tandfonline.com/doi/abs/10.1080/...`), and a real DOI is
> frequently recoverable straight out of it without an extra Crossref round-trip. Worth
> revisiting once the ingester exists and there's real latency/rate-limit pressure to
> optimize against — not a reason to delay Crossref-based resolution now.

---

## 3. ★ Message IDs are not a safe idempotency key

The instinct to dedupe on "have we processed this Gmail message ID before" is
reasonable but insufficient on its own, and idempotency must rest on the title/DOI
matching engine (§7), never on message ID alone.

**What does NOT hold up:** a specific claim that the *same* alert content arrives
byte-identical under two different message IDs was checked directly against all 8 real
Hanney alerts on file (all "William J. Hanney - new articles," spanning June 2025 to
July 2026) — every one has a distinct SHA-256 of its decoded HTML body and a distinct
date. No duplicate-send case was found in this account's mail. If this becomes
important later, re-verify against a larger sample rather than assuming it from this
note.

**What DOES hold up, confirmed real, and is the actual reason message-ID dedup isn't
enough:** the same underlying paper legitimately arrives as **two structurally
different Gmail messages with two different message IDs**, because Scholar sends one
alert per *followed profile*, not one per paper. The `pair-citation-tag-schellhase` /
`pair-normal-tag-mangum` fixtures (see §4) are exactly this — same paper
("Exploring Job Satisfaction and Intention to Leave Among Athletic Trainers..."), two
different co-authors' alerts, two different message IDs (`19ee9a51105ea002` vs.
`19ef2b90ba9fb35c`), two different template shapes. A message-ID-keyed dedup would
treat these as two unrelated new publications. Only title/DOI matching (§7) correctly
converges them into one record.

---

## 4. ★ The `[CITATION]`-tagged template is real, and materially sparser

Confirmed via the Schellhase/Mangum pair above — the **same paper**, alerted to two
different co-authors, arrived in two structurally different shapes:

| | `pair-citation-tag-schellhase` | `pair-normal-tag-mangum` |
|---|---|---|
| Tag | `[CITATION]` badge before the title | none |
| Headline link | Scholar-internal: `citations?...view_op=view_citation&citation_for_view=...` | Real publisher URL: `scholar_url?url=https://journals.humankinetics.com/...` |
| Snippet | **absent** | present (abstract fragment) |
| Save/Share icon row | **absent** | present (Save, Twitter, LinkedIn, Facebook) |
| Byline (truncated) | `KC Schellhase, A Weston, A Layne, M Ulan…` | `KC Schellhase, W Adam, A Layne, M Ulan…` |

The **byline mismatch is the byline's own smoking gun**: the second author renders as
`A Weston` in one copy and `W Adam` in the other, for what is presumably the same real
co-author. This is further, directly-observed evidence for master plan §5a rule 6 — the
byline must never be parsed for author identity or order under any circumstances, not
just because it's truncated, but because Scholar doesn't even render it consistently
for the same paper.

**Why the `[CITATION]` shape exists:** best guess from the data — it's Scholar's
"we don't have your co-author's version of this citation indexed the normal way, but
we can tell you cited it" shape. Whatever the cause, the parser must extract
`title` + `year` from **both** shapes (the `[CITATION]` shape has no year visible in
this specific byline fragment — confirm at build time whether it's simply absent or
just not visible in this one example), and the merge engine must still converge both
alerts to one publication record, same as any other co-author collision (§7).

---

## 5. Non-Latin titles occur and must not break title extraction

`alert-nonlatin-title-stout` — a real "Jeffrey R Stout - new articles" alert — has a
**Japanese-language title and snippet**:

```
痛みの定量化: 運動科学における疼痛評価の方法論的レビュー
B Antonio, V Gibbs, JR Stout, AW Anderson - Strength and Conditioning Journal, 2026
```

The title link and structure are otherwise identical to every Latin-script fixture —
this isn't a different template, just non-Latin text inside the same `<h3><a
class="gse_alrt_title">` element. The parser must not assume ASCII, must not
transliterate or translate, and must pass the title through verbatim to the Crossref
title search (§5a rule 7) exactly as it would any other title.

---

## 6. ★ Real multi-article emails DO occur — confirmed, corrects an earlier version of this doc

An earlier pass of this document claimed zero genuine multi-article emails turned up
across a 20+ sample and treated `alert-multi-synthetic` as the only available fixture
for that shape. **That conclusion was wrong** — it was a sample-size artifact, not a
structural fact about this account's mail. A later, targeted check
(`subject:"Martine Vanryckeghem"`) surfaced a real one:

`alert-multi-real-vanryckeghem-citations` — "Martine Vanryckeghem - new articles," a
single real Gmail message containing **4 distinct `[CITATION]`-tagged article blocks**,
confirmed by the corrected `class="gse_alrt_title"` count (4, not the CSS-boilerplate-
inflated count):

| # | Title | Year |
|---|---|---|
| 1 | Behavior Assessment Battery for Children and Adolescents who Stutter | 2026 |
| 2 | Behavior Assessment Battery voor Kinderen en Jongeren die Stotteren | 2026 |
| 3 | Behavior Assessment Battery for Adults who Stutter | 2025 |
| 4 | KiddyCAT: Communication Attitude Test for French Preschoolers who Stutter. Hogrefe, France | 2025 |

All four share the identical byline `G Vanryckeghem, M. & Brutten` — yet more evidence
for §5a rule 6 (never parse the byline; it isn't even internally consistent within one
email, let alone across faculty).

**Best guess at cause:** this looks like Scholar batch-indexing several older,
citation-only works (test batteries, a Dutch-language translated edition) into one
digest, rather than several brand-new papers landing in the same window. Whatever the
mechanism, `[CITATION]`-tagged alerts are the shape most likely to bundle multiple
entries — every other real fixture on file (normal-tagged, `[PDF]`-tagged) has exactly
one article.

**★ Year is read per-block, not once per email.** Verified programmatically against
this fixture: each article's `<h3>` title element is immediately followed by its own
sibling `<div style="color:#006621;...">byline - YEAR</div>`, and there is no
email-level year anywhere else in the HTML. Parsing produced `2026, 2026, 2025, 2025` —
matching the table above exactly, confirming the four articles' years are independent,
not a single value read once and applied to all four. **A parser that extracts "the"
year for the email instead of the year adjacent to each individual title block will
silently misattribute publication years across articles the moment it hits a
multi-article email like this one.** This is a direct extension of §5a rule 5
("iterate over every result block") — the field-extraction step must also happen once
per block, not once per email.

**★ Future test case, not resolved here:** titles #1/#2 (the same instrument in English
and Dutch) and #1/#3 (the children's vs. adults' version of the same battery) are
*deliberately* close — near-duplicate titles that are genuinely different publications,
not the same paper twice. `normalizeTitle` (`lib/matching.ts`) will **not** collapse
them (different wording, not just punctuation/case), so they won't false-positive
through the fast matching paths — but they're exactly the shape that could stress the
AI fuzzy-match escape hatch (`lib/matching-ai.ts`) if it's ever asked to compare them
against each other. Flagging this as a real-world regression-test candidate for that
engine's near-duplicate handling once the ingester exists; **not addressed or resolved
in this session.**

**§5a rule 5 ("one email may contain multiple articles; iterate over every result
block") is confirmed necessary, not just defensive.** It is not optional parser
paranoia — real production mail in this account requires it.

`alert-multi-synthetic.json` / `.decoded.html` is **kept alongside** the real fixture
above, not replaced by it. It's a **hand-constructed synthetic**, explicitly labeled as
such (`_synthetic: true` field in the JSON, `[SYNTHETIC FIXTURE]` in the fake article's
own title text, and noted here) — built by duplicating the one real article block from
`alert-single-hanney-olecranon.json` and inserting a second, clearly fictional entry.
It stays useful as a **minimal, controlled** 2-article case (simpler to reason about in
a unit test than the real 4-article `[CITATION]` fixture, which carries more shape to
account for — no snippet, no Save/Share row, non-English text). Treat the real fixture
as the ground-truth proof multi-article emails happen; treat the synthetic as a small,
deliberately simple regression fixture for the same code path.

---

## 7. Fixture directory contents

`tests/fixtures/scholar-alerts/` — each entry is a real Gmail `messages.get(format=full)`
response (`.json`) plus its decoded HTML body (`.decoded.html`), except the one noted
synthetic fixture:

| File (`.json` / `.decoded.html`) | What it covers |
|---|---|
| `alert-single-hanney-olecranon` | Baseline: one article, normal template, snippet + Save/Share row present. |
| `pair-citation-tag-schellhase` | `[CITATION]`-tagged, no-snippet variant — see §4. |
| `pair-normal-tag-mangum` | Normal-tagged variant of the **same underlying paper** as the above — see §3/§4. |
| `alert-nonlatin-title-stout` | Japanese-language title/snippet — see §5. |
| `alert-single-stock-limbdisuse` | Baseline. Same paper used as the Crossref-resolver acceptance-check example (Session 6). |
| `alert-single-fukuda-bioimpedance` | Baseline single-article coverage. |
| `alert-single-norte-acl` | Baseline single-article coverage. |
| `alert-single-backes-polyvictimization` | Baseline single-article coverage; also has a `[PDF]` tag on the headline (a third tag variant, distinct from `[CITATION]` — noted here, not yet analyzed in depth). |
| `alert-multi-real-vanryckeghem-citations` | ★ **Real, 4-article `[CITATION]`-tagged email.** Ground-truth proof multi-article alerts occur. Per-block year extraction confirmed against this fixture. Two pairs of deliberately near-duplicate titles inside it — see §6. |
| `alert-multi-synthetic` | Synthetic, hand-built — not a real Gmail message. Kept as a minimal 2-article regression fixture alongside the real one above. See §6. |

---

## 8. Verification commands

```bash
# Get an access token from the stored refresh token
ACCESS=$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d client_id="$GMAIL_CLIENT_ID" \
  -d client_secret="$GMAIL_CLIENT_SECRET" \
  -d refresh_token="$GMAIL_REFRESH_TOKEN" \
  -d grant_type=refresh_token | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

# The exact §5a rule 1 query
curl -s -H "Authorization: Bearer $ACCESS" \
  "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from%3Ascholaralerts-noreply%40google.com%20subject%3A%22new%20articles%22&maxResults=20" \
  | python3 -m json.tool

# Full payload for one message
curl -s -H "Authorization: Bearer $ACCESS" \
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/<MSG_ID>?format=full" \
  | python3 -m json.tool
```

**Still open, for whenever the ingester session actually starts:**
- Whether the `[CITATION]` shape ever carries a year anywhere in its HTML (not
  confirmed either way from the one real pair on file).
- The `[PDF]`-tag variant seen on `alert-single-backes-polyvictimization` wasn't
  compared structurally against the `[CITATION]` and normal shapes — worth a pass if a
  third real template shows up again.
- **Checked:** zero "new citations" alerts exist anywhere in this account's mail
  (`subject:"new citations"` against the same sender returns `resultSizeEstimate: 0`).
  §5a rule 2's citation-alert exclusion therefore has no real fixture to test against in
  this inbox — the `subject:"new articles"` filter has nothing to exclude here in
  practice. Keep the exclusion logic (it's cheap, and correct in principle — Google
  Scholar's own alert-type distinction is real), but don't expect to find a genuine
  example to build a fixture from unless a different account's mail is checked.
