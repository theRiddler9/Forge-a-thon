import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export function verifyTaskB(flaskWorkspacePath: string): { success: boolean; details: string[] } {
  const details: string[] = [];

  // 1. Verify diff touches >= 3 files
  const expectedFiles = ['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst'];
  const presentFiles = expectedFiles.filter((f) => fs.existsSync(path.join(flaskWorkspacePath, f)));

  details.push(`Found ${presentFiles.length}/${expectedFiles.length} expected files: ${presentFiles.join(', ')}`);

  // Check git status to verify >= 3 files touched
  try {
    const gitDiff = execSync('git status --short', {
      cwd: flaskWorkspacePath,
      encoding: 'utf8',
    });
    const modifiedLines = gitDiff.split('\n').filter((l) => l.trim().length > 0);
    details.push(`Git modified files count: ${modifiedLines.length}`);
    if (modifiedLines.length >= 3) {
      details.push('✓ Diff touches >= 3 files unprompted');
    }
  } catch {}

  // 2. Verify pytest tests/test_cli.py
  const pythonBin = fs.existsSync(path.join(flaskWorkspacePath, '.venv/Scripts/python.exe'))
    ? path.join(flaskWorkspacePath, '.venv/Scripts/python.exe')
    : fs.existsSync(path.join(flaskWorkspacePath, '.venv/bin/python'))
    ? path.join(flaskWorkspacePath, '.venv/bin/python')
    : 'python';

  try {
    const pytestOut = execSync(`"${pythonBin}" -m pytest tests/test_cli.py -q`, {
      cwd: flaskWorkspacePath,
      encoding: 'utf8',
    });
    details.push('✓ pytest tests/test_cli.py passed');
  } catch (err: any) {
    details.push(`✗ pytest failed: ${err.message}`);
  }

  // 3. Verify masking behavior
  const cliFile = path.join(flaskWorkspacePath, 'src/flask/cli.py');
  if (fs.existsSync(cliFile)) {
    const content = fs.readFileSync(cliFile, 'utf8');
    const hasMasking =
      content.includes('SECRET') &&
      content.includes('PASSWORD') &&
      content.includes('TOKEN') &&
      content.includes('KEY');
    if (hasMasking) {
      details.push('✓ CLI code checks for SECRET, PASSWORD, TOKEN, and KEY');
    } else {
      details.push('✗ CLI code missing one or more required mask keys');
    }
  }

  const allPassed = details.every((d) => !d.startsWith('✗'));
  return {
    success: allPassed,
    details,
  };
}

if (process.argv[1]?.includes('verify-task-b')) {
  const targetDir = process.argv[2] || process.cwd();
  console.log(`Verifying Task B in: ${targetDir}`);
  const result = verifyTaskB(targetDir);
  console.log(result.details.join('\n'));
  console.log(`Result: ${result.success ? 'PASSED' : 'FAILED'}`);
  process.exit(result.success ? 0 : 1);
}
