# Chameleon: build spec

Chameleon is the AI co-founder that gets a founder their first customer. A founder pastes their
website (or describes the idea). In about 5 minutes they get why buyers stall, the one fix, an
offer a first buyer can say yes to, their first buyers by name with sources, and messages ready to
send. Then it follows up: the founder says what buyers replied, and it re-plans.

This repo is built from scratch during the hackathon with AdaL. The files in `prompts/` are the
team's prepared material: the expert briefs and the voice. Build the product around them; do not rewrite them unless a phase says so.

## Rules for every phase
- Node 20+, ES modules, **no framework, no dependencies** unless a phase names one. Plain
  `node:http`, `node:test`, `fetch`.
- One command runs everything locally: `npm start` (serves on PORT, default 4700).
- `npm test` runs `node --test`. Every phase ends with its tests green.
- Secrets only from environment variables, never committed. Add `.env` to `.gitignore`.
- Founder input and results are private data: store them under `DATA_DIR` (default
  `~/.chameleon`), created with mode 0700, files 0600. **Never inside the repo.**
- No em dashes in any user-facing text.
- Commit after each working step with a clear message. Do not push; the human pushes.

## Phase 1: the page, the engine, the opt-in (build this first)

### 1. The engine (`src/engine.js`)
One function: `think(prompt, { web: boolean, timeoutMs })` returning the model's text.
Pick the backend with `ENGINE`:
- `fake`: returns a fixed, realistic plan (all the headings from `prompts/intake.md`, plus a
  `drafts` block with 3 messages). Used by tests and demos without a model. **Default when
  NODE_ENV=test.**
- `claude`: spawns the local `claude` CLI: `claude -p --tools WebSearch,WebFetch` (only when
  `web` is true, alongside `--allowedTools WebSearch,WebFetch`; `--tools ""` otherwise, with no `--allowedTools`), prompt on stdin, from a fresh temp directory, with
  `ANTHROPIC_API_KEY` and every `*_TOKEN` variable removed from the child's environment.
  Security rule, from a real incident: `--tools` limits the tools, `--allowedTools` only pre-approves the same list; never use `--allowedTools` alone. The engine must never be able to read local files.
- `nebius`: OpenAI-compatible chat completions at `NEBIUS_BASE_URL` (default
  `https://api.studio.nebius.com/v1/`) with `NEBIUS_API_KEY` and `NEBIUS_MODEL`. This backend has
  no web tools, so when `web` is true, the server fetches the founder's URL itself first (see 2).
- Timeouts: default 12 minutes; on timeout, kill the child and throw a clear error.

### 2. The intake (`src/intake.js`)
`intake(input, { tone })`: builds the prompt = `prompts/voice.md` (with `{{TONE}}` replaced;
straight | pena | gentle, default straight) + `prompts/intake.md` + the founder's material.
- If the input is a bare URL: for `claude`, say "Their website: <url> (fetch it, and any pricing
  or about page it links)". For `nebius`/`fake`, fetch the page server-side (10 s timeout,
  follow redirects, max 2 MB), strip scripts/styles/tags to text, cap at 20,000 characters, and
  include that text. Only http/https URLs; refuse localhost, private IP ranges and file: URLs.
- Refuse input that looks like patient or personal identifiers before any model call: date of
  birth with digits, SSN pattern `\d{3}-\d{2}-\d{4}`, MRN or member id with digits, Medicare MBI
  pattern. Message: "That looks like personal or patient details. Describe the business only."
- Parse the result: `drafts(text)` extracts the fenced JSON array tagged ```drafts or ```json
  (max 8 items, each needs `to` and `message`); `sections(text)` splits on `## ` headings.

### 3. The server (`src/server.js`)
- `GET /` serves `public/index.html`.
- `POST /api/intake` `{input}` (max 6,000 chars, min 12) → `202 {id}`; runs in the background.
- `GET /api/intake/:id` → `{status: working|done|error, result?, error?, seconds}`.
- `POST /api/contact` `{id, contact}`: the opt-in. `contact` must be an email or a Telegram
  handle (`@` + 5 to 32 of letters, digits, underscore). Unknown id → 404. Appends one JSON line
  `{at, id, contact, input (first 300 chars)}` to `DATA_DIR/contacts.jsonl` (mode 0600).
- Every finished run is saved to `DATA_DIR/runs/<timestamp>-<id>.md` with the input and result.
- Limits: at most 10 runs working at once (else 429 "Busy, try again in a minute"); body size
  limits on every POST; JSON errors, never a stack trace to the client.
- Listens on `HOST` (default 127.0.0.1) and `PORT`.

### 4. The page (`public/index.html`, one file, inline CSS and JS)
Brand: ground `#EEF3EC`, ink `#16241A`, leaf `#1F7A45`, sun `#E8B04A`, soft `#E3F1E6`; fonts
Bricolage Grotesque (headings) and Figtree (body) from Google Fonts; dark mode via
`prefers-color-scheme`. Works at 390 px wide with no sideways scroll.
- Header: the name "01co Chameleon" and "The AI co-founder that gets you your first customer".
- Hero headline: "Built the thing. Validated the problem. Nobody will go first." with the small
  line "a founder's real post title, r/startups, September 2026", then: "**Chameleon is the AI
  co-founder that gets you your first customer.** Paste your website or tell it your idea. In a
  few minutes you get why buyers stall, an offer a first buyer can say yes to, who to ask, and
  the first message, written."
