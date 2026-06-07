/**
 * NVIDIA NIM Review Output Validator
 * Provides JSON extraction and schema validation for NIM review responses
 */

export interface NimReviewOutput {
  decision: 'approve' | 'needs_review' | 'reject';
  reason: string;
  suggestedTitle: string;
  riskNotes: string[];
  confidence: 'low' | 'medium' | 'high';
}

/**
 * Extracts JSON object from text, handling surrounding content
 * @param text - Text that may contain JSON
 * @returns Extracted JSON string
 * @throws Error if no valid JSON found
 */
export function extractJson(text: string): string {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');

  if (first === -1 || last === -1 || last < first) {
    throw new Error('No JSON found in output');
  }

  return text.substring(first, last + 1);
}

/**
 * Validates that a parsed object matches the NimReviewOutput schema
 * @param obj - Object to validate
 * @throws Error if validation fails
 */
export function validateNimReviewObject(obj: unknown): asserts obj is NimReviewOutput {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('Expected object, got ' + typeof obj);
  }

  const record = obj as Record<string, unknown>;

  // Validate decision
  const validDecisions = ['approve', 'needs_review', 'reject'];
  if (!validDecisions.includes(record.decision as string)) {
    throw new Error(
      `'decision' must be one of ['approve', 'needs_review', 'reject'], got: ${JSON.stringify(record.decision)}`
    );
  }

  // Validate reason
  if (typeof record.reason !== 'string' || record.reason.trim() === '') {
    throw new Error(
      `'reason' must be a non-empty string, got: ${JSON.stringify(record.reason)}`
    );
  }

  // Validate suggestedTitle
  if (typeof record.suggestedTitle !== 'string') {
    throw new Error(
      `'suggestedTitle' must be a string, got: ${JSON.stringify(record.suggestedTitle)}`
    );
  }

  // Validate riskNotes
  if (!Array.isArray(record.riskNotes)) {
    throw new Error(
      `'riskNotes' must be an array, got: ${JSON.stringify(record.riskNotes)}`
    );
  }
  if (!record.riskNotes.every((item) => typeof item === 'string')) {
    throw new Error(
      `'riskNotes' must be an array of strings, got: ${JSON.stringify(record.riskNotes)}`
    );
  }

  // Validate confidence
  const validConfidences = ['low', 'medium', 'high'];
  if (!validConfidences.includes(record.confidence as string)) {
    throw new Error(
      `'confidence' must be one of ['low', 'medium', 'high'], got: ${JSON.stringify(record.confidence)}`
    );
  }
}

/**
 * Parses and validates a complete NIM review output
 * @param jsonString - JSON string containing review output
 * @returns Validated NimReviewOutput object
 * @throws Error if parsing or validation fails
 */
export function parseAndValidateNimReview(jsonString: string): NimReviewOutput {
  let obj: unknown;

  try {
    obj = JSON.parse(jsonString);
  } catch (parseError) {
    throw new Error(
      `JSON parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`
    );
  }

  validateNimReviewObject(obj);
  return obj;
}

/**
 * Main validation workflow: extract JSON from text and validate
 * @param rawOutput - Raw output from NVIDIA NIM
 * @returns Validated NimReviewOutput object
 * @throws Error if extraction or validation fails
 */
export function validateNimOutput(rawOutput: string): NimReviewOutput {
  const jsonString = extractJson(rawOutput);
  return parseAndValidateNimReview(jsonString);
}
