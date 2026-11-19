# ForgePilot (Forge-a-thon)

> **ForgePilot** is a safe, high-performance coding agent extension for VS Code whose agent loop executes entirely on [TrueForge](https://github.com/truefoundry/trueforge) local mode with in-process MCP tools.

Built from scratch for the TrueForge Forge-a-thon (Round 1). Released under the MIT License.

---

## 🌟 Key Capabilities & Architectural Highlights

1. **TrueForge Local Agent Loop**: Extension acts strictly as a client via `@truefoundry/trueforge-sdk`. Zero direct LLM provider calls.
2. **In-Process Streamable HTTP MCP Server**: Exposes editor tools (`list_dir`, `read_file`, `search_text`, `find_symbol`, `get_context_budget_info`, `propose_write`, `run_command`) on localhost with dynamic port allocation.
3. **Safe Diff Review Pipeline**:
   - `propose_write` is marked destructive and pauses TrueForge with `tool.approval_required`.
   - Edits are staged strictly in-memory without touching disk.
   - Per-hunk Accept/Reject in Webview and CodeLens.
   - Full Undo command ("ForgePilot: Undo last applied change") restoring disk snapshots.
4. **Context Engineering with Size Budget**:
   - Parses explicit `@file:path` and `@symbol:name` mentions as exact line slices (capped at 400 lines).
   - Configurable token budget (default: 30k tokens).
   - Agent outputs a mandatory **"Context chosen"** rationale list before any edit.
   - Deferred MCP tool loading (`preload: false`, `preloadTools`).
5. **Streaming, Immediate Cancel & Resilient Fallback**:
   - Real-time token and delta streaming.
   - Immediate cancellation leaves the workspace 100% clean.
   - Automatic exponential backoff and session fallback to secondary model on provider errors.

---

## 🚀 Clean-Clone Setup Guide

### Prerequisites
- Node.js >= 22.14
- Python >= 3.10 (for testing against Flask)
- VS Code >= 1.93.0

### Step 1: Clone and Install Dependencies
```bash
git clone https://github.com/theRiddler9/Forge-a-thon.git
cd Forge-a-thon
npm install
```

### Step 2: Start TrueForge Locally
In a separate terminal, launch TrueForge in local mode (with network policy disabled so TrueForge can reach the extension's localhost MCP server):

```bash
# On Linux / macOS:
NETWORK_POLICY_ENABLED=false npx @truefoundry/trueforge@latest

# On Windows PowerShell:
$env:NETWORK_POLICY_ENABLED="false"; npx @truefoundry/trueforge@latest
```
*TrueForge boots at `http://localhost:8790` with local SQLite storage (`%LOCALAPPDATA%\trueforge\Data\db\db.sqlite`) and no authentication.*

### Step 3: Configure Models in TrueForge
Open `http://localhost:8790` in your browser:
1. Navigate to **Settings** $\rightarrow$ **Models**.
2. Configure your primary model (e.g. `anthropic/claude-sonnet-4-6`) and secondary fallback model (e.g. `openai/gpt-4o`).
3. See [config/models.example.yaml](file:///C:/Work/Projects/Forge-a-thon/config/models.example.yaml) for reference settings.

### Step 4: Build and Launch ForgePilot in VS Code
1. Compile the extension and webview bundles:
   ```bash
   npm run build
   ```
2. Open this repository in VS Code:
   ```bash
   code .
   ```
3. Press **F5** (or Run $\rightarrow$ Start Debugging) to launch the **Extension Development Host**.

---

## 🧪 Physical Demonstration & Verification Steps

### Task A: Inline Edit Verification
1. In the Extension Development Host window, open `src/flask/helpers.py`.
2. Select the `get_debug_flag` function.
3. Press `Ctrl+K Ctrl+I` (or `Cmd+K Cmd+I` on macOS).
4. Enter the instruction:
   > *"Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."*
5. Review the proposed diff hunks and click **Accept All** (or accept hunk-by-hunk).
6. Verify in terminal:
   ```bash
   FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
   ```
   **Output:** `False`
7. Automated verification:
   ```bash
   npx tsx scripts/verify-task-a.ts /path/to/flask
   ```

### Task B: Agent Mode Verification
1. Open the **ForgePilot** sidebar panel from the Activity Bar.
2. In the prompt box, enter:
   > *"Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as '***'. It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands."*
3. Observe:
   - Agent outputs a **Context chosen** card explaining file selections.
   - Streaming tokens appear in real time.
   - Agent discovers and proposes edits to $\ge 3$ files (`src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`).
4. Click **Accept All Hunks**.
5. Verify tests:
   ```bash
   pytest tests/test_cli.py -q
   ```
6. Automated verification:
   ```bash
   npx tsx scripts/verify-task-b.ts /path/to/flask
   ```

### Task C: Resilience & Fallback Verification
1. In TrueForge Settings $\rightarrow$ Models, invalidate the primary model API key or point it to an unreachable endpoint.
2. Repeat Task A or prompt the agent.
3. Observe:
   - TrueForgeClient retries with exponential backoff.
   - Automatically falls back to the secondary model with no user intervention.
   - Workspace remains clean and uncorrupted (`git status` shows no half-applied edits).

---

## 📊 Automated Test Suite
To run the automated test suite covering the probe harness, MCP server, read tools, hunk engine, staging, and fallback client:
```bash
npm test
```

---

## 📝 Models & Usage Declaration
- **Primary Model**: `anthropic/claude-sonnet-4-6` (TrueForge catalog / OpenAI-compatible proxy)
- **Fallback Model**: `openai/gpt-4o` (TrueForge catalog)
- **Estimated Evaluation Cost**: < $0.50 USD across all demo runs.
- **AI Assistants Declared**: Antigravity AI pair programmer used for test scaffolding and typing.

## 📄 License
MIT License. See [LICENSE](file:///C:/Work/Projects/Forge-a-thon/LICENSE) for details.