- The six gates G0 to G5 as a row (G0 a buyer you can name, G1 the problem is real, G2 someone
  says yes to a next step, G3 a yes to a price, G4 money lands, G5 it happens again). When a plan
  arrives, highlight the gates reached from the "Where you are (gate)" section.
- One textarea (website or idea) and one button: "Show me my first customer". Under it: "Free.
  Nothing is sent to anyone without you. Don't paste customer or patient details."
- While it works: a progress list (reading your business model, looking for what you already
  have, finding where buyers stall, shaping an offer, finding buyers you can reach) and a timer.
- **The opt-in, shown as soon as the run starts:** "Where should Chameleon send your plan and
  follow up?" with one field (email or Telegram @handle) and a button "Keep me posted". Saved →
  "Saved. Chameleon will send your plan to <contact> and check in after you send your messages."
- The result: one card per section; "Questions for you" first; the offer card highlighted; then
  "Messages ready to send": one card per draft with to, org, channel, why, the message, the
  source link, and a "Copy message" button. Then "Copy the whole plan" and "Run another".
- Proof line at the bottom: "We read 112 founders' posts about not getting customers. 85 were
  stuck on the first buyer, not the product: no channel to reach buyers (33), nobody willing to
  go first (21), the wrong medium (19), the wrong message (12). The other 27 had a product or
  pricing problem, which this doesn't fix."
- Render the model's markdown safely: escape everything, then allow headings, lists, bold,
  italics, links (http/https only, `rel="noopener"`), quotes, tables. Never inject raw HTML from
  the model.

### 5. Tests (`test/*.test.js`), all with ENGINE=fake
Engine picks the backend and strips secrets from the child env; the URL guard refuses localhost,
private IPs and file:; the PHI guard refuses the four patterns; drafts parsing (valid, missing,
malformed, more than 8); the server end to end (POST intake → poll → done with sections and
drafts; contact good/bad/unknown id; 429 when busy; body too large); the page contains every
required id and the markdown renderer escapes `<script>`.

### Phase 1 is done when
`npm test` is green, `ENGINE=fake npm start` serves a page where a pasted website produces a full
plan with draft cards, and the opt-in saves a contact. Write `README.md`: what it is, how to run
(fake, claude, nebius), the env vars, and the privacy rules.

## Phase 2: fundamentals and SMART goals (after phase 1 is done)
`prompts/fundamentals.md` scores a business on ten fundamentals and returns JSON; validate it
(all ten F1 to F10, booleans, evidence, a fix on every fail, fix_first names a failed one).
`prompts/goals.md` turns the scorecard into SMART goals; reject any goal without a counted
target above 0, a YYYY-MM-DD date not in the past, and a failed fundamental it fixes; the first
goal must fix fix_first; retry once. Show both on the page under the plan.

## Phase 3: the Telegram follow-up (after phase 2)
A Telegram bot (`src/bot.js`, token from `TELEGRAM_BOT_TOKEN`, allowed chat ids from
`TELEGRAM_TEAM`): `/intake <text>` runs the intake and turns drafts into threads (ready → sent
→ replied → re-planned); buttons "I sent it" and "Skip"; `/reply N <what they said>` re-plans
that thread; follow-up after 3 days, at most 2; `/won N`, `/lost N`; `/threads`; `/next`; a
9 AM check-in. Threads stored in `DATA_DIR/threads.json`. Strangers are ignored.

## Phase 4: the ledger (every co-founder earns its keep)
One page, `public/ledger.html`, served at `GET /ledger`, built from records that already exist.
Nothing is typed in by hand and no number is estimated.
- **Build side**, read at request time: `git log` on all branches, grouped by the `Cofounder:`
  trailer (adal, claude-hack-demo, human). Tenki's findings come from `docs/TENKI-REVIEW-*.md`.
  Each finding is linked to the `fix(...)` commit that closed it. Show: findings raised, findings
  fixed, open findings, tests at each merge.
- **Customer side**, read from `DATA_DIR/threads.json` (phase 3): show a per-thread view
  with the expert Chameleon played, the gate reached (G0 to G5), and the outcome
  (sent, replied, won or lost). Never show buyer names or reply text on the ledger.
- **The rule on the page:** an agent's record is outcomes, not activity. Count gates moved and
  findings closed, never messages written or lines changed. Show activity only next to the
  outcome it produced ("8 drafts → 2 replies → 1 yes to a next step").
- **Earned autonomy:** each role shows its approval level. It is "asks first" until it has 3
  outcomes in a row with no human correction, then "acts, reports after". One correction drops
  it back a level. Store the level in `DATA_DIR/autonomy.json`.
- Tests: grouping by trailer, finding-to-fix linking, a finding with no fix shows as open,
  autonomy goes up after 3 and drops after a correction.
