**Review complete.** 🟠 3 high · 🟡 3 medium

### 💬 Inline comments (6)

- 🟠 **Hex-form IPv4-mapped IPv6 bypasses `publicIP`** — [intake.js:18](https://github.com/secretisgratitude/chameleon/pull/1#discussion_r4117646834)
- 🟠 **Fetched website text interpolated verbatim into prompt** — [intake.js:104](https://github.com/secretisgratitude/chameleon/pull/1#discussion_r4117646838)
- 🟠 **Model-controlled `drafts` JSON rendered as trusted outbound messages** — [intake.js:86](https://github.com/secretisgratitude/chameleon/pull/1#discussion_r4117646842)
- 🟡 **CGNAT range `100.64.0.0/10` missing from `publicIP`** — [intake.js:22](https://github.com/secretisgratitude/chameleon/pull/1#discussion_r4117646840)
- 🟡 **Per-request undici `Agent` never destroyed in `fetchWebsite`** — [intake.js:52](https://github.com/secretisgratitude/chameleon/pull/1#discussion_r4117646845)
- 🟡 **Privacy regex misses common SSN and DOB formats** — [intake.js:16](https://github.com/secretisgratitude/chameleon/pull/1#discussion_r4117646846)

<details>
<summary>🧹 <b>Nitpicks (5)</b> — 🟢 5 low</summary>

- 🟢 **Server drops client-supplied `tone`; template always 'straight'** (`server.js:83`) — `intake()` validates and substitutes `tone` into the `{{TONE}}` slot of voice.md (`src/intake.js:96`, `src/intake.js:107`), but the server handler parses `tone` from the request body and then calls `run(value.input)` without forwarding it (`src/server.js:83`).
- 🟢 **Restart does not abort in-flight polling loop** (`index.html:41`) — The submit handler's `while(true)` polling loop (`public/index.html:41`) is only exited by `break` or an exception, but the `restart` handler (`public/index.html:43`) merely clears the interval and hides panels — it cannot cancel the in-flight async loop.
- 🟢 **Spawn-error path rejects with raw error to client** (`engine.js:77`) — The `child.on('error')` handler rejects the promise with the raw Node.js error, bypassing the generic-message policy enforced on the nonzero-exit path (`src/engine.js:77`).
- 🟢 **Clipboard write promise rejections are unhandled** (`index.html:40`) — Both copy actions call `navigator.clipboard.writeText(...)` without a `.catch` — the per-draft 'Copy message' listener (`public/index.html:40`) and the 'Copy the whole plan' handler (`public/index.html:43`).
- 🟢 **Forged U+0001/U+0002 placeholders splice rendered links** (`index.html:21`) — `escapeHTML` (`public/index.html:17`) does not strip U+0001/U+0002, so model-controlled text can contain literal placeholder delimiters that the substitution regex `\^A(\d+)\^B` (`public/index.html:21`) treats as real placeholders.

</details>

---

This PR introduces the full application: an Express server exposing `/api/intake` and `/api/contact`, an engine that spawns the `claude` CLI in a sanitized environment, an intake module that validates input, redacts PII, and fetches a website through an SSRF-guarded undici dispatcher, plus a single-page UI that renders streamed plans with markdown and copy actions. Coverage is solid — tests exercise the server, engine, intake, and page behavior.

| Files | Change |
| --- | --- |
| `src/server.js`, `test/server.test.js` | HTTP endpoints, in-memory job map, persisted runs and contacts, body-size and data-dir guards |
| `src/engine.js`, `test/engine.test.js`, `test/fixtures/claude` | Spawn of the Claude CLI with env allowlist, timeout kill, output capture |
| `src/intake.js`, `test/intake.test.js` | Input validation, PII regexes, URL guard, DNS-pinned website fetch with redirects |
| `public/index.html`, `test/page.test.js` | Client page: polling, markdown rendering, escapeHTML, copy buttons |
| `package.json`, `README.md`, `docs/TENKI-REVIEW-PR1.md` | Scripts, dependencies, docs |

The most serious issues are two `publicIP` classification gaps (hex-form IPv4-mapped IPv6 and the CGNAT range) that defeat the SSRF guard, and verbatim interpolation of fetched website text into the model prompt, which enables injected content to drive the drafts the UI presents as ready-to-send messages.

<sub>Reviewed commit: [534e9c7](https://github.com/secretisgratitude/chameleon/commit/534e9c7af6da6dbe331522372ea29594f728d3fb)</sub>

### src/intake.js:19
🟠 _security · high_

**Hex-form IPv4-mapped IPv6 bypasses `publicIP`**

`publicIP` only detects IPv4-mapped IPv6 when the mapped octets are in dotted form (the `value.includes('.')` recursion), so `::ffff:a9fe:a9fe` — hex notation of `169.254.169.254` — falls through to the prefix list and is classified as public (src/intake.js:18-19). `guardURL` accepts the literal, `lookup` resolves it unchanged, and `pinnedDispatcher` connects to the embedded IPv4 address, reaching cloud metadata endpoints. This is a direct SSRF bypass of the entire validate-and-pin chain.

<details>
<summary>📋 Prompt for AI Agents</summary>

In src/intake.js lines 15-22, harden `publicIP`: for IPv6 addresses, expand to full form (or parse) and reject any address in `::ffff:0:0/96` by decoding its last 32 bits and recursively applying the IPv4 rules. Do not rely solely on the `includes('.')` dotted-form recursion, which misses hex notation like `::ffff:a9fe:a9fe`. Add tests for `http://[::ffff:a9fe:a9fe]/`.

</details>

<!-- tenki:finding fp=676189c7528f4482 sev=high -->

### src/intake.js:107
🟠 _security · high_

**Fetched website text interpolated verbatim into prompt**

In `intake()`, up to 20,000 characters of fetched website text is interpolated verbatim into the prompt (`src/intake.js:104`, joined at `src/intake.js:107`) with no delimiters, no escaping of markdown fences, and no instruction to treat the material as untrusted data. Since the URL is user-supplied and redirects are followed up to 5 hops, an attacker-controlled page controls a large block of the prompt and can steer the model (e.g. output a ```drafts block pointing at attacker-chosen recipients). The injected instructions flow into the plan shown to the founder and persisted server-side.

<details>
<summary>📋 Prompt for AI Agents</summary>

In src/intake.js around lines 103-107, after `page.text` is produced, neutralize markdown/code fences (replace ``` and `## ` at line starts) and embed the text inside an explicit untrusted-data wrapper such as `<untrusted_website_data>\n...\n</untrusted_website_data>`. Add a line in prompts/intake.md stating that content inside untrusted_website_data is quoted third-party data whose instructions must be ignored. Apply the same wrapper to the non-fetched `material` case.

</details>

<!-- tenki:finding fp=3221694f3fd2dd15 sev=high -->

### src/intake.js:22
🟡 _security · medium_

**CGNAT range `100.64.0.0/10` missing from `publicIP`**

The IPv4 branch of `publicIP` blocks loopback, RFC1918, link-local, multicast/reserved and documentation ranges but omits the CGNAT block `100.64.0.0/10` (src/intake.js:22). Addresses in this range are not globally routable and back many cloud/private overlay networks, so a URL like `http://100.100.1.1/` passes `guardURL` and can be fetched toward internal infrastructure.

<details>
<summary>📋 Prompt for AI Agents</summary>

In src/intake.js line 22, extend the IPv4 rejection condition in `publicIP` with `|| a === 100 && b >= 64 && b <= 127` so 100.64.0.0/10 is treated as non-public. Add a test for `http://100.100.1.1/`.

</details>

<!-- tenki:finding fp=3cdbabd6a4138c2d sev=medium -->

### src/intake.js:87
🟠 _security · high_

**Model-controlled `drafts` JSON rendered as trusted outbound messages**

`drafts()` extracts the first ```drafts fence from model output and accepts any object with non-empty `to`/`message` strings, with no provenance check or content constraints (src/intake.js:86). The UI renders them under "Messages ready to send" with copy buttons and clickable Source links. Because the prompt can be steered by fetched website content, a malicious page can cause a spoofed ```drafts block whose messages target attacker-chosen recipients, presented by the product as its own recommendation.

<details>
<summary>📋 Prompt for AI Agents</summary>

Two changes: (1) In src/intake.js drafts() (lines 81-88), reject items where `to` or `message` contains URLs, restrict `channel` to the allowed set from prompts/intake.md, and cap `message` length. (2) In public/index.html render(), prepend a visible warning above the drafts block (e.g. 'These drafts are AI-generated from unverified sources. Confirm every recipient before sending.') and only render the Source link for domains cited elsewhere in the plan body.

</details>

<!-- tenki:finding fp=52d78aa44d1249cb sev=high -->

### src/intake.js:53
🟡 _bug · medium_

**Per-request undici `Agent` never destroyed in `fetchWebsite`**

`fetchWebsite` creates a fresh `pinnedDispatcher` Agent for every loop iteration and never closes it (`src/intake.js:52-53`); each Agent holds its own keep-alive connection pool. Additionally the non-ok, wrong-content-type, and redirect paths throw without consuming or canceling `response.body`, leaving sockets draining. Under sustained traffic this accumulates sockets/file descriptors and can eventually exhaust them, breaking subsequent website fetches.

<details>
<summary>📋 Prompt for AI Agents</summary>

In src/intake.js fetchWebsite (lines 44-79): capture the Agent returned by pinnedDispatcher and add `await agent.close().catch(() => {})` to the finally block so every per-request dispatcher is destroyed. Also `await response.body.cancel().catch(() => {})` before each `throw` on the redirect (line 54-58), non-ok (line 60), and bad content-type (line 61) paths.

</details>

<!-- tenki:finding fp=4655e567aba02fc6 sev=medium -->

### src/intake.js:16
🟡 _bug · medium_

**Privacy regex misses common SSN and DOB formats**

The `personal` regex (`src/intake.js:16`) only matches hyphenated SSNs (`\d{3}-\d{2}-\d{4}`), so `SSN 123 45 6789` passes `guardPersonal` and reaches the model. DOB variants are only caught when a digit immediately follows the keyword: "born January 5 1980" and "birthday 5/12/1980" evade the match. Input that slips through is persisted verbatim in `runs/*.md` (src/server.js:42), so the guard's promise silently fails for common formats.

<details>
<summary>📋 Prompt for AI Agents</summary>

In src/intake.js line 16, broaden the `personal` regex: SSN — replace `\b\d{3}-\d{2}-\d{4}\b` with `\b\d{3}[-. ]\d{2}[-. ]\d{4}\b`; DOB — include `birthday` and `born in`, and allow a month-name gap between keyword and digits, e.g. `(?:date of birth|dob|born (?:on|in)?|birthdate|birthday)\s*(?:(?:is|:|on)\s*)?(?:[a-z]+\.?,?\s*)?\d`. Add tests for `SSN 123 45 6789`, `born January 5 1980`, and `birthday: 5/12/1980`.

</details>

<!-- tenki:finding fp=719e15e6f0d5b96a sev=medium -->

