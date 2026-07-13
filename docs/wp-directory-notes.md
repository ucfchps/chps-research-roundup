# WordPress Directory — REST API Notes

**Purpose:** Session 4 (`sync-roster`) codes against this file. Claude Code cannot browse.
Everything here was pulled by hand from the live directory and from full CSV exports.

**Verified:** July 2026.
**Counts current as of the July 2026 export.**

---

## 1. Endpoint

```
WP_DIRECTORY_API_URL=https://healthprofessions.ucf.edu/wp-json/wp/v2/person
```

- CPT slug: `person`
- **ACF fields are already exposed in REST.** No `register_meta` / `functions.php` work needed.
  The build-blocker flagged in master plan §4 is **CLEARED**. Every record returns a full
  `acf` object.
- The default payload is roughly 60% Yoast SEO metadata. Always trim:
  `?per_page=100&_fields=id,slug,title,acf,departments,class`
- Pagination: `page` + `per_page` (max 100). Follow to the end — stopping at page 1 silently
  truncates the roster. Read `X-WP-TotalPages` / `X-WP-Total`.

---

## 2. Field map (REST JSON → `faculty` table)

| `faculty` column | REST path | Notes |
|---|---|---|
| `wp_id` | `id` | Top-level WP post ID. Stable. |
| `slug` | `slug` | e.g. `matt-stock`. Cosmetic segment of `/review/{slug}/{token}` (§8b). |
| `full_name` | `title.rendered` | e.g. `Matt Stock` |
| `display_name` | *derived* | Citation form. Build with `toCitationName()` from `acf.profile_F_name` + `acf.profile_L_name`. **Do NOT split `title.rendered`.** See §6. |
| `email` | `acf.email_address` | Required by §8b review emails. |
| `unit` | *derived* | From the `departments[]` term-ID array via `unitForDepartmentTerms()`. See §5. **Nullable.** |
| `research_profile_url` | `acf.google_scholar` | ★ **Misleading ACF key — see §3.** |
| `scholar_user_id` | *parsed* | From the above, **only when the host is `scholar.google.com`**. See §4. |
| `orcid` | `acf.orcid` | ★ New field, added July 2026, populated by hand. |
| `classification` | `class[]` / export column `Classification` | Multi-valued, pipe-separated. **Metadata only — never a roster filter on its own.** See §7. |
| *(unused)* | `acf.curriculum_vitae`, `acf.research_info`, `acf.lab_affiliations`, `acf.website_url`, `acf.linkedin_url`, … | Available; not needed. |

**Removed from the schema:** `researchgate_url`. It has no source — ResearchGate links live
*inside* `acf.google_scholar`, the same field as Scholar links. See §3.

Decode HTML entities on all taxonomy names (the source emits `&amp;`) — though you should be
keying on term IDs anyway (§5).

---

## 3. ★ `google_scholar` is a generic research-profile field

The ACF field is a plain URL input. Faculty put **whatever research profile they prefer** in
it. Google Scholar is the most common; it is not the only one. Observed hosts:

| Host | Layer 1 (Scholar alerts) possible? |
|---|---|
| `scholar.google.com` | ✅ yes |
| `www.researchgate.net` | ❌ no |
| `www.ncbi.nlm.nih.gov` (MyNCBI public bibliography) | ❌ no |
| `doi.org` — *a single paper DOI in a profile field; a data-entry error* | ❌ no |

**Consequences:**

1. The column is `research_profile_url`, not `scholar_url`. The old name implies a guarantee
   the data does not make.
2. `scholar_user_id` is **nullable**, populated only when the host is `scholar.google.com`.
3. Faculty with a non-Scholar profile are **legitimately outside Layer 1, permanently.** They
   are discoverable only via Crossref / PubMed / ORCID. The §11 coverage report must present
   this as a **fact, not a task** — there is no Google Scholar alert to create for someone who
   has no Google Scholar profile. Listing them as a to-do wastes a human's year.
4. The `doi.org` entry is a genuine bad link and belongs in the "Fix this directory link"
   bucket.

---

## 4. Scholar URL variants — the parser fixture set

