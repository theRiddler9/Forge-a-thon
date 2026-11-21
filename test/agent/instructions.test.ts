import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EditStagingManager } from '../../src/edit/staging.js';
import { SnapshotManager } from '../../src/edit/snapshot.js';
import { executeProposeWrite } from '../../src/mcp/tools/proposeWrite.js';
import {
  AGENT_INSTRUCTIONS,
  INLINE_EDIT_INSTRUCTIONS,
  buildInlineEditPrompt,
} from '../../src/agent/instructions.js';
import { globalEditStaging } from '../../src/edit/staging.js';

let ws: string;
let staging: EditStagingManager;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rationale-'));
  staging = new EditStagingManager(new SnapshotManager());
  globalEditStaging.clearAll();
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('shared instructions', () => {
  it('agent instructions require a rationale field on propose_write', () => {
    expect(AGENT_INSTRUCTIONS).toContain('rationale');
    expect(AGENT_INSTRUCTIONS).toContain('EDIT RATIONALE');
  });

  it('agent instructions require verification via run_command', () => {
    expect(AGENT_INSTRUCTIONS).toContain('run_command');
    expect(AGENT_INSTRUCTIONS).toContain('VERIFICATION');
  });

  it('agent instructions keep context-budget rules', () => {
    expect(AGENT_INSTRUCTIONS).toContain('Context chosen');
    expect(AGENT_INSTRUCTIONS).toContain('400 lines');
  });

  it('agent instructions require multi-file planning and forbid writes outside Context chosen', () => {
    expect(AGENT_INSTRUCTIONS).toContain('Files to modify:');
    expect(AGENT_INSTRUCTIONS).toContain('FORBIDDEN: Proposing writes to files not in "Context chosen"');
  });

  it('agent/forgepilot.agent.json instructions match AGENT_INSTRUCTIONS exactly', () => {
    const jsonPath = path.resolve(__dirname, '../../agent/forgepilot.agent.json');
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    expect(parsed.spec.instructions).toBe(AGENT_INSTRUCTIONS);
  });

  it('inline instructions require scoped edits and rationale', () => {
    expect(INLINE_EDIT_INSTRUCTIONS).toContain('ONLY the selected region');
    expect(INLINE_EDIT_INSTRUCTIONS).toContain('rationale');
  });

  it('buildInlineEditPrompt embeds selection and rationale requirement', () => {
    const p = buildInlineEditPrompt({
      filePath: 'src/app.py',
      startLine: 10,
      endLine: 20,
      selectedText: 'def foo():\n    pass',
      instruction: 'add a docstring',
    });
    expect(p).toContain('src/app.py');
    expect(p).toContain('Lines: 10-20');
    expect(p).toContain('def foo():');
    expect(p).toContain('add a docstring');
    expect(p).toContain('rationale');
  });
});

describe('propose_write rationale plumbing', () => {
  it('stores rationale and per-edit reasons on the staged proposal', () => {
    fs.writeFileSync(path.join(ws, 'a.py'), 'x = 1\ny = 2\n');
    const proposal = staging.stageProposal(
      ws,
      'a.py',
      '',
      'tc-1',
      [{ search: 'x = 1', replace: 'x = 42', reason: 'bump constant per instruction' }],
      'User asked to change the constant value.'
    );
    expect(proposal.rationale).toBe('User asked to change the constant value.');
    expect(proposal.editReasons).toEqual(['bump constant per instruction']);
  });

  it('executeProposeWrite echoes the rationale back to the agent', async () => {
    fs.writeFileSync(path.join(ws, 'b.py'), 'hello\n');
    const res = await executeProposeWrite(ws, {
      path: 'b.py',
      edits: [{ search: 'hello', replace: 'world' }],
      rationale: 'Instruction said to greet differently.',
    });
    const text = res.content[0].text;
    expect(text).toContain('Rationale: Instruction said to greet differently.');
  });

  it('executeProposeWrite works without rationale (backwards compatible)', async () => {
    fs.writeFileSync(path.join(ws, 'c.py'), 'foo\n');
    const res = await executeProposeWrite(ws, {
      path: 'c.py',
      newContent: 'bar\n',
    });
    expect(res.content[0].text).toContain('Edit proposed');
    expect(res.content[0].text).not.toContain('Rationale:');
  });
});
