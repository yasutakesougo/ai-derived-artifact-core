import { describe, expect, it } from 'vitest';
import {
  extractJson,
  validateNimReviewObject,
  parseAndValidateNimReview,
  validateNimOutput,
  type NimReviewOutput,
} from '../src/nvidia-nim-validator.js';

describe('NVIDIA NIM Validator', () => {
  describe('extractJson', () => {
    it('extracts JSON from text with surrounding content', () => {
      const input = 'Some text before\n{"key": "value"}\nSome text after';
      const result = extractJson(input);
      expect(result).toBe('{"key": "value"}');
    });

    it('extracts JSON when text starts with JSON', () => {
      const input = '{"decision": "approve"}\n\nExtra text';
      const result = extractJson(input);
      expect(result).toBe('{"decision": "approve"}');
    });

    it('extracts JSON when text ends with JSON', () => {
      const input = 'Some preamble\n{"confidence": "high"}';
      const result = extractJson(input);
      expect(result).toBe('{"confidence": "high"}');
    });

    it('handles nested objects', () => {
      const input = 'Text\n{"outer": {"inner": "value"}}\nMore text';
      const result = extractJson(input);
      expect(result).toBe('{"outer": {"inner": "value"}}');
    });

    it('throws error when no JSON found', () => {
      expect(() => extractJson('just plain text')).toThrow('No JSON found in output');
    });

    it('throws error when only opening brace', () => {
      expect(() => extractJson('text { more text')).toThrow('No JSON found in output');
    });

    it('throws error when only closing brace', () => {
      expect(() => extractJson('text } more text')).toThrow('No JSON found in output');
    });

    it('throws error when closing brace comes before opening brace', () => {
      expect(() => extractJson('} then { later')).toThrow('No JSON found in output');
    });
  });

  describe('validateNimReviewObject', () => {
    const validObject = {
      decision: 'approve',
      reason: 'Well-documented and useful',
      suggestedTitle: 'Useful artifact',
      riskNotes: ['Minor typo'],
      confidence: 'high',
    };

    it('accepts valid object with all required fields', () => {
      expect(() => validateNimReviewObject(validObject)).not.toThrow();
    });

    it('accepts valid object with empty riskNotes array', () => {
      const obj = { ...validObject, riskNotes: [] };
      expect(() => validateNimReviewObject(obj)).not.toThrow();
    });

    it('accepts valid object with empty suggestedTitle', () => {
      const obj = { ...validObject, suggestedTitle: '' };
      expect(() => validateNimReviewObject(obj)).not.toThrow();
    });

    it('rejects invalid decision', () => {
      const obj = { ...validObject, decision: 'invalid' };
      expect(() => validateNimReviewObject(obj)).toThrow(
        "'decision' must be one of ['approve', 'needs_review', 'reject']"
      );
    });

    it('rejects needs_review decision (valid value)', () => {
      const obj = { ...validObject, decision: 'needs_review' };
      expect(() => validateNimReviewObject(obj)).not.toThrow();
    });

    it('rejects reject decision (valid value)', () => {
      const obj = { ...validObject, decision: 'reject' };
      expect(() => validateNimReviewObject(obj)).not.toThrow();
    });

    it('rejects empty reason', () => {
      const obj = { ...validObject, reason: '' };
      expect(() => validateNimReviewObject(obj)).toThrow("'reason' must be a non-empty string");
    });

    it('rejects whitespace-only reason', () => {
      const obj = { ...validObject, reason: '   ' };
      expect(() => validateNimReviewObject(obj)).toThrow("'reason' must be a non-empty string");
    });

    it('rejects non-string reason', () => {
      const obj = { ...validObject, reason: 123 };
      expect(() => validateNimReviewObject(obj)).toThrow("'reason' must be a non-empty string");
    });

    it('rejects non-string suggestedTitle', () => {
      const obj = { ...validObject, suggestedTitle: 123 };
      expect(() => validateNimReviewObject(obj)).toThrow("'suggestedTitle' must be a string");
    });

    it('rejects non-array riskNotes', () => {
      const obj = { ...validObject, riskNotes: 'not an array' };
      expect(() => validateNimReviewObject(obj)).toThrow(
        "'riskNotes' must be an array"
      );
    });

    it('rejects riskNotes with non-string elements', () => {
      const obj = { ...validObject, riskNotes: ['string', 123, 'another'] };
      expect(() => validateNimReviewObject(obj)).toThrow(
        "'riskNotes' must be an array of strings"
      );
    });

    it('rejects invalid confidence value', () => {
      const obj = { ...validObject, confidence: 'very_high' };
      expect(() => validateNimReviewObject(obj)).toThrow(
        "'confidence' must be one of ['low', 'medium', 'high']"
      );
    });

    it('accepts low confidence', () => {
      const obj = { ...validObject, confidence: 'low' };
      expect(() => validateNimReviewObject(obj)).not.toThrow();
    });

    it('accepts medium confidence', () => {
      const obj = { ...validObject, confidence: 'medium' };
      expect(() => validateNimReviewObject(obj)).not.toThrow();
    });

    it('rejects null', () => {
      expect(() => validateNimReviewObject(null)).toThrow('Expected object, got object');
    });

    it('rejects undefined', () => {
      expect(() => validateNimReviewObject(undefined)).toThrow('Expected object, got undefined');
    });

    it('rejects non-object types', () => {
      expect(() => validateNimReviewObject('string')).toThrow('Expected object, got string');
      expect(() => validateNimReviewObject(123)).toThrow('Expected object, got number');
      expect(() => validateNimReviewObject(true)).toThrow('Expected object, got boolean');
    });
  });

  describe('parseAndValidateNimReview', () => {
    const validJson = JSON.stringify({
      decision: 'approve',
      reason: 'Good content',
      suggestedTitle: 'Title',
      riskNotes: [],
      confidence: 'high',
    });

    it('parses and validates valid JSON', () => {
      const result = parseAndValidateNimReview(validJson);
      expect(result.decision).toBe('approve');
      expect(result.reason).toBe('Good content');
    });

    it('throws error on invalid JSON', () => {
      expect(() => parseAndValidateNimReview('not valid json')).toThrow('JSON parse error');
    });

    it('throws error on invalid schema', () => {
      const invalidJson = JSON.stringify({
        decision: 'invalid_decision',
        reason: 'Reason',
        suggestedTitle: 'Title',
        riskNotes: [],
        confidence: 'high',
      });
      expect(() => parseAndValidateNimReview(invalidJson)).toThrow("'decision' must be one of");
    });

    it('returns typed object matching NimReviewOutput', () => {
      const result = parseAndValidateNimReview(validJson);
      expect(result).toHaveProperty('decision');
      expect(result).toHaveProperty('reason');
      expect(result).toHaveProperty('suggestedTitle');
      expect(result).toHaveProperty('riskNotes');
      expect(result).toHaveProperty('confidence');
    });
  });

  describe('validateNimOutput', () => {
    it('extracts and validates complete workflow', () => {
      const rawOutput = `
        Here is the review result in JSON format:
        
        {
          "decision": "needs_review",
          "reason": "Requires expert verification",
          "suggestedTitle": "Artifact Title",
          "riskNotes": ["Technical risk", "Unclear motivation"],
          "confidence": "medium"
        }
        
        Additional notes here...
      `;

      const result = validateNimOutput(rawOutput);

      expect(result.decision).toBe('needs_review');
      expect(result.reason).toBe('Requires expert verification');
      expect(result.suggestedTitle).toBe('Artifact Title');
      expect(result.riskNotes).toEqual(['Technical risk', 'Unclear motivation']);
      expect(result.confidence).toBe('medium');
    });

    it('throws error if JSON extraction fails', () => {
      const rawOutput = 'No JSON here at all';
      expect(() => validateNimOutput(rawOutput)).toThrow('No JSON found in output');
    });

    it('throws error if validation fails after extraction', () => {
      const rawOutput = `
        {
          "decision": "invalid",
          "reason": "Bad",
          "suggestedTitle": "Title",
          "riskNotes": [],
          "confidence": "high"
        }
      `;
      expect(() => validateNimOutput(rawOutput)).toThrow("'decision' must be one of");
    });

    it('handles real-world NIM output with preamble and epilogue', () => {
      const rawOutput = `
        Understanding your request... Processing artifact review...

        {
          "decision": "reject",
          "reason": "Contains outdated information",
          "suggestedTitle": "",
          "riskNotes": ["Outdated", "Not maintained"],
          "confidence": "high"
        }

        Review complete. Total processing time: 2.3s
      `;

      const result = validateNimOutput(rawOutput);

      expect(result.decision).toBe('reject');
      expect(result.reason).toBe('Contains outdated information');
      expect(result.confidence).toBe('high');
    });
  });

  describe('Integration scenarios', () => {
    it('handles all valid decision types', () => {
      const decisions: Array<'approve' | 'needs_review' | 'reject'> = [
        'approve',
        'needs_review',
        'reject',
      ];

      for (const decision of decisions) {
        const obj = {
          decision,
          reason: 'Test reason',
          suggestedTitle: 'Test',
          riskNotes: [],
          confidence: 'high' as const,
        };
        expect(() => validateNimReviewObject(obj)).not.toThrow();
      }
    });

    it('handles all valid confidence levels', () => {
      const confidences: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];

      for (const confidence of confidences) {
        const obj = {
          decision: 'approve' as const,
          reason: 'Test reason',
          suggestedTitle: 'Test',
          riskNotes: [],
          confidence,
        };
        expect(() => validateNimReviewObject(obj)).not.toThrow();
      }
    });

    it('validates realistic multi-risk scenario', () => {
      const realWorldOutput = JSON.stringify({
        decision: 'needs_review',
        reason: 'Code quality acceptable, but requires domain expert review for business logic',
        suggestedTitle: 'Financial Analysis Tool v2',
        riskNotes: [
          'No unit tests for edge cases',
          'Performance optimization needed for large datasets',
          'Requires security audit before production use',
          'Documentation incomplete for API endpoints',
        ],
        confidence: 'medium',
      });

      const result = parseAndValidateNimReview(realWorldOutput);

      expect(result.decision).toBe('needs_review');
      expect(result.riskNotes.length).toBe(4);
      expect(result.riskNotes[0]).toBe('No unit tests for edge cases');
    });
  });
});
