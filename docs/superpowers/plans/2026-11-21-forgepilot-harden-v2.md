# ForgePilot Hardening v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all confirmed bugs found in the branch review (search_text glob, CRLF hunk apply, applyProposal direct-write path, unbounded map growth, _openFile path traversal, escapeHtml XSS, token query-param preservation in MCP URL) and tighten agent instructions; leave `it.fails` for un-fixed items; keep 130+ tests green.

**Architecture:** Pure bug-fix and instruction-tightening pass on branch `feature/harness-instructions-v2`. Every fix is test-driven; each task is committed independently. No new npm dependencies.

**Tech Stack:** TypeScript strict, Vitest, Node.js fs, `diff` library, VSCode extension API.

**Spec:** `c:/Work/Projects/Forge-a-thon/AGENTS.md` section B (Known Remaining Issues) and section C (Instruction Quality).

## Global Constraints

- TypeScript strict mode — no `any` relaxations without existing pattern.
- No new npm dependencies (check package.json before adding imports).
- `npm.cmd test` must pass (>= 130 tests) after every task.
- `npx.cmd tsc -p . --noEmit` must pass after every task.
- `it.fails` convention: confirmed-but-NOT-YET-fixed bugs stay as `it.fails`; a fixed bug's test must become a plain `it(...)`.
- No secrets in git; no pushes.
- Conventional commit format: `fix(scope): message` / `feat(scope): message` / `test(scope): message`.
- One concern per commit.

## Review Focus

1. **CRLF**: applyHunks rejoins with `\n` even when input used `\r\n` — untouched lines lose CR. Fix: detect EOL from original content and use it when rejoining.
2. **glob matching**: `'*.py'.replace(/\*/g,'')` -> `'.py'` which `.includes`-matches `.pyc`. Fix: proper minimatch-style suffix check with `$` anchor.
3. **Direct write path**: `EditStagingManager.applyProposal()` writes to disk and bypasses the VSCode editor undo stack.
4. **Unbounded growth**: `SnapshotManager.history`, `EditStagingManager.finalizedProposals` grow without cap in long sessions.
5. **Path traversal via openFile**: `_openFile` resolves `relativePath` against `workspaceRoot` but doesn't call `resolveInWorkspace`.

---

### Task 1: Fix CRLF corruption in applyHunks — flip it.fails to passing

**Files:**
- Modify: `src/edit/hunks.ts`
- Test: `test/security/audit-findings.test.ts` (flip the `it.fails`)

**Interfaces:**
- `applyHunks(oldContent, hunks, acceptedHunkIds)` -> `ApplyHunksResult` — keep signature identical.

- [ ] Fix applyHunks to detect EOL from oldContent (`\r\n` vs `\n`) and rejoin with the same EOL.
- [ ] Flip `it.fails('partial apply preserves CRLF...')` to `it(...)`.
- [ ] `npm.cmd test` passes.
- [ ] Commit: `fix(edit): preserve original EOL style (CRLF) when partially applying hunks`

---

### Task 2: Fix search_text glob matching — flip two it.fails to passing

**Files:**
- Modify: `src/mcp/tools/searchText.ts`
- Test: `test/security/audit-findings.test.ts` (flip the two glob `it.fails`)

- [ ] Replace substring glob check with proper suffix-anchored and path-prefix matching.
- [ ] Flip both glob `it.fails` tests to `it(...)`.
- [ ] `npm.cmd test` passes.
- [ ] Commit: `fix(mcp): correct glob matching in search_text (suffix anchoring and path prefix)`

---

### Task 3: Fix _openFile path traversal and escapeHtml XSS

**Files:**
- Modify: `src/ui/panel.ts`
- Modify: `webview/main.ts`
- Test: `test/security/audit-findings.test.ts`

- [ ] Add `resolveInWorkspace` guard to `_openFile`; on error post a safe error message.
- [ ] Fix `escapeHtml` to also escape `"` -> `&quot;` and `'` -> `&#39;`.
- [ ] Add test verifying resolveInWorkspace blocks traversal (pure unit test, no VSCode).
- [ ] `npm.cmd test` passes.
- [ ] Two commits: one for panel.ts, one for webview/main.ts.

---

### Task 4: Cap unbounded growth of snapshot/proposal/event maps

**Files:**
- Modify: `src/edit/snapshot.ts`
- Modify: `src/edit/staging.ts`
- Test: `test/edit/staging.test.ts`

- [ ] `SnapshotManager`: add `MAX_HISTORY = 50` cap; add `historySize()` method.
- [ ] `EditStagingManager.finalizedProposals`: cap at 150 total entries (oldest deleted first).
- [ ] Add test for snapshot history cap.
- [ ] `npm.cmd test` passes.
- [ ] Commit: `fix(edit): cap snapshot history and finalizedProposals map to prevent unbounded growth`

---

### Task 5: Document applyProposal direct-write path with it.fails

**Files:**
- Modify: `src/edit/staging.ts` (add deprecation comment)
- Modify: `test/security/audit-findings.test.ts` (add it.fails)

- [ ] Add `@deprecated` JSDoc to `applyProposal` noting it bypasses the editor pipeline.
- [ ] Add `it.fails` test documenting the limitation.
- [ ] `npm.cmd test` passes.
- [ ] Commit: `docs(edit): document applyProposal direct-write bypass as known limitation`

---

### Task 6: Tighten AGENT_INSTRUCTIONS and sync forgepilot.agent.json

**Files:**
- Modify: `src/agent/instructions.ts`
- Modify: `agent/forgepilot.agent.json`

- [ ] Add MULTI-FILE PLANNING block: state file count upfront, only write files in Context chosen list, propose all files in one turn.
- [ ] Keep prompt compact — 3-4 new lines max.
- [ ] Sync `agent/forgepilot.agent.json` instructions field to match.
- [ ] `npm.cmd test` passes.
- [ ] Commit: `feat(agent): require file-count declaration and Context-chosen gating for multi-file tasks`

---

### Task 7: MCP URL token preservation — verify and add test

**Files:**
- Modify: `src/mcp/server.ts` (add assumption comment)
- Test: `test/mcp/server.test.ts` (add token-in-URL test)

- [ ] Add comment after URL construction explaining the query-param assumption and fallback path.
- [ ] Add test: when `authToken` is provided, returned URL contains `?token=<value>`.
- [ ] `npm.cmd test` passes.
- [ ] Commit: `docs(mcp): document auth token query-param assumption; add server URL token test`

---

### Task 8: Final verification

- [ ] `npm.cmd test` >= 130 passing.
- [ ] `npx.cmd tsc -p tsconfig.json --noEmit` = 0 errors.
- [ ] `npm.cmd run build` = exit 0.
- [ ] `git log --oneline -10` shows all task commits.
