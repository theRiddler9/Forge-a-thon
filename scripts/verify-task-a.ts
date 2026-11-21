import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export function verifyTaskA(flaskWorkspacePath: string): { success: boolean; details: string[] } {
  const details: string[] = [];
  const helpersPath = path.join(flaskWorkspacePath, 'src/flask/helpers.py');

  if (!fs.existsSync(helpersPath)) {
    return {
      success: false,
      details: [`helpers.py not found at ${helpersPath}`],
    };
  }

  const content = fs.readFileSync(helpersPath, 'utf8');

  // 1. Check docstring updates
  const hasOff = content.includes("'off'") || content.includes('"off"');
  const hasN = content.includes("'n'") || content.includes('"n"');
  if (!hasOff || !hasN) {
    details.push("Docstring or code does not explicitly mention 'off' and 'n'");
  } else {
    details.push("✓ Code/Docstring contains 'off' and 'n'");
  }

  // 2. Test execution with python
  const pythonBin = fs.existsSync(path.join(flaskWorkspacePath, '.venv/Scripts/python.exe'))
    ? path.join(flaskWorkspacePath, '.venv/Scripts/python.exe')
    : fs.existsSync(path.join(flaskWorkspacePath, '.venv/bin/python'))
    ? path.join(flaskWorkspacePath, '.venv/bin/python')
    : 'python';

  const testCases = [
    { envVal: 'off', expected: 'False' },
    { envVal: 'OFF', expected: 'False' },
    { envVal: 'n', expected: 'False' },
    { envVal: 'N', expected: 'False' },
    { envVal: '0', expected: 'False' },
    { envVal: '1', expected: 'True' },
    { envVal: 'true', expected: 'True' },
  ];

  let allPass = true;
  for (const tc of testCases) {
    try {
      const out = execSync(
        `"${pythonBin}" -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`,
        {
          cwd: flaskWorkspacePath,
          env: { ...process.env, FLASK_DEBUG: tc.envVal },
          encoding: 'utf8',
        }
      ).trim();

      if (out === tc.expected) {
        details.push(`✓ FLASK_DEBUG=${tc.envVal} -> ${out}`);
      } else {
        allPass = false;
        details.push(`✗ FLASK_DEBUG=${tc.envVal} expected ${tc.expected}, got ${out}`);
      }
    } catch (err: any) {
      allPass = false;
      details.push(`✗ Error evaluating FLASK_DEBUG=${tc.envVal}: ${err.message}`);
    }
  }

  return {
    success: allPass,
    details,
  };
}

if (process.argv[1]?.includes('verify-task-a')) {
  const targetDir = process.argv[2] || process.cwd();
  console.log(`Verifying Task A in: ${targetDir}`);
  const result = verifyTaskA(targetDir);
  console.log(result.details.join('\n'));
  console.log(`Result: ${result.success ? 'PASSED' : 'FAILED'}`);
  process.exit(result.success ? 0 : 1);
}
