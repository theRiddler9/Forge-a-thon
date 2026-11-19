# AGENTS.md — ForgePilot (TrueForge Forge-a-thon, Round 1)

You are building a VS Code extension that is a coding agent whose loop runs on TrueForge (https://github.com/truefoundry/trueforge, MIT, Node >= 22.14). Solo developer. Round 1 deadline: **20 Nov 2026, 23:59 IST**. Optimise for the scoring rubric below, not for elegance.

Repo name: `Forge-a-thon` (GitHub repo; the extension's display name can stay "ForgePilot", and the `package.json` name should be lowercase, e.g. `forge-a-thon`). Starting point in write-up: "from scratch" (no upstream fork; do not copy Cline/Continue code, so no licence risk). Licence: MIT.

## 1. Eligibility rules (violating any = disqualified)

1. The agent loop runs on TrueForge local mode: `npx @truefoundry/trueforge@latest` (server defaults to http://localhost:8790, SQLite, no auth).
2. The extension is only a **client**: it creates sessions and sends turns with `@truefoundry/trueforge-sdk` and renders streamed events.
3. **The extension must never call a model provider directly** (no OpenAI/Anthropic/etc. SDK or fetch to a provider). Models are configured inside TrueForge (Settings: catalog provider or OpenAI-compatible endpoint).
4. Editor capabilities (read file, search, find symbol, propose write, run command) are exposed to the agent as **MCP tools** from an MCP server the extension hosts on localhost. The agent decides what to read and change; the extension does not pre-decide.
5. Do not hard-code one provider. No API keys or secrets in git. Ship `config/models.example.yaml` (or similar) only.
6. Repo must contain the agent definition used: `agent/forgepilot.agent.json` (inline `agent.spec`, see section 3).

## 2. Scoring (100) — what to demonstrate on screen

- A1 Inline edit (10): select code, keybinding, instruction, diff in editor with **per-hunk accept/reject**.
- A2 Agent mode (10): panel; one request; agent discovers and edits >= 3 files unprompted.
- A3 Streaming + cancel (10): tokens stream; Cancel is immediate; workspace consistent, no half-applied edits.
- B1 Context (15): automatic retrieval **with a size budget**, strategy stated, and visible in Task B (agent says which files it chose and why). Also @file and @symbol mentions.
- B2 Diff safety (10): per-hunk review + working **undo** of an applied change, shown on screen. No silent writes ever.
- B3 Resilience (10): automatic fallback to a second configured model with no user action, workspace unchanged. (Retry with backoff first, then fallback, then clear error.)
- B4 TrueForge depth (10): MCP tools + TrueForge **tool approval driving the diff review**, plus >= 1 context-engineering feature (subagent for repo exploration and/or deferred tool loading) visible in the session and explained in the write-up.
- C1 Video (10), C2 Write-up (15). Video <= 4 min, editor visible, Tasks A, B, C in order, each followed by on-screen verification, TrueForge session shown briefly during B. Do not cut between giving the instruction and the diff appearing.

## 3. TrueForge API facts

### Verified from trueforge.dev docs / release notes
```ts
import { TrueForge, TrueForgeApi, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
  timeoutInSeconds: 600,
});

// inline agent, no saved agent needed
const { data: session } = await client.sessions.create({
  agent: { spec: {
    model: { name: 'anthropic/claude-sonnet-4-6' }, // a model configured in TrueForge Settings
    instructions: '...',
  } },
});

const stream = await client.sessions.createTurnStream(session.id, {
  input: [{ type: 'user.message', content: '...' }],
});
for await (const { data: event, id } of stream.withMetadata()) { /* id = sequence number */ }
```
- Hierarchy: Agent -> Session -> Turn -> Event -> Delta. One turn runs at a time per session; **a new turn cancels a still-running turn in the same session**.
- Stream starts with `turn.created`, ends with exactly one `turn.done` whose `event.state.status` is `done | cancelled | error`.
- Event types: `model.message` (tool calls live in `model.message.toolCalls`; there is NO top-level `tool.call`), `model.message.delta` (same event id; merge with `isEventDelta`/`mergeEventDelta`; do not append deltas as new items), `tool.response` (refers to `toolCallId`), `tool.approval_required`, `tool.response_required`, `mcp.auth_required`, `mcp.initialize`, `sandbox.created`, `thread.created`/`thread.done` (subagent threads; root thread id is `main`).
- Approval pause: the turn ends `done` with non-empty `requiredActions`. Resume by creating a **new turn in the same session** with input items `{ type: 'user.tool_approval', ..., approval: { status: 'allow' } }` or `{ status: 'deny', reason: '...' }` (one per pending call; check `TrueForgeApi.UserToolApprovalEvent` for exact fields). Each pending call carries `source_event_id` of the `model.message` that proposed it; keep an id-keyed event Map to read tool name + arguments.
- Reconnect: `client.sessions.getTurn`, `subscribeToTurn(sessionId, turnId, { afterSequenceNumber })` (exclusive cursor; 412 means fall back), `listTurnEvents(sessionId, turnId, { order: 'asc' })`.
- Saved agent manifest shape (hosted docs; OSS likely similar): `mcp_servers: [{ name, enable_tools: ['@read-only', ...], require_approval_for_tools: ['@write', ...], preload }]`, `skills[]`, `collaborators[]` (subagents), `ask_user_questions`. Tags match MCP tool annotations (`readOnlyHint`, `destructiveHint`).
- Release notes mention `POST/GET /api/v1/mcp-servers`, `/api/v1/agents`, `/api/v1/settings/...`. Full API reference: https://trueforge.dev/api-reference

### UNVERIFIED — spend the first 60-90 minutes proving these with a throwaway script before building on them
1. Exact way to register our localhost MCP server in local mode (Settings UI vs `POST /api/v1/mcp-servers` body) and whether `agent.spec` accepts `mcp_servers` with `require_approval_for_tools`. Read https://trueforge.dev/mcp-servers and https://trueforge.dev/create-agent/overview and the OpenAPI at trueforge.dev/api-reference.
2. How to **cancel** a running turn in OSS (look for a cancel endpoint/SDK method in the API reference). Fallback that always works: abort the HTTP stream with `AbortController` AND start nothing else; because writes only happen after approval (section 5), cancelling is workspace-safe either way.
3. How to configure a model + an OpenAI-compatible endpoint + a second model (TrueForge Settings > Models; shipped YAML catalogs can be overridden). TrueForge may not have native model fallback; implement fallback in the extension by **creating a new session with the second configured model name** (this still routes through TrueForge, so it is allowed).
4. How subagents (`collaborators`), deferred tool loading and Code Mode are switched on for an inline spec. Docs: https://trueforge.dev/key-features/overview
5. Whether MCP tool approval is configurable per tool in OSS or approval must be set via the agent spec.

If something is unverified and blocks you, ask in the TrueForge Discord (https://discord.com/invite/fHeGRvakb) and keep going with the fallback.

## 4. Architecture

```
VS Code extension host
 ├─ webview chat/agent panel  <-- renders events (streamed deltas, tool calls, "context chosen" cards)
 ├─ TrueForgeClient           (sessions, createTurnStream, approval resume, backoff, model fallback)
 ├─ MCP server (localhost, Streamable HTTP, @modelcontextprotocol/sdk)  <-- TrueForge calls this
 │    tools: list_dir, read_file(path, range), search_text(query, glob), find_symbol(name),
 │           get_context_budget_info, propose_write(path, new_content | edits), run_command(cmd)
 ├─ EditStaging  (in-memory proposals keyed by path+hash; NOTHING touches disk until accepted)
 ├─ DiffReview   (hunks, CodeLens accept/reject, vscode.diff preview, undo)
 └─ ContextBuilder (@file, @symbol, auto-retrieval, token budget)
TrueForge local server (npx @truefoundry/trueforge) -- agent loop, models, approvals, subagents
```

Suggested layout: `src/extension.ts`, `src/trueforge/client.ts`, `src/mcp/server.ts`, `src/mcp/tools/*.ts`, `src/edit/staging.ts`, `src/edit/hunks.ts`, `src/edit/review.ts`, `src/context/{mentions,retrieval,budget}.ts`, `src/ui/panel.ts`, `webview/` (plain TS + minimal CSS; no heavy framework), `agent/forgepilot.agent.json`, `config/models.example.yaml`, `docs/WRITEUP.md`, `README.md`.

## 5. Safe edits (B2 + A3 + B4 together)

- `propose_write` is marked destructive/write and **requires TrueForge approval**. The MCP tool never writes during proposal.
- Flow: model emits `propose_write` call -> TrueForge pauses with `tool.approval_required` -> extension reads path + new content from the proposing `model.message` args -> computes hunks vs the current file -> shows diff (vscode.diff + CodeLens/panel with per-hunk Accept/Reject) -> user decides -> extension sends new turn with `allow` (and records accepted hunk ids in shared in-process state keyed by path+content hash) or `deny` with reason -> on `allow` the MCP tool applies **only accepted hunks** via `vscode.WorkspaceEdit` (so editor undo works) and returns a summary like "applied 2/3 hunks" to the agent.
- Keep a snapshot per applied change; provide a command "ForgePilot: Undo last applied change" (and also native Ctrl+Z works).
- Cancel: abort stream, drop all staged/unapproved proposals, show "cancelled, 0 files changed". Never apply partially-approved multi-file work without per-file confirmation. Verify with `git status` after cancel.
- Multi-file Task B: review one file at a time, or a combined review list; each file's hunks individually accepted/rejected.
- `run_command`: also approval-gated; show the command in the panel; run via a VS Code terminal or child process with a timeout; return truncated output.

## 6. Context assembly (B1, the highest-weight criterion)

Flask 3.1.3 is ~17k lines; never dump whole files. Strategy (state this in the write-up with numbers):
1. Explicit `@file` / `@symbol` mentions are resolved by the extension and attached as **ranges**, not whole files (symbols via `vscode.executeWorkspaceSymbolProvider` / DocumentSymbolProvider).
2. The agent retrieves on its own via MCP tools: `search_text` (ripgrep-style, returns path:line + 2-line snippets, capped e.g. 40 hits), `find_symbol`, `list_dir`, and `read_file` with line ranges. Hard caps: e.g. 400 lines per read, ~12k tokens of tool output per call; truncate with a "N more results, narrow your query" marker.
3. Instruct the agent (in `instructions`) to: search first, read ranges not files, and **before editing, post a short "Context chosen" list: each file/symbol and one line on why**. This is what the judges look for in Task B. Optionally render that list as a card in the panel.
4. Overall budget: a configurable token budget (e.g. 30k tokens of retrieved code per turn); `get_context_budget_info` tool reports usage; the extension also tracks it from TrueForge usage data on `model.message`.
5. TrueForge features for B4 (pick at least one, show it in the session, explain it): a **subagent** (`collaborators`) that explores the repo and returns a file shortlist; **deferred tool loading** so rarely used tools are not in context; **compaction** for long runs. Verify how to enable them first (section 3, item 4).

## 7. Inline edit (A1)

Keybinding (e.g. Ctrl+K Ctrl+I) -> input box -> selection text + file path + range + instruction sent as a turn in a fresh session with a restricted prompt ("edit only the selected region, call `propose_write` once"). Same approval/diff pipeline as agent mode. Show hunks with Accept/Reject per hunk.

## 8. Resilience (B3 / Task C)

- Config has `models: [primary, fallback]` (TrueForge model names). On network error / non-2xx / `turn.done` with `error`: retry with exponential backoff (e.g. 3 tries, 1s/2s/4s), then create a new session with the fallback model and replay the user's request, then if that fails show a clear message (not a stack trace).
- Editor must never block: all TrueForge I/O async; show status in panel/status bar.
- Demo Task C: point primary at an unreachable endpoint or bad key in TrueForge, repeat Task A, show fallback taking over (or clear error) and `git status` clean.

## 9. Fixed demo tasks (must work, exact wording)

Repo: pallets/flask tag 3.1.3 (commit 22d92470). Python venv with `pip install -e . pytest` first.
- A: open `src/flask/helpers.py`, select `get_debug_flag`, instruction: "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false." Accept the diff. Verify: `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` prints `False`.
- B: agent panel, no files mentioned: "Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands." Accept hunks. Verify: diff touches >= 3 files (expect `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`), `pytest tests/test_cli.py -q` passes, run the command on any app and show masked JSON. Show the TrueForge session (turns + tool calls) briefly.
- C: break the endpoint/key, repeat A, show responsiveness, clear message or automatic fallback, `git status` clean.
Rehearse each at least 3 times; make the agent definition robust to weaker/free models (keep tool schemas simple, instructions explicit). Organisers may rerun Task A live with a different model.

## 10. Build order (time-boxed; ~28h left)

1. (0-1.5h) Run TrueForge locally, configure one model, script-test create session + stream + approval resume; resolve the UNVERIFIED items.
2. (1.5-5h) Extension skeleton, TrueForgeClient streaming into a webview panel, Cancel button.
3. (5-9h) MCP server with read/search/list/find_symbol tools registered in TrueForge; agent reads code end to end.
4. (9-14h) `propose_write` + approval + hunk review + apply + undo. Then inline edit (A).
5. (14-18h) Context: mentions, budgets, "Context chosen" output, subagent/deferred tools. Run Task B on Flask.
6. (18-21h) Resilience + fallback. `run_command`.
7. (21-24h) README, example configs, agent definition, record video (<= 4 min), write PDF (1-3 pages, 8 headings in this order: 1 Team, 2 Starting point, 3 Architecture on TrueForge, 4 How context is selected, 5 Model setup, 6 Scorecard with video timestamps, 7 Tools used (declare AI assistants), 8 Known limitations).
8. (final 3h) Make GitHub repo, video link (YouTube unlisted / Drive "anyone with link") and PDF link **public**, test from a clean clone and a logged-out browser, submit on the Techfest portal before the deadline. Non-public links are not scored.

Cut scope in this order if time runs out (never cut the first four): keep A1, A2, B2 diff safety, video; then resilience; then @symbol; then run_command polish; then subagents (but keep at least one context-engineering feature for B4).

## 11. Coding rules

- TypeScript strict, esbuild bundling, `vscode` API only; no telemetry; commit small and often with clear messages (judges read git history).
- Never commit `.env`, keys, or TrueForge's SQLite data. Add `.gitignore` early.
- README must have clean-clone setup: install deps, `npx @truefoundry/trueforge@latest`, configure models, load `agent/forgepilot.agent.json`, press F5 to run the Extension Development Host, open flask 3.1.3.
- Declare models used, where they ran, and approximate cost in README and write-up.

## 12. Workspace Working Rules

### Autonomous Workspace Work
- Do not ask for permission before routine, in-scope reads, edits, tests, or local commits inside this repository.
- Proceed autonomously when the requested action is reversible and limited to the project.
- Platform-mandated approvals, destructive operations, secrets, publishing, pushing, and other external side effects still require the applicable safety checks.

### Micro-Commit Everything
- Make a small commit after every coherent, verified change.
- Keep one concern per commit and never mix unrelated edits.
- Use a precise commit message that states the delivered outcome.
- Do not commit failing or unverified work unless it is explicitly marked as a temporary checkpoint (prefix the message with `WIP checkpoint:`).

### Pushes and Pull Requests: STOP and tell the user
Pushing and PRs are external side effects. The agent must **never push, force-push, open a PR, change repo visibility, or publish anything on its own**. Whenever a push or PR is due, stop, tell the user plainly ("Push needed now: <reason>"), and give the exact steps below. Then wait for the user to confirm they did it, and continue.

When to raise a push: after each major milestone (TrueForge streaming works, MCP tools work, diff review + undo works, Task A passes, Task B passes, Task C passes, README/write-up done), and at least every ~3 hours so work is backed up and git history shows progress. Judges read git history, so keep the micro-commits intact (do not squash them away).

First-time setup steps to give the user:
1. On GitHub create a new repository named `Forge-a-thon` (public, with MIT LICENSE; no need to add a README if one exists locally).
2. In the project folder: `git remote add origin https://github.com/<user>/Forge-a-thon.git`
3. `git branch -M main`
4. Check no secrets are staged: `git status` and `git diff --cached`; confirm `.env`, API keys and TrueForge SQLite files are in `.gitignore`.
5. `git push -u origin main`

Routine push steps:
1. `git status` (clean) and `git log --oneline -5` (confirm micro-commits).
2. `git push`

If working on a feature branch and a PR is wanted:
1. `git push -u origin <branch>`
2. Open the PR in GitHub (or `gh pr create --fill` if the GitHub CLI is installed), review the diff for secrets, then merge to `main`.

Final submission push (before 20 Nov 2026, 23:59 IST): confirm the repo is public, README works from a clean clone, `LICENSE` present, `agent/forgepilot.agent.json` and `config/models.example.yaml` present, no secrets; verify by opening the repo in a logged-out/incognito browser. Then submit the repo, video and PDF links on the Techfest portal.