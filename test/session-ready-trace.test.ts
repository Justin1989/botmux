import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sessionReadyTraceDirectory,
  sessionReadyTraceFileName,
  sessionReadyErrorKind,
  writeSessionReadyTrace,
} from '../src/core/session-ready-trace.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('session-ready trace', () => {
  it('does not create diagnostics unless explicitly enabled', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-session-ready-trace-'));
    tempDirs.push(dataDir);

    writeSessionReadyTrace(dataDir, 'session-a', 'hook_start', { hasAppId: true });

    expect(existsSync(join(dataDir, 'session-ready-traces'))).toBe(false);
  });

  it('uses a fixed safe filename and excludes undefined fields', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-session-ready-trace-'));
    tempDirs.push(dataDir);
    const sessionId = '../../trace-escape';
    vi.stubEnv('BOTMUX_SESSION_READY_TRACE', '1');

    writeSessionReadyTrace(dataDir, sessionId, 'daemon_rejected', {
      hasCapability: true,
      hasTurnId: undefined,
    });

    expect(existsSync(join(dataDir, 'trace-escape.jsonl'))).toBe(false);
    const line = JSON.parse(readFileSync(
      join(sessionReadyTraceDirectory(dataDir, sessionId), sessionReadyTraceFileName(sessionId)),
      'utf8',
    ));
    expect(line).toMatchObject({ event: 'daemon_rejected', hasCapability: true });
    expect(line).not.toHaveProperty('hasTurnId');
    expect(sessionReadyTraceFileName(sessionId)).toMatch(/^[a-f0-9]{64}\.jsonl$/);
  });

  it('records missing session context in an isolated fixed directory', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-session-ready-trace-'));
    tempDirs.push(dataDir);
    vi.stubEnv('BOTMUX_SESSION_READY_TRACE', '1');

    writeSessionReadyTrace(dataDir, undefined, 'hook_skip_missing_context', {
      hasSessionId: false,
      hasAppId: true,
    });

    const traceDir = sessionReadyTraceDirectory(dataDir, undefined);
    expect(traceDir).toBe(join(dataDir, 'session-ready-traces', 'missing-session'));
    expect(JSON.parse(readFileSync(join(traceDir, sessionReadyTraceFileName(undefined)), 'utf8')))
      .toMatchObject({ event: 'hook_skip_missing_context', hasSessionId: false, hasAppId: true });
  });

  it('classifies fetch cause codes without exposing error messages', () => {
    const error = new TypeError('request failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    expect(sessionReadyErrorKind(error)).toBe('econnrefused');
  });

  it('swallows output failures', () => {
    vi.stubEnv('BOTMUX_SESSION_READY_TRACE', '1');
    vi.stubEnv('BOTMUX_SESSION_READY_TRACE_DIR', '/dev/null/session-ready-traces');

    expect(() => {
      writeSessionReadyTrace('/unused', 'session-a', 'hook_start', { hasAppId: true });
    }).not.toThrow();
  });
});
