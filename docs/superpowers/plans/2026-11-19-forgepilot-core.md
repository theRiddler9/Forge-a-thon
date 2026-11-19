# ForgePilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build ForgePilot, an MIT-licensed VS Code extension that operates as a client to TrueForge local mode (`npx @truefoundry/trueforge@latest`), exposing editor tools via an in-process MCP server, enforcing safe diff reviews with per-hunk accept/reject and undo, streaming events into a dedicated panel, supporting inline edits, and handling automatic model fallback with zero direct provider calls.

**Architecture:**
- **VS Code Extension Client**: Hosts a Webview panel for chat/agent mode, command handlers for inline edit (Ctrl+K Ctrl+I) and undo.
- **In-Process Streamable HTTP MCP Server**: Exposes `list_dir`, `read_file`, `search_text`, `find_symbol`, `get_context_budget_info`, `propose_write`, `run_command` over localhost Streamable HTTP.
- **Safe Edit Pipeline**: `propose_write` stages edits strictly in memory -> triggers TrueForge tool approval (`tool.approval_required`) -> extension displays hunks with per-hunk accept/reject -> on `allow`, applies accepted hunks via `vscode.WorkspaceEdit` -> preserves snapshot for full undo.
- **TrueForgeClient**: Manages TrueForge sessions, turns, deltas, approval resumes, cancel signals, exponential backoff, and model fallback.

**Tech Stack:**
- Node.js >= 22.14, TypeScript (strict), esbuild
- `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, `diff`, `zod`
- VS Code Extension API (`vscode`)
- Vitest for automated unit and E2E integration tests

**Spec:** `AGENTS.md`

## Global Constraints
- The agent loop runs exclusively on TrueForge local mode (`http://localhost:8790`).
- Extension is client-only; NEVER call model providers directly.
- Capabilities exposed strictly as MCP tools hosted on localhost.
- No hard-coded API keys or models in git; provide `config/models.example.yaml` only.
- Bundled agent definition: `agent/forgepilot.agent.json`.
- Safe writes: `propose_write` never writes to disk directly; require TrueForge approval; per-hunk accept/reject; full undo support.
- Micro-commit after every verified task. Stop and alert user for pushes/PRs.

## Review Focus
1. `propose_write` must never mutate files when cancelled or denied: cancellation leaves workspace 100% clean.
2. In-process MCP server must bind dynamically to an available localhost port without collision.
3. Partial hunk acceptance must correctly recalculate file lines when applying only selected hunks.
4. Resumption from `tool.approval_required` must format the turn payload with exact `source_event_id` and allow/deny status.
5. Secondary model fallback must seamlessly retry on network/turn error without blocking the VS Code UI.

---

### Task 1: Repository Baseline, .gitignore, License & Package Scaffolding

**Files:**
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `esbuild.js`

**Interfaces:**
- Produces: Project build script `npm run build`, test script `npm test`, clean git status without secrets.

- [ ] **Step 1: Create `.gitignore` ignoring node_modules, dist, .env, *.db, SQLite files, test caches**
- [ ] **Step 2: Create MIT `LICENSE`**
- [ ] **Step 3: Create `package.json` with name `forge-a-thon`, display name `ForgePilot`, scripts, and dependencies**
- [ ] **Step 4: Create `tsconfig.json` with strict mode enabled**
- [ ] **Step 5: Create `esbuild.js` bundling extension and webview**
- [ ] **Step 6: Install dependencies (`npm.cmd install`)**
- [ ] **Step 7: Verify baseline build and git status**
- [ ] **Step 8: Commit baseline scaffolding**

---

### Task 2: TrueForge API Probe & E2E Validation Harness

**Files:**
- Create: `scripts/probe-trueforge.ts`
- Create: `test/e2e/trueforge-probe.test.ts`

**Interfaces:**
- Consumes: `@truefoundry/trueforge-sdk`
- Produces: Verified API compatibility for session creation, turn streaming, delta merging, tool approval payload format, and cancel.

- [ ] **Step 1: Write integration probe script testing TrueForge connection, models, session creation, streaming, and tool approval**
- [ ] **Step 2: Add test harness for TrueForge API contract verification**
- [ ] **Step 3: Run probe against local TrueForge (or mock server if TrueForge is not running)**
- [ ] **Step 4: Commit TrueForge probe harness**

---

### Task 3: In-Process Streamable HTTP MCP Server

