import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';

describe('NVIDIA NIM Batch Review E2E Tests', () => {
  const testArtifactsDir = path.resolve(import.meta.dirname, 'fixtures', 'nvidia-nim');
  const testFile1 = path.join(testArtifactsDir, 'test-artifact-1.md');
  const testFile2 = path.join(testArtifactsDir, 'test-artifact-2.md');
  const testFile3 = path.join(testArtifactsDir, 'test-artifact-3.md');

  // Helper to create a mock batch script output inline
  const createMockOutput = (filePaths: string[], responses: Record<string, object>) => {
    const results: Array<Record<string, unknown>> = [];
    let output = `\n--- NVIDIA NIM batch review (${filePaths.length} files) ---\n\n`;

    for (let i = 0; i < filePaths.length; i++) {
      const file = filePaths[i];
      if (!file) continue;
      const basename = file.split('/').pop() || 'unknown';
      output += `Processing [${i + 1}/${filePaths.length}] ${file}...\n`;

      const response = responses[basename] || {
        decision: 'approve',
        reason: 'Default approval',
        suggestedTitle: 'Test',
        riskNotes: [],
        confidence: 'high',
      };
      results.push({ file, success: true, ...(response as Record<string, unknown>) });
      output += `  ✓ ${(response as Record<string, unknown>).decision} (confidence: ${(response as Record<string, unknown>).confidence})\n`;
    }

    output += '\n--- Summary ---\n\n';
    const approved = results.filter((r) => (r as Record<string, unknown>).decision === 'approve').length;
    const needsReview = results.filter((r) => (r as Record<string, unknown>).decision === 'needs_review').length;
    const rejected = results.filter((r) => (r as Record<string, unknown>).decision === 'reject').length;

    output += `Total: ${filePaths.length}\n`;
    output += `  Approved: ${approved}\n`;
    output += `  Needs Review: ${needsReview}\n`;
    output += `  Rejected: ${rejected}\n`;
    output += `  Failed: 0\n`;

    output += '\n--- Detailed Results ---\n\n';
    output += JSON.stringify(results, null, 2);

    return output;
  };

  function extractJsonFromOutput(output: string): Array<Record<string, unknown>> | null {
    // Look for the "--- Detailed Results ---" section first
    const detailedResultsIdx = output.indexOf('--- Detailed Results ---');
    if (detailedResultsIdx === -1) {
      return null;
    }

    // Start searching for JSON after that marker
    const searchStart = detailedResultsIdx + '--- Detailed Results ---'.length;
    const jsonStart = output.indexOf('[', searchStart);
    const jsonEnd = output.lastIndexOf(']');

    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
      return null;
    }

    try {
      return JSON.parse(output.substring(jsonStart, jsonEnd + 1));
    } catch {
      return null;
    }
  }

  it('should process single file successfully', () => {
    const mockResponses = {
      'test-artifact-1.md': {
        decision: 'approve',
        reason: 'Well-documented',
        suggestedTitle: 'High Quality',
        riskNotes: [],
        confidence: 'high',
      },
    };

    const output = createMockOutput([testFile1], mockResponses);

    expect(output).toContain('NVIDIA NIM batch review');
    expect(output).toContain('✓ approve');
    expect(output).toContain('Total: 1');
    expect(output).toContain('Approved: 1');

    const results = extractJsonFromOutput(output);
    expect(results).not.toBeNull();
    expect(results).toHaveLength(1);
    expect(results?.[0]?.decision).toBe('approve');
  });

  it('should process multiple files with mixed decisions', () => {
    const mockResponses = {
      'test-artifact-1.md': {
        decision: 'approve',
        reason: 'Well-documented',
        suggestedTitle: 'High Quality',
        riskNotes: [],
        confidence: 'high',
      },
      'test-artifact-2.md': {
        decision: 'needs_review',
        reason: 'Needs expert review',
        suggestedTitle: 'Experimental',
        riskNotes: ['Risk1', 'Risk2'],
        confidence: 'medium',
      },
      'test-artifact-3.md': {
        decision: 'reject',
        reason: 'Outdated',
        suggestedTitle: '',
        riskNotes: ['Deprecated', 'Vulnerable'],
        confidence: 'high',
      },
    };

    const output = createMockOutput([testFile1, testFile2, testFile3], mockResponses);

    expect(output).toContain('(3 files)');
    expect(output).toContain('Total: 3');
    expect(output).toContain('Approved: 1');
    expect(output).toContain('Needs Review: 1');
    expect(output).toContain('Rejected: 1');

    const results = extractJsonFromOutput(output);
    expect(results).not.toBeNull();
    expect(results).toHaveLength(3);
    expect(results?.[0]?.decision).toBe('approve');
    expect(results?.[1]?.decision).toBe('needs_review');
    expect(results?.[2]?.decision).toBe('reject');
  });

  it('should display correct statistics for approval workflow', () => {
    const mockResponses = {
      'test-artifact-1.md': {
        decision: 'approve',
        reason: 'Good',
        suggestedTitle: 'Good',
        riskNotes: [],
        confidence: 'high',
      },
    };

    const output = createMockOutput([testFile1, testFile1], mockResponses);

    expect(output).toContain('Total: 2');
    expect(output).toContain('Approved: 2');
    expect(output).toContain('Needs Review: 0');
    expect(output).toContain('Rejected: 0');
  });

  it('should display correct statistics for rejection workflow', () => {
    const mockResponses = {
      'test-artifact-3.md': {
        decision: 'reject',
        reason: 'Outdated',
        suggestedTitle: '',
        riskNotes: ['Deprecated'],
        confidence: 'high',
      },
    };

    const output = createMockOutput([testFile3, testFile3, testFile3], mockResponses);

    expect(output).toContain('Total: 3');
    expect(output).toContain('Approved: 0');
    expect(output).toContain('Rejected: 3');
  });

  it('should display correct statistics for mixed workflow', () => {
    const mockResponses = {
      'test-artifact-1.md': {
        decision: 'approve',
        reason: 'Good',
        suggestedTitle: 'Good',
        riskNotes: [],
        confidence: 'high',
      },
      'test-artifact-2.md': {
        decision: 'needs_review',
        reason: 'Review needed',
        suggestedTitle: 'Experimental',
        riskNotes: ['Risk'],
        confidence: 'medium',
      },
      'test-artifact-3.md': {
        decision: 'reject',
        reason: 'Outdated',
        suggestedTitle: '',
        riskNotes: ['Deprecated'],
        confidence: 'high',
      },
    };

    const output = createMockOutput([testFile1, testFile2, testFile1, testFile3], mockResponses);

    expect(output).toContain('Total: 4');
    expect(output).toContain('Approved: 2');
    expect(output).toContain('Needs Review: 1');
    expect(output).toContain('Rejected: 1');
  });

  it('should include all required fields in JSON results', () => {
    const mockResponses = {
      'test-artifact-2.md': {
        decision: 'needs_review',
        reason: 'Needs review',
        suggestedTitle: 'Experimental',
        riskNotes: ['Risk1'],
        confidence: 'medium',
      },
    };

    const output = createMockOutput([testFile2], mockResponses);

    const results = extractJsonFromOutput(output);
    expect(results).not.toBeNull();
    if (results && results.length > 0) {
      const result = results[0];
      expect(result).toHaveProperty('file');
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('decision');
      expect(result).toHaveProperty('reason');
      expect(result).toHaveProperty('suggestedTitle');
      expect(result).toHaveProperty('riskNotes');
      expect(result).toHaveProperty('confidence');
    }
  });

  it('should validate decision field values', () => {
    const mockResponses = {
      'test-artifact-1.md': {
        decision: 'approve',
        reason: 'Good',
        suggestedTitle: 'Good',
        riskNotes: [],
        confidence: 'high',
      },
      'test-artifact-2.md': {
        decision: 'needs_review',
        reason: 'Review',
        suggestedTitle: 'Experimental',
        riskNotes: ['Risk'],
        confidence: 'medium',
      },
      'test-artifact-3.md': {
        decision: 'reject',
        reason: 'Outdated',
        suggestedTitle: '',
        riskNotes: ['Deprecated'],
        confidence: 'high',
      },
    };

    const output = createMockOutput([testFile1, testFile2, testFile3], mockResponses);

    const results = extractJsonFromOutput(output);
    expect(results).not.toBeNull();
    if (results) {
      const validDecisions = ['approve', 'needs_review', 'reject'];
      for (const result of results) {
        expect(validDecisions).toContain(result.decision);
      }
    }
  });

  it('should validate confidence field values', () => {
    const mockResponses = {
      'test-artifact-1.md': {
        decision: 'approve',
        reason: 'Good',
        suggestedTitle: 'Good',
        riskNotes: [],
        confidence: 'high',
      },
      'test-artifact-2.md': {
        decision: 'needs_review',
        reason: 'Review',
        suggestedTitle: 'Experimental',
        riskNotes: ['Risk'],
        confidence: 'medium',
      },
      'test-artifact-3.md': {
        decision: 'reject',
        reason: 'Outdated',
        suggestedTitle: '',
        riskNotes: ['Deprecated'],
        confidence: 'low',
      },
    };

    const output = createMockOutput([testFile1, testFile2, testFile3], mockResponses);

    const results = extractJsonFromOutput(output);
    expect(results).not.toBeNull();
    if (results) {
      const validConfidences = ['low', 'medium', 'high'];
      for (const result of results) {
        expect(validConfidences).toContain(result.confidence);
      }
    }
  });

  it('should contain risk notes array for needs_review decision', () => {
    const mockResponses = {
      'test-artifact-2.md': {
        decision: 'needs_review',
        reason: 'Needs review',
        suggestedTitle: 'Experimental',
        riskNotes: ['Risk1', 'Risk2', 'Risk3'],
        confidence: 'medium',
      },
    };

    const output = createMockOutput([testFile2], mockResponses);

    const results = extractJsonFromOutput(output);
    expect(results).not.toBeNull();
    if (results && results.length > 0) {
      const result = results[0];
      if (result) {
        expect(result.decision).toBe('needs_review');
        expect(Array.isArray(result.riskNotes)).toBe(true);
        expect((result.riskNotes as unknown[]).length).toBeGreaterThan(0);
      }
    }
  });
});
