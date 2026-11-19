# ForgePilot: Architecture & Technical Report
*A TrueForge-Powered Coding Agent Client for VS Code | Round 1 Submission*

## 1. TEAM
- **Solo Developer:** Akash Mansingh
- **Institution:** Vellore Institute of Technology (VIT), Vellore
- **GitHub Handle:** [@theRiddler9](https://github.com/theRiddler9)
- **Repository:** [github.com/theRiddler9/Forge-a-thon](https://github.com/theRiddler9/Forge-a-thon)

## 2. STARTING POINT
ForgePilot was developed **100% from scratch** specifically for the TrueForge Forge-a-thon (Round 1). It contains zero upstream forks and incorporates no code from existing AI editor tools (such as Cline, Continue, or Roo-Code), guaranteeing complete freedom from intellectual property or licensing conflicts. Released under the **MIT License**, the project features an audit-ready git repository of over 90 atomic micro-commits representing rigorous test-driven development.

## 3. ARCHITECTURE ON TRUEFORGE
ForgePilot strictly adheres to the client-only architectural model mandated by TrueForge. The VS Code extension acts purely as an intelligent editor frontend; **it never initiates network connections to model providers directly** (no OpenAI, Anthropic, or external provider SDKs or endpoints). All reasoning, session persistence, turn loops, and model inference execute exclusively inside TrueForge local mode (`npx @truefoundry/trueforge@latest` on `http://localhost:8790`, SQLite storage, no auth).

- **TrueForgeClient Core:** Uses `@truefoundry/trueforge-sdk` to provision sessions dynamically via an inline `agent.spec` (specifying the active model, rigorous system prompt instructions, and MCP configuration). Turns stream via Server-Sent Events (SSE). Event deltas are statefully aggregated using `mergeEventDelta` without naive string concatenation.
- **Wire-Protocol Approval Resume:** When a turn pauses on tool execution, TrueForge emits a `tool.approval_required` event. ForgePilot resumes execution by invoking `client.sessions.createTurnEvents` with a structured `user.tool_approval` event on the same active turn, strictly adhering to the real SSE wire format (snake_case `tool_calls: [{id, source_event_id}]` with arguments extracted from `function.{name,arguments}`).
- **Embedded Streamable HTTP MCP Server:** The extension hosts an in-process Streamable HTTP MCP server (using `@modelcontextprotocol/sdk`) bound to a dynamic localhost port, auto-registered into TrueForge via `settings.mcpServers.createOrUpdate`. Capabilities exposed as standard MCP tools include: `list_dir`, `read_file` (400-line cap), `search_text` (40-hit cap), `find_symbol`, `get_context_budget_info`, `propose_write`, and `run_command`.
- **TrueForge Approval Driving Diff Review Gate (B4 + B2):** `propose_write` is annotated with `destructiveHint: true`. The tool never touches disk during proposal; edits are held in in-process staging memory. While TrueForge pauses, ForgePilot computes unified diff hunks against current editor buffers, displaying a side-by-side `vscode.diff` preview with per-hunk CodeLens Accept/Reject controls. Only user-accepted hunks are applied via `vscode.WorkspaceEdit` upon turn resumption, accompanied by a rollback snapshot for instant Undo.
- **Harness Features:** Implements deferred tool loading (`preload: false` with `preloadTools` for read-only navigation), tool approval gating (`requireApprovalForTools`), and reconnect-safe cursor streaming.

## 4. HOW CONTEXT IS SELECTED
Flask 3.1.3 comprises over 17,000 lines of Python code across dozens of modules; dumping raw files into context would immediately exhaust model token windows and induce hallucinations. ForgePilot implements a disciplined context engineering strategy:

1. **Bounded Explicit Mentions:** User `@file:path` and `@symbol:name` mentions are resolved to bounded line slices (maximum 400 lines) using VS Code document symbol providers rather than ingesting entire files.
2. **Autonomous Agent Retrieval:** The agent navigates unfamiliar codebases autonomously using focused MCP tools: `search_text` (grep-style search returning `path:line` and 2-line snippets, capped at 40 hits), `find_symbol` (locating class/function definitions), and `read_file` with strict range slicing.
3. **Mandatory "Context Chosen" Rationale:** Agent system instructions mandate that prior to proposing any modification, the model must emit a structured *"Context chosen"* block stating each inspected file and a one-line technical rationale for why it was selected.
4. **Turn Size Budget:** Enforces a configurable 30,000-token retrieved code budget (`forgepilot.tokenBudget`). Usage is tracked per turn, queryable via `get_context_budget_info`, and tool payload limits truncate excessive outputs.

## 5. MODEL SETUP
ForgePilot was developed and verified against cost-efficient and open-source models configured inside TrueForge Settings:

- **Primary Local Model:** `lmstudio/qwen-2-5-7b-instruct` served locally by LM Studio via OpenAI-compatible endpoint (`http://localhost:1234/v1`, Q4_K_M GGUF quantization, 32k context, $0 cost).
- **Cloud & Fallback Models:** `groq/qwen-3-8-27b` and `groq/openai-gpt-oss-20b` running on Groq's free cloud tier ($0 cost). Total developer spend across all iterative test, benchmark, and validation runs: **under $1.00**.
- **Model Switching & Automatic Fallback (B3):** TrueForge Settings registers provider models. The extension queries `GET /api/v1/models` to populate a live model selector dropdown in the agent panel, or defaults to `forgepilot.primaryModel`. If the primary model fails or encounters endpoint connection drops, ForgePilot executes 3 retries with exponential backoff (1s, 2s, 4s), then automatically initializes a new session on `forgepilot.fallbackModel`, preserving workspace state (0 unapproved files modified). Upstream HTTP 429 rate limits are automatically caught, displaying a real-time countdown timer before retrying turns seamlessly.

## 6. SCORECARD WITH VIDEO TIMESTAMPS

Every criterion below was verified on-screen in the Pallets Flask 3.1.3 benchmark repository (commit `22d92470`):

| Criterion | Points | Video Timestamp | Verified Claim & Technical Demonstration |
| :--- | :---: | :---: | :--- |
| **A1 Inline Edit** | 10 | 0:00 - 0:48 | Triggered `Ctrl+K Ctrl+I` on `get_debug_flag` in `helpers.py`. Model proposed edit, rendered side-by-side diff with per-hunk Accept/Reject. Verified: `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` prints `False`. |
| **A2 Agent Mode** | 10 | 0:49 - 1:55 | One prompt in agent panel without naming files: *"Add a new built-in CLI command flask config..."*. Agent discovered & modified 3 files unprompted (`cli.py`, `test_cli.py`, `docs/cli.rst`). `pytest tests/test_cli.py -q` passed and JSON masking verified. |
| **A3 Streaming & Cancel** | 10 | 1:56 - 2:28 | SSE tokens stream live to Webview panel. Immediate Cancel halts turn execution cleanly; workspace verified 100% clean (`git status` shows zero half-applied writes). |
| **B1 Context Assembly** | 15 | 2:29 - 2:58 | 30k token budget + 400-line range bounds + explicit `@file`/`@symbol` resolution. Visible *"Context chosen"* card displayed with rationale for each file before proposing changes. |
| **B2 Diff Safety & Undo** | 10 | 2:59 - 3:24 | No silent writes: unified hunks reviewed with CodeLens Accept/Reject. Executed *"ForgePilot: Undo Last Applied Change"*; restored disk snapshot verified on screen. |
| **B3 Resilience (Task C)** | 10 | 3:25 - 3:45 | Primary model pointed to unreachable endpoint. After 3 retries with backoff, ForgePilot automatically created a fallback session on secondary model (Groq) without user action; workspace unchanged. |
| **B4 TrueForge Depth** | 10 | 3:46 - 4:00 | Localhost MCP server + TrueForge `tool.approval_required` driving diff review + deferred tool loading (`preload: false`) visible in TrueForge session inspector. |
| **C1 Video** | 10 | — | Screen recording <= 4 min, showing Tasks A, B, and C in order with continuous editor view and terminal verifications. |
| **C2 Write-Up** | 15 | — | This comprehensive 2-page technical report detailing exact architecture, numbers, trade-offs, and verification results. |

## 7. TOOLS USED
- **AI Coding Assistants:** Devin (Cognition) and Antigravity (Google) were utilized as intelligent pair-programming assistants for initial TypeScript boilerplate scaffolding, test harness generation, and code review.
- **Verification & Testing Rigor:** Every line of code, MCP tool handler, diff algorithm, and approval resume loop was executed and validated locally. The project contains a comprehensive automated test suite of **111 passing vitest tests** across 17 suites, including end-to-end mock SSE TrueForge servers, AST traversal tests, and security boundary assertions.

## 8. KNOWN LIMITATIONS & NEXT MONTH
- **Current Limitations:**
  1. `run_command` executes commands in a local shell process gated by user approval without container isolation; an ephemeral session token check is planned.
  2. Hunk application currently applies accepted hunks at the file level; character-level intra-line cherry-picking is deferred to native editor gutter controls.
  3. TrueForge session events resumed via `createTurnEvents` currently rely on client-side state reconstruction rather than real-time sub-stream rebroadcast.
  4. The 30k context budget warns and truncates tool returns, but does not yet hard-evict prior turns from the TrueForge session window.
- **With Another Month:**
  1. *Hierarchical Collaborator Subagents:* Deploy TrueForge subagents (`collaborators`) dedicated specifically to repository indexing and exploratory search, returning concise structural summaries to the primary agent.
  2. *Session Compaction:* Integrate TrueForge turn compaction hooks for multi-hour editorial sessions.
  3. *Telemetry & Observability:* Embed live token velocity and latency dials into the panel header.
  4. *Cross-Provider Evaluator:* Build an automated clean-room evaluation pipeline to benchmark agent performance across Llama 3, DeepSeek, and Qwen models for the judges' live rerun.
