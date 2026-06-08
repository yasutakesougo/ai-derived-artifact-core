#!/usr/bin/env node

/**
 * Public repository safety check
 * Detects and prevents accidental commits of sensitive data:
 * - .env files
 * - API keys and credentials
 * - Private data (records, personal information)
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATH_PATTERNS = {
  envFile: /(^|\/)\.env($|\.(?!example$)[^/]+$)/,
  recordsDir: /^records\//,
};

const CONTENT_PATTERNS = {
  apiKey: /NVIDIA_API_KEY\s*=/i,
  nvapiPattern: /nvapi-[a-zA-Z0-9_-]{20,}/,
  privateKey: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |)PRIVATE KEY-----/,
  bearerToken: /Bearer\s+[A-Za-z0-9_-]{20,}/,
  awsKey: /AKIA[0-9A-Z]{16}/,
  gcpKey: /"type":\s*"service_account"/,
};

const PATTERN_NAMES = {
  envFile: '.env file',
  recordsDir: 'records/ directory (should be .gitignore)',
  apiKey: 'NVIDIA_API_KEY pattern',
  nvapiPattern: 'NVIDIA API key pattern (nvapi-)',
  privateKey: 'Private key pattern',
  bearerToken: 'Bearer token pattern',
  awsKey: 'AWS access key pattern',
  gcpKey: 'GCP service account pattern',
};

function getTrackedFiles() {
  try {
    const output = execSync('git ls-files', { encoding: 'utf-8' });
    return output.split('\n').filter(Boolean);
  } catch (error) {
    console.error('Error running git ls-files:', error.message);
    process.exit(1);
  }
}

function checkFileContent(content) {
  const violations = [];
  
  for (const [patternKey, pattern] of Object.entries(CONTENT_PATTERNS)) {
    if (pattern.test(content)) {
      violations.push({
        pattern: patternKey,
        name: PATTERN_NAMES[patternKey],
        match: content.match(pattern)?.[0],
      });
    }
  }
  
  return violations;
}

function readTrackedTextFile(file) {
  try {
    const buffer = readFileSync(file);
    if (buffer.includes(0)) {
      return null;
    }
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

function main() {
  const trackedFiles = getTrackedFiles();
  let hasViolations = false;
  const violations = [];

  for (const file of trackedFiles) {
    // Check filename patterns
    for (const [patternKey, pattern] of Object.entries(PATH_PATTERNS)) {
      if (pattern.test(file)) {
        hasViolations = true;
        violations.push({
          file,
          reason: `Filename matches ${PATTERN_NAMES[patternKey]} pattern`,
          pattern: patternKey,
        });
      }
    }

    // Check every tracked text file for sensitive content patterns.
    const content = readTrackedTextFile(file);
    if (content !== null) {
      const fileViolations = checkFileContent(content);
      if (fileViolations.length > 0) {
        hasViolations = true;
        for (const violation of fileViolations) {
          violations.push({
            file,
            reason: violation.name,
            pattern: violation.pattern,
            match: violation.match,
          });
        }
      }
    }
  }

  if (hasViolations) {
    console.error('\n❌ SAFETY CHECK FAILED: Sensitive data detected in tracked files\n');
    console.error('Violations found:');
    console.error('─'.repeat(80));
    
    for (const violation of violations) {
      console.error(`\nFile: ${violation.file}`);
      console.error(`Issue: ${violation.reason}`);
      if (violation.match) {
        console.error(`Match: ${violation.match.substring(0, 60)}${violation.match.length > 60 ? '...' : ''}`);
      }
    }
    
    console.error('\n' + '─'.repeat(80));
    console.error('\n⚠️  Do NOT commit:');
    console.error('  - .env files (use .env.example for documentation)');
    console.error('  - API keys, tokens, or credentials');
    console.error('  - Private keys or certificates');
    console.error('  - AWS, GCP, or other cloud credentials');
    console.error('  - records/ or real audit data');
    console.error('  - Personal information or sensitive business data\n');
    
    process.exit(1);
  }

  console.log('✓ Safety check passed: No sensitive data detected in tracked files');
  process.exit(0);
}

main();
