/**
 * Enforces the brief's overriding constraint: this application has no AI API,
 * no AI SDK, no LLM runtime, and no AI-related environment variable.
 *
 * This is a test rather than a comment so the constraint cannot silently rot as
 * the codebase grows. It fails the build if anyone adds an AI dependency,
 * imports an AI client, references an AI environment variable, or hard-codes an
 * AI provider hostname.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const FORBIDDEN_PACKAGES = [
  'openai',
  '@openai/',
  '@anthropic-ai/',
  'anthropic',
  '@google/generative-ai',
  '@google-cloud/aiplatform',
  '@google/genai',
  'google-generativeai',
  'groq-sdk',
  'openrouter',
  'ollama',
  'langchain',
  '@langchain/',
  'llamaindex',
  'llama-node',
  'node-llama-cpp',
  'transformers',
  '@xenova/transformers',
  'onnxruntime-node',
  '@huggingface/',
  'cohere-ai',
  'mistralai',
  '@mistralai/',
  'replicate',
  'together-ai',
  'vercel-ai',
  // the `ai` SDK, matched exactly rather than as a substring
];

const FORBIDDEN_ENV_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'HUGGINGFACE_API_KEY',
  'HF_TOKEN',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'AI_PROVIDER',
  'LLM_PROVIDER',
  'AI_MODEL',
  'LLM_MODEL',
  'OLLAMA_HOST',
  'AI_API_KEY',
];

const FORBIDDEN_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.groq.com',
  'openrouter.ai',
  'api.cohere.ai',
  'api.mistral.ai',
  'api-inference.huggingface.co',
  'api.replicate.com',
  'localhost:11434',
];

/** Every source file under the given roots, excluding this test itself. */
function collectSourceFiles(dirs: string[]): string[] {
  const files: string[] = [];
  const selfPath = path.resolve(ROOT, 'tests/unit/no-ai-dependency.test.ts');

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
      const full = path.join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry) && path.resolve(full) !== selfPath) {
        files.push(full);
      }
    }
  };

  for (const dir of dirs) walk(path.resolve(ROOT, dir));
  return files;
}

describe('no AI dependency', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const declared = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];

  it('declares no AI package in package.json', () => {
    const offenders = declared.filter((name) =>
      FORBIDDEN_PACKAGES.some((forbidden) =>
        forbidden.endsWith('/') ? name.startsWith(forbidden) : name === forbidden || name.startsWith(`${forbidden}/`),
      ),
    );
    expect(offenders, `AI packages found in package.json: ${offenders.join(', ')}`).toEqual([]);
  });

  it('does not declare the bare "ai" SDK package', () => {
    expect(declared).not.toContain('ai');
  });

  it('installs no AI package into node_modules', () => {
    let installed: string[] = [];
    try {
      installed = readdirSync(path.join(ROOT, 'node_modules'));
    } catch {
      return; // dependencies not installed; the manifest check above still applies
    }

    const offenders = installed.filter(
      (name) =>
        name === 'ai' ||
        name === 'openai' ||
        name === 'anthropic' ||
        name === 'ollama' ||
        name === 'langchain' ||
        name === 'llamaindex' ||
        name === 'cohere-ai' ||
        name === 'replicate',
    );
    expect(offenders, `AI packages installed: ${offenders.join(', ')}`).toEqual([]);
  });

  it('has no AI-related environment variable in .env.example', () => {
    const example = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    // Strip comment lines: .env.example documents the *absence* of these vars.
    const active = example
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

    for (const name of FORBIDDEN_ENV_VARS) {
      expect(active, `${name} must not appear in .env.example`).not.toContain(name);
    }
  });

  it('references no AI environment variable anywhere in the source', () => {
    const files = collectSourceFiles(['src', 'app', 'tests']);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const name of FORBIDDEN_ENV_VARS) {
        if (contents.includes(name)) offenders.push(`${path.relative(ROOT, file)} → ${name}`);
      }
    }
    expect(offenders, `AI environment variables referenced: ${offenders.join('; ')}`).toEqual([]);
  });

  it('contains no AI provider hostname in the source', () => {
    const files = collectSourceFiles(['src', 'app']);
    const offenders: string[] = [];

    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const host of FORBIDDEN_HOSTS) {
        if (contents.includes(host)) offenders.push(`${path.relative(ROOT, file)} → ${host}`);
      }
    }
    expect(offenders, `AI hostnames found: ${offenders.join('; ')}`).toEqual([]);
  });

  it('imports no AI client module in the source', () => {
    const files = collectSourceFiles(['src', 'app']);
    const importPattern = /\b(?:import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
    const offenders: string[] = [];

    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const match of contents.matchAll(importPattern)) {
        const specifier = match[1] ?? '';
        if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
        if (
          specifier === 'ai' ||
          FORBIDDEN_PACKAGES.some((forbidden) =>
            forbidden.endsWith('/')
              ? specifier.startsWith(forbidden)
              : specifier === forbidden || specifier.startsWith(`${forbidden}/`),
          )
        ) {
          offenders.push(`${path.relative(ROOT, file)} → ${specifier}`);
        }
      }
    }
    expect(offenders, `AI imports found: ${offenders.join('; ')}`).toEqual([]);
  });

  it('keeps the runtime dependency list small and auditable', () => {
    // Not a style preference: every dependency is attack surface, and a short
    // list is what makes the AI-free claim verifiable by inspection.
    expect(Object.keys(manifest.dependencies ?? {}).length).toBeLessThanOrEqual(10);
  });
});