**Every real Scholar URL in the directory parses cleanly.** The master plan predicted `http://`,
trailing `&`, shortened links, and typos. There are none. Do not build defenses against
problems that don't exist — but **do** guard the hostname, which is a real problem (§3).

```ts
function scholarUserId(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    if (u.hostname !== 'scholar.google.com') return null;   // ★ §3 — the field is generic
    return u.searchParams.get('user');                      // case-sensitive; never lowercase
  } catch {
    return null;                                            // never throw — nightly job
  }
}
```

Real variants present in the data — all handled by `searchParams`:

| Variant | Example |
|---|---|
| `hl` before `user` | `citations?hl=en&user=USILmqcAAAAJ` |
| `hl` after `user` | `citations?user=EyvTMEcAAAAJ&hl=en` |
| bare `user` only | `citations?user=fMcpEBMAAAAJ` |
| `view_op` prefix | `citations?view_op=list_works&hl=en&user=fHWxOCAAAAAJ` |
| `oi=sra` suffix | `citations?user=PhpZGb0AAAAJ&hl=en&oi=sra` |
| `oi=ao` suffix | `citations?user=rI2eHEwAAAAJ&hl=en&oi=ao` |
| kitchen sink | `citations?hl=en&tzom=240&user=P13Ahy4AAAAJ&view_op=list_works&sortby=pubdate` |

**IDs are case-sensitive** and contain `_` and `-`: `hs_VC0kAAAAJ`, `l_2K_NgAAAAJ`,
`W-E8_LwAAAAJ`. Never lowercase, never regex out the alphanumerics.

**Must return `null`:** the ResearchGate, NCBI, and `doi.org` URLs; empty string; `null`;
malformed input.

---

## 5. ★ Units: map from taxonomy TERM IDs, never from names

`departments` is a taxonomy array of term IDs, and **a person can be in several**
(`Physical Therapy` + `Exercise Physiology & Rehabilitation Science`;
`Communication Sciences and Disorders` + `Dean's Office`).

Term names carry HTML entities (`&amp;`) and smart quotes (`Dean’s Office` in one view,
`Dean's Office` in another). **Key on the ID.**

```ts
const DEPARTMENT_TERM_TO_UNIT: Record<number, Unit> = {
  166: 'School of Communication Sciences and Disorders',   // communication-sciences-and-disorders
  232: 'Department of Health Sciences',                    // health-sciences
   83: 'School of Social Work',                            // social-work
  204: 'School of Kinesiology and Rehabilitation Sciences',// kinesiology
  239: 'School of Kinesiology and Rehabilitation Sciences',// physical-therapy
  253: 'School of Kinesiology and Rehabilitation Sciences',// athletic-training
  439: 'Center for Autism and Related Disabilities',       // center-for-autism-and-related-disabilities
};

// NOT roundup units. Ignore them. Never guess.
//   71  deans-office
//  442  exercise-physiology-rehabilitation-science   (a research area, not a home department)
//  311  communication-disorders-clinic
//  446  center-for-behavioral-health-research-and-training
//  332  faast-assistive-technology-center
// 1208  tats
//  519  ucf-it
```

**Verified: all 124 faculty resolve to exactly ONE canonical unit under this map.** But
`sync-roster` must *assert* that, not assume it (§15.11):

- **0 matches** → import, leave `unit` NULL, **report the person**. Do not guess.
- **2+ matches** → import, leave `unit` NULL, **report the person**. **Never take the first
  term** — taxonomy array order is not meaningful and must never be treated as "primary."

---

## 6. ★ The name fields are dirty — normalize, and flag rather than mangle

`acf.profile_F_name` is **not a first name.** It contains middle initials, middle names,
parenthetical nicknames, and curly apostrophes. **12 of 124 records are affected:**

| First Name (as stored) | Last Name | Problem |
|---|---|---|
| `Nicole Dawson` | `Loughran` | middle name |
| `Michael J.` | `Rovito` | initial in given-name field |
| `Kristen Couper` | `Schellhase` | middle name |
| `Eunkyung Muriel` | `Lee` | middle name |
| `Todd R.` | `Fix` | initial in given-name field |
| `Xiaochuan (Sharon)` | `Wang` | nickname |
| `L. Colby` | `Mangum` | initial in given-name field |
| `Asli Cennet` | `Yalim` | middle name |
| `Carrie Dawson` | `Loughran` | middle name |
| `Latifa S.` | `Abdelli` | initial in given-name field |
| `A’Naja` | `Newsome` | curly apostrophe |
| `Caitlin Ann` | `Cheruka` | middle name |

