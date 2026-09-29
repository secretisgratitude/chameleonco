FILE src/intake.js:39
🟠 _security · high_

**DNS rebinding bypasses `fetchWebsite` IP checks**

`fetchWebsite` validates the hostname with `lookup(..., { all: true })` and `publicIP`, but the subsequent `fetch(url)` at `src/intake.js:39` performs its own fresh DNS resolution, so a low-TTL attacker-controlled DNS record can answer the validation query with a public IP and the connection query with `127.0.0.1` or `169.254.169.254`.

The fetched page text is interpolated into the model prompt and the resulting plan is returned to the requester, giving an SSRF read primitive over internal services and cloud metadata. The per-hop `guardURL`/`lookup` loop does not help because rebinding applies at every hop's fetch.

<details>
<summary>📋 Prompt for AI Agents</summary>

In src/intake.js inside fetchWebsite (lines 31-45), eliminate the DNS rebinding TOCTOU: after `await lookup(url.hostname, { all: true })` and the publicIP validation at lines 37-38, pass the validated address set to the HTTP request instead of letting fetch re-resolve at line 39. Use undici's Agent with a custom `connect: { lookup }` dispatcher whose lookup returns only the pre-validated addresses for that hostname, keeping Host header and TLS servername set to the original hostname. Apply the same pinned-address request to every redirect hop. Keep the 10s AbortController and redirect-loop behavior unchanged.

</details>

<!-- tenki:finding fp=ec45a1f53d218c75 sev=high -->

FILE src/engine.js:8
🟠 _security · high_

**Narrow env blocklist leaks secrets to the `claude` child**

`safeChildEnv` strips only `ANTHROPIC_API_KEY` and keys ending in `_TOKEN` (`src/engine.js:8`), so credentials like `AWS_SECRET_ACCESS_KEY`, `OPENAI_API_KEY`, bare `TOKEN`, plural `MY_TOKENS`, or suffix variants such as `X_TOKEN_HEADER` are all exported to the spawned `claude` process.

The child is an LLM CLI executing model-directed tool calls on attacker-influenced prompts, so anything in its environment is one injected instruction away from exfiltration. The test in `test/engine.test.js` at line 219 cements the leaky behavior.

<details>
<summary>📋 Prompt for AI Agents</summary>

In src/engine.js line 8, rewrite safeChildEnv to use an allowlist instead of the blocklist: keep only a fixed set of benign variables (PATH, HOME, SHELL, USER, LANG, LC_ALL, TERM, TMPDIR, TZ) plus any CLAUDE_* vars the CLI needs, and additionally filter out any key matching /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i as a safety net. Update the test in test/engine.test.js (around lines 218-220) to assert that AWS_SECRET_ACCESS_KEY, OPENAI_API_KEY, bare TOKEN, MY_TOKENS, and X_TOKEN_HEADER are all removed while PATH is retained.

</details>

<!-- tenki:finding fp=1029bb9941519988 sev=high -->

FILE src/server.js:61
🟡 _bug · medium_

**`records` Map grows unboundedly with no eviction**

Every accepted `POST /api/intake` inserts a job object holding the full input, result, sections, and drafts into `records` (`src/server.js:61`), and no code path ever deletes from it.

Each completed plan can be tens of KB, so a long-lived server accumulates memory without bound and eventually hits OOM, with no self-healing.

<details>
<summary>📋 Prompt for AI Agents</summary>

In src/server.js createApp (around lines 45-72), add eviction to the `records` Map: when inserting a new job at line 61, evict the oldest finished entries once the Map exceeds a fixed max size (e.g. 500), or schedule deletion of each job a fixed time (e.g. 1 hour) after it reaches 'done' or 'error'. Keep in-flight jobs ineligible for eviction.

</details>

<!-- tenki:finding fp=5fedd48e82e49f50 sev=medium -->

<summary>🧹 <b>Nitpicks (3)</b> — 🟢 3 low</summary>

- 🟢 **Internal engine stderr leaked to clients** (`engine.js:77`) — When the `claude` backend exits non-zero, `think` rejects with `Claude failed: ${errors.slice(0, 300)}` (`src/engine.js:77`), and `createApp` stores that message on the job and returns it verbatim to any client polling the run (`src/server.js:72`).
- 🟢 **8192-byte body limit rejects valid 6000-char input** (`server.js:25`) — `body()` enforces an 8192-byte limit on the raw request stream (`src/server.js:25`) while the handler accepts inputs up to 6000 characters (`src/server.js:56`).
- 🟢 **Stuck progress UI and timer when polling fails** (`index.html:41`) — In the intake submit handler, `clearInterval(clock)` and `$('working').hidden=true` run only after a terminal status is reached (`public/index.html:41`).

</details>