**Files:**
- Create: `src/mcp/server.ts`
- Create: `src/mcp/types.ts`
- Test: `test/mcp/server.test.ts`

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk`
- Produces: `startMcpServer(port?: number): Promise<{ port: number, close: () => Promise<void> }>`

- [ ] **Step 1: Write failing test for MCP server startup, endpoint discovery, and tool registration**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement Streamable HTTP MCP server hosting on localhost**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit MCP server core**

---

### Task 4: Read & Context MCP Tools

**Files:**
- Create: `src/mcp/tools/listDir.ts`
- Create: `src/mcp/tools/readFile.ts`
- Create: `src/mcp/tools/searchText.ts`
- Create: `src/mcp/tools/findSymbol.ts`
- Create: `src/mcp/tools/contextBudget.ts`
- Test: `test/mcp/tools.test.ts`

**Interfaces:**
- Consumes: Workspace root path, ripgrep/search logic, token budgeting tracker
- Produces: MCP tools conforming to Model Context Protocol with caps (e.g. 400 lines max per read, 40 hits max for search)

- [ ] **Step 1: Write failing tests for read_file (range + caps), list_dir, search_text, find_symbol, get_context_budget_info**
- [ ] **Step 2: Run tests to verify failure**
- [ ] **Step 3: Implement read tools with safety limits and token budgeting**
- [ ] **Step 4: Run tests to verify all pass**
- [ ] **Step 5: Commit Read & Context MCP tools**

---

### Task 5: Edit Staging, Hunk Engine & Safe `propose_write`

**Files:**
- Create: `src/edit/staging.ts`
- Create: `src/edit/hunks.ts`
- Create: `src/edit/snapshot.ts`
- Create: `src/mcp/tools/proposeWrite.ts`
- Test: `test/edit/hunks.test.ts`
- Test: `test/edit/staging.test.ts`

**Interfaces:**
- Consumes: `diff` library
- Produces: `computeHunks(oldContent, newContent)`, `stageProposal(path, newContent)`, `applyAcceptedHunks(proposalId, acceptedHunkIds)`, `createSnapshot(path)`, `restoreSnapshot()`

- [ ] **Step 1: Write failing tests for hunk computation, per-hunk IDs, partial hunk apply, and snapshot restore**
- [ ] **Step 2: Run tests to verify failure**
- [ ] **Step 3: Implement HunkEngine, EditStaging, SnapshotManager, and propose_write tool**
- [ ] **Step 4: Run tests to verify all pass**
- [ ] **Step 5: Commit Edit Staging, Hunks & propose_write**

---

### Task 6: TrueForgeClient: Streaming, Approvals, Cancel & Resilience Fallback

**Files:**
- Create: `src/trueforge/client.ts`
- Create: `src/trueforge/types.ts`
- Test: `test/trueforge/client.test.ts`

**Interfaces:**
- Consumes: `@truefoundry/trueforge-sdk`
- Produces: `TrueForgeClient` with `createSession`, `createTurnStream`, `cancelTurn`, `resumeApproval(sessionId, toolCallId, status, reason)`, `executeWithFallback`

- [ ] **Step 1: Write failing tests for TrueForgeClient turn streaming, delta merging, tool approval resume, cancel, and fallback to second model**
- [ ] **Step 2: Run tests to verify failure**
- [ ] **Step 3: Implement TrueForgeClient with retry backoff and model fallback**
- [ ] **Step 4: Run tests to verify all pass**
- [ ] **Step 5: Commit TrueForgeClient**

---

### Task 7: Context Assembly: @mentions & Strategy

**Files:**
- Create: `src/context/mentions.ts`
- Create: `src/context/budget.ts`
- Test: `test/context/mentions.test.ts`

**Interfaces:**
- Consumes: User message with `@file:path` or `@symbol:name`
- Produces: Resolved file line ranges and symbol definitions attached with token tracking

- [ ] **Step 1: Write failing tests for @file and @symbol extraction and resolution**
- [ ] **Step 2: Run tests to verify failure**
- [ ] **Step 3: Implement mention parser and budget tracker**
- [ ] **Step 4: Run tests to verify all pass**
- [ ] **Step 5: Commit Context Assembly**

---

### Task 8: Webview Agent Panel & Live UI

**Files:**
- Create: `src/ui/panel.ts`
- Create: `webview/index.html`
- Create: `webview/main.ts`
- Create: `webview/style.css`

**Interfaces:**
- Consumes: `vscode.WebviewViewProvider`
- Produces: Interactive panel with streaming tokens, tool cards, "Context chosen" indicator, diff review triggers, and Cancel button

- [ ] **Step 1: Implement webview message protocol (send turn, cancel, approve/deny hunk, show diff)**
- [ ] **Step 2: Implement frontend UI components in webview**
- [ ] **Step 3: Connect TrueForgeClient events to webview message dispatcher**
- [ ] **Step 4: Build webview bundle via esbuild**
- [ ] **Step 5: Commit Webview Agent Panel**

---

### Task 9: Diff Review UI, CodeLens & Editor Integration

**Files:**
- Create: `src/edit/review.ts`
- Create: `src/edit/codelens.ts`
- Create: `src/commands/inlineEdit.ts`
- Create: `src/commands/undo.ts`
- Create: `src/extension.ts`

**Interfaces:**
- Consumes: VS Code commands, CodeLensProvider, vscode.diff
- Produces: Commands `forgepilot.inlineEdit`, `forgepilot.undo`, `forgepilot.acceptHunk`, `forgepilot.rejectHunk`

- [ ] **Step 1: Implement diff preview and CodeLens provider for pending hunks**
- [ ] **Step 2: Implement inline edit flow (Ctrl+K Ctrl+I) with prompt dialog and restricted inline agent instructions**
- [ ] **Step 3: Implement "ForgePilot: Undo last applied change" command restoring previous snapshot**
- [ ] **Step 4: Wire extension activation in `src/extension.ts`**
- [ ] **Step 5: Commit Diff Review & Editor Integration**

---

### Task 10: Agent Definition, Config & Fixed Demo Tasks Verification

**Files:**
- Create: `agent/forgepilot.agent.json`
- Create: `config/models.example.yaml`
- Create: `scripts/verify-task-a.ts`
- Create: `scripts/verify-task-b.ts`
- Create: `docs/WRITEUP.md`
- Create: `README.md`

**Interfaces:**
- Consumes: TrueForge server, Pallets Flask 3.1.3 test repository
- Produces: Complete end-to-end passing verification of Task A, Task B, and Task C

- [ ] **Step 1: Create `agent/forgepilot.agent.json` with instructions mandating "Context chosen" summary before edits**
- [ ] **Step 2: Create `config/models.example.yaml` for primary & fallback models**
- [ ] **Step 3: Implement automated test scripts for Task A and Task B on Flask repository**
- [ ] **Step 4: Write comprehensive README.md with clean-clone setup instructions**
- [ ] **Step 5: Write `docs/WRITEUP.md` with the 8 required headings**
- [ ] **Step 6: Commit agent config, verification scripts, README and write-up**