**Two separate problems, two separate functions** (`lib/names.ts`, Session 3.5):

**`normalizeGivenName()`** — for external API lookups (ORCID, Crossref). An exact-match query
for a person whose given name is literally `"Michael J."` returns **nobody**. This is not
hypothetical: it is how the college's most-published Health Sciences researcher went missing
from the first ORCID pass. Strip initials (leading *and* trailing), strip parenthetical and
quoted nicknames, drop middle names, straighten curly apostrophes.

```
Michael J.          -> Michael
L. Colby            -> Colby        (leading initial — the common bug)
Xiaochuan (Sharon)  -> Xiaochuan
Eunkyung Muriel     -> Eunkyung
A’Naja              -> A'Naja
```

**`toCitationName()`** — for the roundup itself (`"Zraick, R.I."`). ★ **Returns a `confident`
flag. Where the input is ambiguous, flag it — do not mangle it.** A wrong citation name is a
visible error in a public post under the college's name.

> ### ⚠️ The Dawson Loughran case
> Two records store First Name = `Nicole Dawson` / `Carrie Dawson`, Last Name = `Loughran`.
> The surname is almost certainly **"Dawson Loughran"**, split wrong in the directory. Naïve
> handling produces `Loughran, N.D.` when the correct citation is `Dawson Loughran, N.`
> This is exactly what `confident: false` exists to catch. It is also worth fixing in
> WordPress.
>
> Same class of problem: `Humberto Lopez Castillo`, `Martha Garcia-Stout`,
> `Deena Schwen Blackett` — compound and hyphenated surnames. Flag, don't guess.

---

## 7. ★ The roster filter — a correctness issue, not a preference

**Do NOT filter on the `class` taxonomy alone.** Two real failures:

1. **Ann Eddins** is classified `Leadership` *only* — not `Faculty`. She has a Google Scholar
   profile and publishes. A `class = Faculty` filter silently drops her.
2. **Center for Autism and Related Disabilities has ZERO faculty-classified people.** All 23
   CARD directory entries are classed `Staff` — yet CARD is a canonical roundup unit and
   appears in the live Spring/Summer 2025 post. **A class-only filter erases an entire unit.**

**The rule:**

```
Include a person in the roster IF:
      classification contains 'Faculty' OR 'Leadership'
   OR research_profile_url is non-empty
```

Self-healing: the moment a CARD staff member adds a research profile link to their directory
entry, they enter the roster automatically. No hardcoded allowlist to maintain.

> **CARD will sync to zero until someone acts.** Surface that loudly in the coverage report —
> "canonical unit with no roster members" — rather than letting it be discovered as an empty
> section in a published post (§15.11).

---

## 8. Counts

**Superseded by a live `sync-roster` run, July 2026.** The table below is what the CSV exports
predicted; the one after it is what the actual WordPress→Turso sync produced. Trust the second
one — it is the system, not a sample.

### 8a. Live sync-roster result (authoritative)

| | Count |
|---|---|
| Faculty+Leadership synced into `faculty` | **129** |
| with `scholar_user_id` populated | **50** |
| with `orcid` populated | **47** |
| second run (idempotency check) | 0 inserted, 0 deactivated ✅ |

Matches the export-based prediction closely enough to confirm the hostname guard is working
(50, not ~55 — i.e. not over-matching ResearchGate/NCBI/DOI links as Scholar profiles) and the
roster filter is working (129, not 124 — i.e. Ann Eddins and Leadership-classified people are
correctly included).

> **These numbers will keep drifting** — every time a faculty member adds or changes a profile
> link, they move. Don't treat 50 or 47 as a fixed target for future runs; treat "close to the
> last known-good figure, and moving in a sane direction" as the real signal. A big jump toward
> 55+ on Scholar specifically would still indicate a regressed hostname guard.

