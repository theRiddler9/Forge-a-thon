# ForgePilot: Write-Up & Technical Report

## 1 Team
- **Developer**: Akash (Solo Developer)
- **Role**: Architecture, VS Code Extension Development, TrueForge Integration, MCP Server Implementation, Quality Assurance.

## 2 Starting Point
- **Genesis**: Built 100% from scratch specifically for the TrueForge Forge-a-thon (Round 1).
- **Licensing & Lineage**: No upstream forks, no borrowed Cline/Continue codebase. Full clean MIT License with zero external intellectual property encumbrances.

## 3 Architecture on TrueForge
ForgePilot strictly adheres to the client-only architecture mandated by TrueForge:
- **VS Code Extension Host (Client)**: Exclusively manages the user interface, editor diffs, and CodeLens controls. It never connects to model provider endpoints directly. All reasoning, turns, sessions, and agent loops execute inside TrueForge local mode (`http://localhost:8790`).
- **In-Process Streamable HTTP MCP Server**: The extension spins up an in-process MCP server on an available localhost port. Editor capabilities (`list_dir`, `read_file`, `search_text`, `find_symbol`, `get_context_budget_info`, `propose_write`, `run_command`) are registered as MCP tools.
- **TrueForge Tool Approval as Diff Gate (B4 + B2)**: `propose_write` is flagged with `destructiveHint: true`. When the agent decides to edit code, TrueForge halts execution with `tool.approval_required`. The extension extracts the proposed edits, calculates unified diff hunks, and presents them in the editor and webview with per-hunk Accept/Reject controls. Only when accepted by the user does the extension resume the turn with `allow`, applying the approved hunks to disk and taking a recovery snapshot.
- **Resilient Fallback (B3)**: TrueForgeClient wraps turn execution with exponential backoff retries (1s, 2s, 4s). On persistent model or network failure, it automatically initializes a new session with the secondary configured model (`fallbackModel`), maintaining workspace cleanliness without silent failures.

## 4 How Context is Selected
Flask 3.1.3 comprises over 17,000 lines of Python code; raw context dumping would immediately saturate token budgets and induce hallucinations. ForgePilot executes a four-tiered context engineering strategy:
1. **Explicit Mentions as Exact Ranges**: User `@file:path` and `@symbol:name` mentions are parsed and extracted into targeted line slices (capped at 400 lines) rather than entire files.
2. **Autonomous Retrieval by the Agent**: The agent retrieves context via MCP tools:
   - `search_text`: Grep-style search returning `path:line` and 2-line snippets, hard-capped at 40 hits.
   - `find_symbol`: AST/regex-based locator identifying class/function definitions across files.
   - `read_file`: Line-ranged reading with a strict 400-line limit per invocation.
3. **Mandatory "Context Chosen" Summary**: Before proposing edits, agent instructions mandate outputting a structured "Context chosen" breakdown explaining which files were selected and the rationale for each.
4. **Context Budget Enforcement**: Enforces a configurable turn budget (default: 30,000 tokens). `get_context_budget_info` reports consumption, and TrueForge's deferred tool loading (`preload: false`, `preloadTools`) keeps unused tools out of the prompt context until needed.

## 5 Model Setup
- **TrueForge Local Server**: Runs via `npx @truefoundry/trueforge@latest` on `http://localhost:8790` backed by local SQLite storage.
- **Primary Model**: `anthropic/claude-sonnet-4-6` configured within TrueForge model settings.
- **Fallback Model**: `openai/gpt-4o` configured as the secondary resilient fallback.
- **Configuration**: Managed cleanly via `config/models.example.yaml` without hardcoded API keys.

## 6 Scorecard with Video Timestamps

| Rubric Criteria | Score | Video Timestamp | Verified On-Screen Demonstration |
| :--- | :---: | :---: | :--- |
| **A1 Inline Edit** | 10 | 0:00 - 0:50 | Selected `get_debug_flag` in `helpers.py`, triggered `Ctrl+K Ctrl+I`, reviewed hunks with Accept/Reject, verified `FLASK_DEBUG=off` prints `False`. |
| **A2 Agent Mode** | 10 | 0:51 - 1:55 | Prompted `flask config` in agent panel. Agent autonomously discovered and modified 3 files (`cli.py`, `test_cli.py`, `cli.rst`). |
| **A3 Streaming + Cancel** | 10 | 1:56 - 2:30 | Tokens stream live in Webview. Clicked Cancel immediately; aborted cleanly with zero half-applied edits (`git status` clean). |
| **B1 Context Selection** | 15 | 2:31 - 3:00 | Demonstrated token budget tracking, `@file` range extraction, and visible "Context chosen" card with file rationale before edits. |
| **B2 Diff Safety & Undo** | 10 | 3:01 - 3:25 | Per-hunk CodeLens accept/reject; executed "ForgePilot: Undo last applied change" command restoring original state on screen. |
| **B3 Resilience & Fallback** | 10 | 3:26 - 3:45 | Disabled primary endpoint in TrueForge, repeated task, observed automatic session fallback to secondary model with clean git status. |
| **B4 TrueForge Depth** | 10 | 3:46 - 4:00 | TrueForge UI session inspected showing `tool.approval_required` events, deferred MCP tool loading, and thread checkpoints. |

## 7 Tools Used
- **Antigravity AI Assistant**: Utilized as an autonomous pair programmer to draft initial scaffolds, unit test harnesses, and type definitions. All implementations, design decisions, and verification scripts were validated and executed in the local environment.

## 8 Known Limitations
1. **Interactive Command Handling**: `run_command` executes synchronously with a configurable timeout; long-running interactive terminal processes (e.g. interactive debuggers) should be run in a dedicated VS Code terminal.
2. **Sub-Hunk Cherry-Picking**: Hunk boundaries are unified at 1-line context granularity. Finer character-level inline cherry-picking is deferred to VS Code's native editor gutter controls.
