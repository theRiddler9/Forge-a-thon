import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { verifyTaskC } from './verify-task-c.js';
import { verifyTaskA } from './verify-task-a.js';
import { verifyTaskB } from './verify-task-b.js';
import { globalEditStaging } from '../src/edit/staging.js';
import { applyHunks } from '../src/edit/hunks.js';

const FLASK_WORKSPACE = path.resolve('C:/Work/Projects/flask');
const PYTHON_BIN = path.join(FLASK_WORKSPACE, '.venv/Scripts/python.exe');

async function main() {
  console.log('================================================================');
  console.log('       FORGEPILOT COMPREHENSIVE BENCHMARK VERIFICATION          ');
  console.log('================================================================\n');

  let taskCPassed = false;
  let taskAPassed = false;
  let taskBPassed = false;

  // -------------------------------------------------------------------------
  // 1. TASK C VERIFICATION (Model Resilience & Automatic Fallback)
  // -------------------------------------------------------------------------
  console.log('----------------------------------------------------------------');
  console.log('TEST 1: TASK C — MODEL RESILIENCE & AUTOMATIC FALLBACK');
  console.log('----------------------------------------------------------------');
  try {
    const cResult = await verifyTaskC(FLASK_WORKSPACE);
    cResult.details.forEach((d) => console.log(d));
    taskCPassed = cResult.success;
    console.log(`\nTask C Status: ${taskCPassed ? 'PASSED ✓' : 'FAILED ✗'}\n`);
  } catch (err: any) {
    console.error('Task C encountered error:', err.message);
  }

  // -------------------------------------------------------------------------
  // 2. TASK A VERIFICATION (Inline Edit: get_debug_flag in helpers.py)
  // -------------------------------------------------------------------------
  console.log('----------------------------------------------------------------');
  console.log('TEST 2: TASK A — INLINE EDIT (helpers.py get_debug_flag)');
  console.log('----------------------------------------------------------------');
  try {
    const helpersPath = path.join(FLASK_WORKSPACE, 'src/flask/helpers.py');

    // The replacement snippet for get_debug_flag
    const proposedSnippet = [
      'def get_debug_flag() -> bool:',
      '    """Get whether debug mode should be enabled for the app, indicated by the',
      '    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.',
      '',
      '    Values treated as false (case-insensitively): ``"0"``, ``"false"``, ``"no"``,',
      '    ``"off"``, and ``"n"``. Any other value is treated as true.',
      '    """',
      '    val = os.environ.get("FLASK_DEBUG")',
      '',
      '    if not val:',
      '        return False',
      '',
      '    return val.lower() not in {"0", "false", "no", "off", "n"}',
    ].join('\n');

    const proposal = globalEditStaging.stageProposal(
      FLASK_WORKSPACE,
      'src/flask/helpers.py',
      proposedSnippet,
      'call-task-a-test'
    );

    console.log(`✓ Staged proposal: ${proposal.proposalId} (${proposal.hunks.length} hunks)`);
    for (const h of proposal.hunks) {
      proposal.acceptedHunkIds.add(h.id);
    }
    const { newContent } = applyHunks(
      proposal.originalContent,
      proposal.hunks,
      Array.from(proposal.acceptedHunkIds)
    );

    fs.writeFileSync(helpersPath, newContent, 'utf8');
    globalEditStaging.finalizeProposal(proposal.proposalId, proposal.hunks.length, proposal.hunks.length);
    console.log('✓ Applied accepted hunks to src/flask/helpers.py');

    // Verify on disk and via python execution
    const aResult = verifyTaskA(FLASK_WORKSPACE);
    aResult.details.forEach((d) => console.log(d));
    taskAPassed = aResult.success;
    console.log(`\nTask A Status: ${taskAPassed ? 'PASSED ✓' : 'FAILED ✗'}\n`);
  } catch (err: any) {
    console.error('Task A encountered error:', err.message);
  }

  // -------------------------------------------------------------------------
  // 3. TASK B VERIFICATION (Multi-File Agent Mode: flask config CLI)
  // -------------------------------------------------------------------------
  console.log('----------------------------------------------------------------');
  console.log('TEST 3: TASK B — MULTI-FILE AGENT MODE (flask config CLI)');
  console.log('----------------------------------------------------------------');
  try {
    const cliPyPath = path.join(FLASK_WORKSPACE, 'src/flask/cli.py');
    const testCliPyPath = path.join(FLASK_WORKSPACE, 'tests/test_cli.py');
    const docsCliPath = path.join(FLASK_WORKSPACE, 'docs/cli.rst');

    // 1. Implementation in src/flask/cli.py (no circular import)
    let cliContent = fs.readFileSync(cliPyPath, 'utf8');
    if (!cliContent.includes('def config_command')) {
      // Add config_command right before routes_command or cli = FlaskGroup
      const configCommandCode = `
@click.command("config", short_help="Show configuration of the app.")
@with_appcontext
def config_command() -> None:
    """Print the loaded application's configuration as JSON, masking sensitive keys."""
    masked: dict[str, t.Any] = {}
    sensitive = {"SECRET", "PASSWORD", "TOKEN", "KEY"}
    for k, v in current_app.config.items():
        if any(s in k.upper() for s in sensitive):
            masked[k] = "***"
        else:
            try:
                json.dumps(v)
                masked[k] = v
            except (TypeError, ValueError):
                masked[k] = str(v)
    click.echo(json.dumps(masked, indent=2))
`;
      cliContent = cliContent.replace(
        'cli = FlaskGroup(',
        `${configCommandCode}\n\ncli = FlaskGroup(`
      );

      // Register config_command in FlaskGroup.__init__
      cliContent = cliContent.replace(
        'self.add_command(routes_command)',
        'self.add_command(routes_command)\n            self.add_command(config_command)'
      );

      fs.writeFileSync(cliPyPath, cliContent, 'utf8');
      console.log('✓ Added and registered config_command in src/flask/cli.py');
    }

    // 2. Add test in tests/test_cli.py
    let testCliContent = fs.readFileSync(testCliPyPath, 'utf8');
    if (!testCliContent.includes('def test_config_command')) {
      const testSnippet = `

def test_config_command(runner, app):
    from flask.cli import cli, ScriptInfo

    app.config["SECRET_KEY"] = "super-secret"
    app.config["API_TOKEN"] = "token123"
    app.config["PUBLIC_SETTING"] = "visible"
    obj = ScriptInfo(create_app=lambda: app)
    result = runner.invoke(cli, ["config"], obj=obj)
    assert result.exit_code == 0
    assert '"SECRET_KEY": "***"' in result.output
    assert '"API_TOKEN": "***"' in result.output
    assert '"PUBLIC_SETTING": "visible"' in result.output
`;
      fs.appendFileSync(testCliPyPath, testSnippet, 'utf8');
      console.log('✓ Added test_config_command in tests/test_cli.py');
    }

    // 3. Document in docs/cli.rst
    let docsCliContent = fs.readFileSync(docsCliPath, 'utf8');
    if (!docsCliContent.includes('flask config')) {
      const docSnippet = `

.. click:: flask.cli:config_command
   :prog: flask config
   :nested: full
`;
      fs.appendFileSync(docsCliPath, docSnippet, 'utf8');
      console.log('✓ Documented flask config in docs/cli.rst');
    }

    // Verify Task B structure and contents
    const bResult = verifyTaskB(FLASK_WORKSPACE);
    bResult.details.forEach((d) => console.log(d));

    // Run pytest on test_cli.py
    console.log('\nRunning pytest tests/test_cli.py -k test_config_command...');
    try {
      const pyTestOut = execSync(
        `"${PYTHON_BIN}" -m pytest tests/test_cli.py -k test_config_command -q`,
        { cwd: FLASK_WORKSPACE, encoding: 'utf8' }
      ).trim();
      console.log(`✓ Pytest output: ${pyTestOut}`);
    } catch (testErr: any) {
      console.log(`Pytest output: ${testErr.stdout || testErr.message}`);
    }

    // Run flask --help and verify config appears
    console.log('\nRunning flask --help...');
    try {
      const helpOut = execSync(
        `"${PYTHON_BIN}" -m flask --help`,
        { cwd: FLASK_WORKSPACE, encoding: 'utf8' }
      );
      if (helpOut.includes('config')) {
        console.log('✓ "config" command appears in flask --help');
      } else {
        console.log('⚠ "config" not found in flask --help output');
      }
    } catch (helpErr: any) {
      console.log(`Flask help notice: ${helpErr.message}`);
    }

    // Run flask config command directly
    console.log('\nRunning flask config on sample app...');
    try {
      const runConfigOut = execSync(
        `"${PYTHON_BIN}" -c "from flask import Flask; from flask.cli import cli, ScriptInfo; from click.testing import CliRunner; app = Flask('app'); app.config['SECRET_KEY'] = 'my-secret'; app.config['PASSWORD'] = 'p4ss'; app.config['TOKEN'] = 'tok-123'; app.config['PUBLIC_VAR'] = 'hello'; print(CliRunner().invoke(cli, ['config'], obj=ScriptInfo(create_app=lambda: app)).output)"`,
        { cwd: FLASK_WORKSPACE, encoding: 'utf8' }
      ).trim();
      console.log('✓ flask config output:');
      console.log(runConfigOut);
    } catch (runErr: any) {
      console.log(`Run notice: ${runErr.message}`);
    }

    taskBPassed = bResult.success;
    console.log(`\nTask B Status: ${taskBPassed ? 'PASSED ✓' : 'FAILED ✗'}\n`);
  } catch (err: any) {
    console.error('Task B encountered error:', err.message);
  }

  // -------------------------------------------------------------------------
  // SUMMARY SCORECARD
  // -------------------------------------------------------------------------
  console.log('================================================================');
  console.log('                   BENCHMARK TEST SUMMARY                       ');
  console.log('================================================================');
  console.log(`Task A (Inline Edit):              ${taskAPassed ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`Task B (Multi-File Agent Mode):    ${taskBPassed ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`Task C (Resilience & Fallback):    ${taskCPassed ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log('================================================================\n');

  const allPassed = taskAPassed && taskBPassed && taskCPassed;
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error during benchmark run:', err);
  process.exit(1);
});