> **Still outstanding — do this once, by hand, before treating the join key as fully proven:**
> open one real synced faculty member's actual Google Scholar profile in a browser and confirm
> the `user=` parameter matches `faculty.scholar_user_id` character-for-character, including
> capitalization. Querying the database back against itself (which the acceptance check does)
> proves internal consistency, not correctness against the live outside world — only a human
> eyeballing the real page closes that gap.

### 8b. Original CSV-export estimate (historical — kept for context only)

| | Count | of 124 |
|---|---|---|
| Faculty+Leadership in the export | 124 (later 129 once Leadership was included) | |
| with a research-profile URL | 55 | 44% |
| …of which are **Google Scholar** | 49 | 40% |
| …of which are another host (ResearchGate / NCBI / bad link) | 6 | 5% |
| with an **ORCID iD** | 47 | 38% |
| ★ **with NEITHER Scholar nor ORCID** | 59 | 48% |

No duplicate `scholar_user_id` values were found in the export, and the live sync confirms the
`UNIQUE` constraint did not trip.

**By unit (export-based estimate — not yet re-derived from the live sync):**

| Unit | Faculty | Scholar | ORCID |
|---|---|---|---|
| School of Communication Sciences and Disorders | 40 | 13 | 14 |
| School of Social Work | 36 | 11 | 14 |
| School of Kinesiology and Rehabilitation Sciences | 28 | 14 | 15 |
| Department of Health Sciences | 20 | 11 | 4 |
| **Center for Autism and Related Disabilities** | **0** | 0 | 0 |

> ⚠️ **Confirmed across three separate exports (May 27 → two July pulls) AND the live
> `sync-roster` coverage report.** CARD is not an export artifact — it is a standing, real gap.
> Escalate to CARD directly; do not wait on another directory export or sync run to reveal it.

> **Read these numbers before trusting the pipeline.** Roughly half the faculty have no
> machine-readable identifier at all. Those people are discoverable only by Crossref *name
> search* — the weakest and most false-positive-prone path in the system (§7 of the master
> plan). The roundup will under-report them, and the review page (§8b) is where that gets
> caught. Do not mistake "the job ran clean" for "we found everyone."

**Acceptance-check tripwires — RESOLVED as of the live Session 4 run (kept for reference):**
- `scholar_user_id` came back at 50 — within a few of the ~49 estimate, not near 55+. Hostname
  guard confirmed working.
- Total roster came back at 129 — matches the Faculty+Leadership export, not the
  Faculty-classification-only figure of 124. Roster filter confirmed working.

---

## 9. ★ ORCID is stored as a URL, not an iD

The `orcid` ACF field is a URL field. All 47 values are full URLs:

```
https://orcid.org/0000-0002-7568-8909
```

The ORCID API and Crossref both want the **bare iD**. `sync-roster` needs an `orcidId()`
parser — a sibling of `scholarUserId()`, same discipline:

```ts
function orcidId(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    if (u.hostname !== 'orcid.org' && u.hostname !== 'www.orcid.org') return null;
    const m = u.pathname.match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/);   // ★ final char may be X
    return m ? m[1] : null;
  } catch {
    return null;                                    // never throw — nightly job
  }
}
```

**The trailing `X` is real** — ORCID's last character is a checksum digit that can be `X`.
A `\d{4}` on the final group silently drops those people.

Store the bare iD in `faculty.orcid`. Reconstruct the URL for display if needed.

---

## 10. Sample records — GROUND TRUTH

Real, public directory data. **Session 4's tests are written against these.** Chosen
deliberately to cover every edge case in §3–§7.

### Michael J. Rovito  ·  wp_id `1163`
```
First Name        : Michael J.
Last Name         : Rovito
Departments       : Health Sciences
Google Scholar    : https://scholar.google.com/citations?user=PhpZGb0AAAAJ&hl=en&oi=sra
Orcid URL         : https://orcid.org/0000-0001-8086-3460
Classification    : Faculty
Email             : michael.rovito@ucf.edu
```
→ `scholar_user_id` = `PhpZGb0AAAAJ`

