import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const workflow = readFileSync(new URL('../../.github/workflows/middleware-canary.yml', import.meta.url), 'utf8');
// Execute the actual reporting step, with gh stubbed: no token or network access.
const report = workflow.slice(workflow.lastIndexOf('        run: |') + '        run: |'.length)
  .split(/\r?\n/).map(line => line.replace(/^          /, '')).join('\n');
const stub = `
gh() {
  printf '%s\\n' "$*" >> calls.log
  case "$1" in
    api)
      if [[ "$SCENARIO" == api-error ]]; then return 17; fi
      if [[ "$SCENARIO" == disabled ]]; then echo false; else echo true; fi ;;
    issue)
      if [[ "$2" == list && "$SCENARIO" == existing ]]; then echo 42; fi ;;
    *) return 19 ;;
  esac
}
`;

for (const scenario of ['disabled', 'new', 'existing', 'api-error']) {
  test(`middleware canary report: ${scenario}`, t => {
    if (process.platform === 'win32' && !existsSync(bash)) return t.skip('Git Bash unavailable');
    const directory = mkdtempSync(join(tmpdir(), 'caveman-canary-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', stub + report], {
      cwd: directory, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, GH_TOKEN: '', SCENARIO: scenario,
        GITHUB_REPOSITORY: 'example/canary', GITHUB_STEP_SUMMARY: 'summary.md',
        RUN_URL: 'https://github.com/example/canary/actions/runs/123' },
    });
    assert.equal(result.status, scenario === 'api-error' ? 17 : 0, result.stderr);
    const calls = readFileSync(join(directory, 'calls.log'), 'utf8');
    const summary = readFileSync(join(directory, 'summary.md'), 'utf8');
    assert.match(summary, /actions\/runs\/123/);
    if (scenario === 'disabled' || scenario === 'api-error') {
      assert.doesNotMatch(calls, /issue /);
      if (scenario === 'disabled') assert.match(summary, /Issues are disabled/);
    } else if (scenario === 'existing') {
      assert.match(calls, /issue comment 42 /);
      assert.doesNotMatch(calls, /issue create/);
    } else {
      assert.match(calls, /issue create /);
      assert.doesNotMatch(calls, /issue comment/);
    }
  });
}
