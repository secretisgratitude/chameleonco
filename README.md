# Chameleon

The AI co-founder that gets you your first customer. Built during the AI Co-Founder Hackathon
(Sept 2026). AdaL wrote the harness, Tenki reviewed every pull request, Nebius runs the non-web
steps (DeepSeek V4 Pro), Claude does the web research, and AIsa checks each named buyer against
Apollo's company database (`src/aisa.js`). Build spec: `docs/SPEC.md`.

`prompts/` holds the expert briefs and the voice.

## Run locally

Requires Node 20+; no install step or third-party dependencies. From this repository:

```sh
ENGINE=fake npm start
```

Open http://127.0.0.1:4700 for the story page; the tool itself is at http://127.0.0.1:4700/app.
Paste a public website URL or describe an idea. The fake engine
returns a complete example plan and three **template** draft messages, not sourced leads.
The server fetches a pasted website before generating a plan with the fake or Nebius backend,
so network access to that website is required. The Claude backend fetches the website with its
restricted web tools. Plans are shown on the page, with copy buttons; they are not sent to
buyers. The opt-in saves a contact for future follow-up; this phase does not deliver emails or
Telegram messages automatically.

```sh
npm test                  # node --test
ENGINE=claude npm start   # requires a local `claude` CLI configured to run
ENGINE=nebius npm start  # requires NEBIUS_API_KEY and NEBIUS_MODEL
```

## The Telegram follow-up bot

```sh
TELEGRAM_BOT_TOKEN=... TELEGRAM_TEAM=123456789 npm run bot
```

`/intake <text>` runs the same plan as the page and turns each draft into a thread with
"I sent it" and "Skip" buttons. `/reply <n> <what they said>` re-plans that thread from the
buyer's reply. `/won <n>` and `/lost <n>` close a thread. `/threads` lists every thread and its
status; `/next` names the single best next action. Threads that sit "sent" with no reply for
3 days get one follow-up nudge, at most twice, and a 9 AM check-in runs once per calendar day.
Threads are stored at `DATA_DIR/threads.json`; chat ids outside `TELEGRAM_TEAM` are ignored.

## Environment

| Variable | Meaning |
| --- | --- |
| `ENGINE` | `fake`, `claude`, or `nebius`; default `fake` when `NODE_ENV=test`, otherwise `claude`. |
| `HOST` | Listen address, default `127.0.0.1`. |
| `PORT` | Listen port, default `4700`. |
| `DATA_DIR` | Private data directory, default `~/.chameleon`. Must be outside the repository. |
| `NEBIUS_API_KEY` | API key for Nebius chat completions. |
| `NEBIUS_MODEL` | Model name for Nebius chat completions. |
| `NEBIUS_BASE_URL` | API base URL, default `https://api.studio.nebius.com/v1/`. |
| `TELEGRAM_BOT_TOKEN` | Bot token for the Telegram follow-up bot (`npm run bot`). |
| `TELEGRAM_TEAM` | Comma-separated allowed Telegram chat ids; every other chat is ignored. |

## Privacy and limits

Inputs and results are private. Finished plans are saved under `DATA_DIR/runs/`; opted-in
contacts are appended to `DATA_DIR/contacts.jsonl`. Directories use mode `0700` and files
`0600`. Never point `DATA_DIR` inside the repository. Secrets come from environment variables;
`.env` is ignored. The Claude child runs from a fresh temporary directory with only
`WebSearch,WebFetch` available for website input and no tools otherwise; its environment
omits `ANTHROPIC_API_KEY` and `*_TOKEN` variables. Avoid pasting customer or patient details.
The server refuses recognizable identifiers, private/localhost/file URLs, and oversized
inputs. There are at most ten simultaneous runs. Contact opt-in does not grant permission to
send any buyer messages; the founder reviews and sends them personally.