### Matt S. Stock  ·  wp_id `1216`
```
First Name        : Matt
Last Name         : Stock
Departments       : Physical Therapy|Exercise Physiology &amp; Rehabilitation Science
Google Scholar    : https://scholar.google.com/citations?user=hs_VC0kAAAAJ&hl=en
Orcid URL         : https://orcid.org/0000-0003-1156-1084
Classification    : Faculty
Email             : matt.stock@ucf.edu
```
→ `scholar_user_id` = `hs_VC0kAAAAJ`

### Nicole Dawson Loughran  ·  wp_id `1153`
```
First Name        : Nicole Dawson
Last Name         : Loughran
Departments       : Physical Therapy|Exercise Physiology &amp; Rehabilitation Science
Google Scholar    : https://scholar.google.com/citations?hl=en&user=NJ_hCq0AAAAJ
Orcid URL         : (empty)
Classification    : Faculty
Email             : nicole.dawson@ucf.edu
```
→ `scholar_user_id` = `NJ_hCq0AAAAJ`

### Xiaochuan (Sharon) Wang  ·  wp_id `2617`
```
First Name        : Xiaochuan (Sharon)
Last Name         : Wang
Departments       : Social Work
Google Scholar    : (empty)
Orcid URL         : (empty)
Classification    : Faculty
Email             : xiaochuan.wang@ucf.edu
```
→ `scholar_user_id` = `NULL`

### L. Colby Mangum  ·  wp_id `3031`
```
First Name        : L. Colby
Last Name         : Mangum
Departments       : Athletic Training|Exercise Physiology &amp; Rehabilitation Science
Google Scholar    : https://scholar.google.com/citations?hl=en&user=5yIzMuQAAAAJ
Orcid URL         : https://orcid.org/0000-0001-6443-2951
Classification    : Faculty
Email             : lauren.mangum@ucf.edu
```
→ `scholar_user_id` = `5yIzMuQAAAAJ`

### Kimberley Gryglewicz  ·  wp_id `973`
```
First Name        : Kimberley
Last Name         : Gryglewicz
Departments       : Social Work|Center for Behavioral Health Research and Training
Google Scholar    : https://www.researchgate.net/profile/Kim_Gryglewicz
Orcid URL         : https://orcid.org/0000-0003-4395-2354
Classification    : Faculty
Email             : kgryglew@ucf.edu
```
→ `scholar_user_id` = `NULL`

### Steven Burroughs  ·  wp_id `9763`
```
First Name        : Steven
Last Name         : Burroughs
Departments       : Health Sciences
Google Scholar    : https://doi.org/10.1210/me.2012-1101
Orcid URL         : (empty)
Classification    : Faculty
Email             : Steven.Burroughs@ucf.edu
```
→ `scholar_user_id` = `NULL`

### Krista Jung  ·  wp_id `21215`
```
First Name        : Krista
Last Name         : Jung
Departments       : Communication Sciences and Disorders
Google Scholar    : https://www.ncbi.nlm.nih.gov/myncbi/1vG3CqHb_6cEik/bibliography/public/
Orcid URL         : (empty)
Classification    : Faculty
Email             : krista.jung@ucf.edu
```
→ `scholar_user_id` = `NULL`

### Erin Leeming  ·  wp_id `23430`
```
First Name        : Erin
Last Name         : Leeming
Departments       : Communication Sciences and Disorders
Google Scholar    : https://www.researchgate.net/scientific-contributions/Erin-Leeming-2333782918
Orcid URL         : (empty)
Classification    : Faculty
Email             : erin.leeming@ucf.edu
```
→ `scholar_user_id` = `NULL`

### Deena Schwen Blackett  ·  wp_id `21309`
```
First Name        : Deena
Last Name         : Schwen Blackett
Departments       : Communication Sciences and Disorders
Google Scholar    : https://www.researchgate.net/profile/Deena-Schwen-Blackett
Orcid URL         : (empty)
Classification    : Faculty
Email             : deena.blackett@ucf.edu
```
→ `scholar_user_id` = `NULL`

