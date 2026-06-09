import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nim-apply-receive-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function runNodeModule(script: string): Promise<string> {
  const result = await execFileAsync('node', ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
  });
  return result.stdout;
}

describe('NVIDIA NIM review apply receive', () => {
  it('parses positional input path', async () => {
    const parsed = JSON.parse(
      await runNodeModule(`
        import { parseApplyReceiveArgs } from './scripts/ai/nvidia-nim-apply-receive.mjs';
        const parsed = parseApplyReceiveArgs(['apply-dry-run.json'], ${JSON.stringify(root)});
        process.stdout.write(JSON.stringify(parsed));
      `),
    );

    expect(parsed).toEqual({
      inputPath: resolve(root, 'apply-dry-run.json'),
    });
  });

  it('receives fixture dry-run JSON and prints candidate summary', async () => {
    const inputPath = resolve(import.meta.dirname, 'fixtures', 'nvidia-nim', 'reviews-apply-dry-run.expected.json');

    const result = await execFileAsync(
      'node',
      ['scripts/ai/nvidia-nim-apply-receive.mjs', inputPath],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.stdout).toContain('Validation passed: NVIDIA NIM apply-dry-run payload is valid for apply-approved-review receiver.');
    expect(result.stdout).toContain('Apply receive candidates:');
    expect(result.stdout).toContain('artifact-a');
    expect(result.stdout).toContain('artifact-c');
    expect(result.stdout).toContain('labels: gold, high-confidence');
    expect(result.stdout).toContain('Candidate summary: 4 item(s), 2 failed row(s).');
  });

  it('warns when failed rows are present', async () => {
    const invalidPayloadPath = join(root, 'failed.json');
    await writeFile(
      invalidPayloadPath,
      JSON.stringify({
        schemaVersion: 'nvidia-nim-apply-dry-run/1.0',
        inputPath: '/tmp/x',
        summary: { total: 1, approved: 1, failed: 1 },
        items: [{
          artifactId: 'artifact-a',
          path: 'a.md',
          suggestedTitle: 'A',
          labels: ['t'],
          reason: 'r',
        }],
        failed: [{
          line: 2,
          error: 'broken row',
        }],
      }),
      'utf8',
    );

    const result = await execFileAsync(
      'node',
      ['scripts/ai/nvidia-nim-apply-receive.mjs', invalidPayloadPath],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.stdout).toContain('Candidate summary: 1 item(s), 1 failed row(s).');
    expect(result.stdout).toContain('Validation passed');
    expect(result.stderr).toContain('Warning: 1 failed row(s) were present in payload.');
  });

  it('fails for invalid JSON payload', async () => {
    const invalidInput = join(root, 'invalid.json');
    await writeFile(invalidInput, '{ invalid json', 'utf8');

    let output = '';
    let exitCode = 0;
    try {
      await execFileAsync(
        'node',
        ['scripts/ai/nvidia-nim-apply-receive.mjs', invalidInput],
        { cwd: process.cwd() },
      );
    } catch (error) {
      output = (error as { stdout?: string; stderr?: string }).stdout ?? '';
      output += (error as { stdout?: string; stderr?: string }).stderr ?? '';
      exitCode = (error as { code?: number }).code ?? 1;
    }

    expect(exitCode).toBe(1);
    expect(output).toContain('Invalid JSON');
  });
});
