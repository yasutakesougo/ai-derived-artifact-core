import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nim-apply-approved-preflight-'));
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

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function runPreflight(inputPath: string, args: string[]): Promise<{ code: number; output: string }> {
  let output = '';
  let code = 0;

  try {
    const result = await execFileAsync(
      'node',
      ['scripts/ai/nvidia-nim-apply-approved-preflight.mjs', ...args, inputPath],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    output = `${result.stdout}${result.stderr}`;
    return { code: 0, output };
  } catch (error) {
    output = `${(error as { stdout?: string; stderr?: string }).stdout ?? ''}${(error as { stdout?: string; stderr?: string }).stderr ?? ''}`;
    code = (error as { code?: number }).code ?? 1;
    return { code, output };
  }
}

describe('NVIDIA NIM review apply approved preflight', () => {
  it('parses arguments', async () => {
    const parsed = JSON.parse(
      await runNodeModule(`
        import { parseApplyApprovedPreflightArgs } from './scripts/ai/nvidia-nim-apply-approved-preflight.mjs';
        const parsed = parseApplyApprovedPreflightArgs(['--allowlist', 'allow', '--expected-plan-hash', 'planhash', '--expected-input-path', 'source.md', '--expected-input-hash', 'inputhash', 'plan.json'], ${JSON.stringify(root)});
        process.stdout.write(JSON.stringify(parsed));
      `),
    );

    expect(parsed).toEqual({
      inputPath: resolve(root, 'plan.json'),
      allowlist: [resolve(root, 'allow')],
      expectedPlanHash: 'planhash',
      expectedInputPath: resolve(root, 'source.md'),
      expectedInputHash: 'inputhash',
    });
  });

  it('passes clean candidate with no warnings and matching summary', async () => {
    const inputPath = join(root, 'input-source.txt');
    await writeFile(inputPath, 'fixture source input', 'utf8');

    const payloadPath = join(root, 'clean-plan.json');
    const payload = {
      schemaVersion: 'nvidia-nim-apply-approved-dry-run/1.0',
      generatedAt: '2026-06-09T00:00:00.000Z',
      inputPath: resolve(root, 'input-source.txt'),
      summary: {
        total: 2,
        approved: 2,
        warnings: 0,
      },
      items: [
        {
          artifactId: 'a',
          path: 'artifact-a.md',
          suggestedTitle: 'A',
          labels: ['gold'],
          reason: 'ok',
        },
        {
          artifactId: 'b',
          path: 'artifact-b.md',
          suggestedTitle: 'B',
          labels: [],
          reason: 'ok',
        },
      ],
      warnings: [],
    };

    await writeFile(payloadPath, JSON.stringify(payload), 'utf8');

    const { code, output } = await runPreflight(payloadPath, []);

    expect(code).toBe(0);
    expect(output).toContain('Write preflight passed: apply-approved plan is write-ready candidate.');
    expect(output).toContain('Approved candidates: 2');
  });

  it('fails when summary.approved does not match rendered items', async () => {
    const inputPath = join(root, 'input-source.txt');
    const payloadPath = join(root, 'bad-summary.json');
    const payload = {
      schemaVersion: 'nvidia-nim-apply-approved-dry-run/1.0',
      generatedAt: '2026-06-09T00:00:00.000Z',
      inputPath: 'input-source.txt',
      summary: {
        total: 2,
        approved: 1,
        warnings: 0,
      },
      items: [
        {
          artifactId: 'a',
          path: 'artifact-a.md',
          suggestedTitle: 'A',
          labels: ['gold'],
          reason: 'ok',
        },
        {
          artifactId: 'b',
          path: 'artifact-b.md',
          suggestedTitle: 'B',
          labels: [],
          reason: 'ok',
        },
      ],
      warnings: [],
    };

    await writeFile(inputPath, 'source', 'utf8');
    await writeFile(payloadPath, JSON.stringify(payload), 'utf8');

    const { code, output } = await runPreflight(payloadPath, []);
    expect(code).toBe(1);
    expect(output).toContain('Summary mismatch');
  });

  it('fails when warnings exist', async () => {
    const inputPath = join(root, 'input-source.txt');
    const payloadPath = join(root, 'warn-plan.json');
    const payload = {
      schemaVersion: 'nvidia-nim-apply-approved-dry-run/1.0',
      generatedAt: '2026-06-09T00:00:00.000Z',
      inputPath: 'input-source.txt',
      summary: {
        total: 1,
        approved: 1,
        warnings: 1,
      },
      items: [
        {
          artifactId: 'a',
          path: 'artifact-a.md',
          suggestedTitle: 'A',
          labels: ['gold'],
          reason: 'ok',
        },
      ],
      warnings: [
        {
          type: 'failed-row',
          line: 4,
          message: 'sample warning',
        },
      ],
    };

    await writeFile(inputPath, 'source', 'utf8');
    await writeFile(payloadPath, JSON.stringify(payload), 'utf8');

    const { code, output } = await runPreflight(payloadPath, []);

    expect(code).toBe(1);
    expect(output).toContain('Preflight blocked because warning count is 1');
  });

  it('fails when item path is outside allowlist', async () => {
    const inputPath = join(root, 'input-source.txt');
    const payloadPath = join(root, 'path-plan.json');
    const payload = {
      schemaVersion: 'nvidia-nim-apply-approved-dry-run/1.0',
      generatedAt: '2026-06-09T00:00:00.000Z',
      inputPath: 'input-source.txt',
      summary: {
        total: 1,
        approved: 1,
        warnings: 0,
      },
      items: [
        {
          artifactId: 'a',
          path: '../outside.md',
          suggestedTitle: 'A',
          labels: ['gold'],
          reason: 'ok',
        },
      ],
      warnings: [],
    };

    await writeFile(inputPath, 'source', 'utf8');
    await writeFile(payloadPath, JSON.stringify(payload), 'utf8');

    const { code, output } = await runPreflight(payloadPath, []);
    expect(code).toBe(1);
    expect(output).toContain('contains directory traversal segment');
  });

  it('fails on input hash mismatch when lineage contract is requested', async () => {
    const inputPath = join(root, 'input-source.txt');
    const payloadPath = join(root, 'hash-plan.json');
    const payload = {
      schemaVersion: 'nvidia-nim-apply-approved-dry-run/1.0',
      generatedAt: '2026-06-09T00:00:00.000Z',
      inputPath: 'input-source.txt',
      summary: {
        total: 1,
        approved: 1,
        warnings: 0,
      },
      items: [
        {
          artifactId: 'a',
          path: 'artifact-a.md',
          suggestedTitle: 'A',
          labels: ['gold'],
          reason: 'ok',
        },
      ],
      warnings: [],
    };

    const sourceText = 'source-input';
    await writeFile(inputPath, sourceText, 'utf8');
    await writeFile(payloadPath, JSON.stringify(payload), 'utf8');

    const { code, output } = await runPreflight(payloadPath, [
      '--expected-input-path', inputPath,
      '--expected-input-hash', `${hashText(sourceText)}-bad`,
    ]);

    expect(code).toBe(1);
    expect(output).toContain('Input checksum mismatch');
  });

  it('fails on plan checksum mismatch', async () => {
    const inputPath = join(root, 'input-source.txt');
    const payloadPath = join(root, 'plan-hash-plan.json');
    const payload = {
      schemaVersion: 'nvidia-nim-apply-approved-dry-run/1.0',
      generatedAt: '2026-06-09T00:00:00.000Z',
      inputPath: 'input-source.txt',
      summary: {
        total: 1,
        approved: 1,
        warnings: 0,
      },
      items: [
        {
          artifactId: 'a',
          path: 'artifact-a.md',
          suggestedTitle: 'A',
          labels: ['gold'],
          reason: 'ok',
        },
      ],
      warnings: [],
    };

    await writeFile(inputPath, 'source', 'utf8');
    await writeFile(payloadPath, JSON.stringify(payload), 'utf8');

    const { code, output } = await runPreflight(payloadPath, ['--expected-plan-hash', '000000']);
    expect(code).toBe(1);
    expect(output).toContain('Plan checksum mismatch');
  });
});