### A’Naja Newsome  ·  wp_id `16759`
```
First Name        : A’Naja
Last Name         : Newsome
Departments       : Health Sciences
Google Scholar    : https://scholar.google.com/citations?user=mbxW_CUAAAAJ&hl=en
Orcid URL         : https://orcid.org/0000-0002-4916-0705
Classification    : Faculty
Email             : anaja.newsome@ucf.edu
```
→ `scholar_user_id` = `mbxW_CUAAAAJ`

### Ethan Hill  ·  wp_id `5690`
```
First Name        : Ethan
Last Name         : Hill
Departments       : Kinesiology|Exercise Physiology &amp; Rehabilitation Science
Google Scholar    : https://www.researchgate.net/profile/Ethan_Hill
Orcid URL         : https://orcid.org/0000-0002-5573-3370
Classification    : Faculty
Email             : Ethan.Hill@ucf.edu
```
→ `scholar_user_id` = `NULL`

### Shellene Mazany  ·  wp_id `997`
```
First Name        : Shellene
Last Name         : Mazany
Departments       : Social Work
Google Scholar    : (empty)
Orcid URL         : https://orcid.org/0009-0004-6362-4256
Classification    : Faculty
Email             : shellene.mazany@ucf.edu
```
→ `scholar_user_id` = `NULL`

### Ann Eddins  ·  wp_id lookup by title (fixture: §7 roster filter)
```
First Name        : Ann
Last Name         : Eddins
Departments       : Communication Sciences and Disorders
Google Scholar    : https://scholar.google.com/citations?view_op=list_works&hl=en&user=mG0VWxkAAAAJ
Orcid URL         : (empty)
Classification    : Leadership          ← NOT "Faculty". This is the case §7 exists for.
```
→ `scholar_user_id` = `mG0VWxkAAAAJ`
→ Included under the filter (`Faculty OR Leadership OR has-profile`) — a `class=Faculty`-only
  filter would silently drop her. **This is the real regression test for §7.**

> Note: a separate person, **David Eddins**, is `Faculty` in the same department with no
> profile URL. Different `wp_id` — the join key is unaffected — but worth a sanity check that
> `sync-roster` doesn't conflate same-surname records anywhere in matching or logging.

### Andrea Velez  ·  fixture: unit = NULL, reason "no canonical unit"
```
Departments       : Dean's Office
Classification    : Leadership
```
→ Resolves to **zero** canonical units. `unit` must be NULL, and the person must be **imported
  and reported**, not dropped and not defaulted. First real (non-synthetic) fixture for this
  path.

### Darla Olive Talley  ·  same case as above
```
Departments       : Dean's Office
Classification    : Leadership|Staff
```
→ Same `unit = NULL` path. Also exercises multi-valued classification with `Staff` present —
  confirms `classification` must never be parsed as a single enum value.

> **Never present in a CSV export, but confirmed live via direct REST query:** Fabiola Gomez,
> `departments: [439]` (Center for Autism and Related Disabilities), classed `Staff`, with an
> empty `orcid` field and no `research_profile_url`. Pulled directly from the live
> `/wp/v2/person` endpoint during Session 4 verification — not from a people-export, which is
> notable in itself: CARD staff don't surface in the exports COMMS normally pulls, only in a
> raw API query. This is not a script or filter problem — it is a real, standing gap in CHPS's
> data, now confirmed by a named, live example. **Escalate directly to CARD.**

---

## 11. Verification commands

```bash
# Trimmed roster pull
curl -s "https://healthprofessions.ucf.edu/wp-json/wp/v2/person?per_page=100&_fields=id,slug,title,acf,departments,class"

# Confirm the new ORCID field is exposed
curl -s "https://healthprofessions.ucf.edu/wp-json/wp/v2/person?per_page=1" | grep -i orcid

# Totals
curl -sI "https://healthprofessions.ucf.edu/wp-json/wp/v2/person?per_page=100" | grep -i x-wp

# Taxonomy term maps
curl -s "https://healthprofessions.ucf.edu/wp-json/wp/v2/departments?per_page=100&_fields=id,name,slug"
curl -s "https://healthprofessions.ucf.edu/wp-json/wp/v2/class?per_page=100&_fields=id,name,slug"
```

**Still open:** `X-WP-Total` / `X-WP-TotalPages` for the full `person` collection.
