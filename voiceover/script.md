# ForgePilot demo voiceover script
# Place each file at the suggested timestamp in your edited timeline.
# Voice: en-IN-PrabhatNeural (Indian English). All times are SOURCE video seconds.

## 00_intro.mp3  (~0:00-0:10)
Hi, I'm Akash Mansingh from VIT Vellore. This is ForgePilot — a VS Code coding agent whose entire loop runs on TrueForge, with every editor capability exposed as MCP tools.

## 01_taskA_instruction.mp3  (~source 0:10-0:20)
Task A — inline edit. I've selected the get_debug_flag function in Flask's helpers.py and given ForgePilot an instruction with Control-K Control-I.

## 02_taskA_diff.mp3  (~source 0:20-0:40)
The agent proposed the change through the propose_write MCP tool. TrueForge paused for approval, and ForgePilot shows a per-hunk diff — I can accept or reject each hunk individually. Nothing touches disk until I accept.

## 03_taskA_verify.mp3  (~source 0:40-1:05)
Accepted. Running the verification — FLASK_DEBUG=off now correctly returns False. Task A complete: keybinding, instruction, per-hunk review.

## 04_taskB_prompt.mp3  (~source 1:05-1:20)
Task B — agent mode. One prompt, no files mentioned: add a flask config CLI command that prints the app config as JSON with secrets masked. Watch the TrueForge session — the agent is discovering the codebase on its own.

## 05_taskB_tools.mp3  (~source 1:20-3:00, pick 2-3 moments)
The agent calls our MCP tools — list_dir, search_text, find_symbol, read_file — all served by the extension over localhost. Deferred tool loading keeps the context small, and it posts a Context chosen list before editing: 30,000 token budget.

## 06_taskB_diff.mp3  (~source ~4:55-5:20)
TrueForge raised tool.approval_required for propose_write. The diff review opened — the agent edited cli.py, test_cli.py and docs unprompted. Three files, one request.

## 07_taskB_verify.mp3  (~source ~5:20-5:40)
Verification: pytest passes on the new test, and flask config prints masked JSON — every SECRET, PASSWORD, TOKEN and KEY value shows as stars.

## 08_taskC_fallback.mp3  (~source ~4:53-5:10 in edited order / Task C section)
Task C — resilience. I broke the primary model endpoint in TrueForge. ForgePilot retried with backoff, then automatically fell back to the second configured model — no user action. The workspace stayed clean.

## 09_outro.mp3
ForgePilot: a TrueForge client, MCP-native editor tools, per-hunk human-in-the-loop diffs, and automatic model fallback. Thanks for watching.
