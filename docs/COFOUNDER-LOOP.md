# The co-founder loop: it works, reasons and delivers without being prompted

Eric, 2026-09-27: "Where's the AI co-founder, not an LLM I have to prompt? Something better than most
human co-founders that works, reasons and delivers."

An agent waits for a command. A co-founder owns the outcome (docs: 01co COFOUNDER-NOT-AGENT). So the
founder prompts exactly once: `/intake` with their website is onboarding, like briefing a new partner
on day one. After that they never prompt again. They answer and they tap. Each chat has a goal; when it falls behind pace, the
co-founder generates its own work, and it stays silent when nothing changes a decision.

## The work cycle (`src/cycle.js`, `runCycle(chatId, { now })`)
Runs every night at 02:00 for each allowed chat, and on demand by the operator with
`npm run cycle` (for demos). It is never a founder command.

1. **Reason over the state.** Read the chat's threads, the ladder (src/ladder.js), the founder's
   promises (drafts marked ready count as promised sends), and the last contact per thread.
2. **01co makes a call on every open item**: exactly one of
   - `decide`: 01co settles it itself (e.g. drop a thread with no reply after 2 follow-ups),
   - `delegate`: hand it to one Chameleon expert (researcher, offer, copywriter, closer),
   - `defer`: park it with a date,
   - `do`: 01co does it now (e.g. schedule the follow-up).
   Each call has one line of why and a confidence (low/medium/high). Rules, in order:
   - a thread with a buyer reply and no re-plan → delegate to **closer**;
   - a ready draft unsent for 2+ days → decide: hold the founder to it (accountability line);
   - a sent thread with no reply after 2 follow-ups → decide: stop it (the stop line);
   - the ladder's current rung unchanged for 3+ days and fewer than 3 live threads →
     delegate to **researcher** (3 new named buyers with sources);
   - 5+ sends and 0 replies → delegate to **offer** (reshape the offer);
   - otherwise → defer to the next cycle.
3. **Chameleon does the delegated work as that expert**: one engine call with the expert's
   prompt (`prompts/experts/<name>.md`) plus the business, the thread and the plan, web tools on.
   Output becomes new ready drafts or an updated thread, each signed with the expert. **Nothing is
   ever sent by the cycle.**
4. **The morning brief** (sent at 9 AM, replacing the plain check-in; the cycle's result is saved in
   `DATA_DIR/cycles/<chat>-<date>.json`). Plain sentences, no exclamation marks:
   ```
   Overnight: <what Chameleon did, by expert, in one line each>
   My calls: <each call: move, item, why>
   I need from you (max 3): <taps, each a button>
   You said: <promise check, e.g. "3 sends by yesterday; 1 went.">
   Stop: <one thing to drop, if any>
   ```

## The plan shows 01co's calls too
`prompts/intake.md` gains a section `## 01co's calls` (every next move labeled decide, delegate to
<expert>, defer to <date>, or do now, with why), and every draft carries `"expert"`. The page
renders the section and signs each draft card "Chameleon, as the <expert>". The bot keeps the label
on threads and re-plans ("Chameleon, as the closer: ...").

## Earned autonomy, real
Internal work (research, drafting) runs without asking: that is the level already earned.
Anything outward (a send) always waits for the founder's tap. The ledger shows both.

## Tests (fake engine, fake Telegram, injected clock)
Each rule picks the right call; delegated work produces drafts signed by the expert and sends
nothing; the brief has at most 3 asks, the promise line, and the stop line when one applies;
`npm run cycle` runs one cycle for every allowed chat; the plan page shows 01co's calls and expert
labels.
