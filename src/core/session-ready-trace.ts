import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TRACE_ENV = 'BOTMUX_SESSION_READY_TRACE';
const TRACE_DIR = 'session-ready-traces';
const TRACE_OUTPUT_ENV = 'BOTMUX_SESSION_READY_TRACE_DIR';

export type SessionReadyTraceEvent =
  | 'hook_start'
  | 'hook_skip_missing_context'
  | 'hook_port_resolved'
  | 'hook_skip_missing_port'
  | 'hook_http_result'
  | 'hook_http_error'
  | 'daemon_rejected'
  | 'daemon_forwarded'
  | 'daemon_forward_error'
  | 'daemon_no_worker'
  | 'worker_gate_armed'
  | 'worker_gate_released'
  | 'worker_signal_received';

export function sessionReadyTraceEnabled(): boolean {
  return process.env[TRACE_ENV] === '1';
}

function sessionReadyTraceKey(sessionId: string | undefined): string {
  return sessionId
    ? createHash('sha256').update(sessionId).digest('hex')
    : 'missing-session';
}

export function sessionReadyTraceDirectory(dataDir: string, sessionId: string | undefined): string {
  return join(dataDir, TRACE_DIR, sessionReadyTraceKey(sessionId));
}

export function sessionReadyTraceFileName(sessionId: string | undefined): string {
  return `${sessionReadyTraceKey(sessionId)}.jsonl`;
}

export function writeSessionReadyTrace(
  dataDir: string | undefined,
  sessionId: string | undefined,
  event: SessionReadyTraceEvent,
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  if (!sessionReadyTraceEnabled() || !dataDir) return;
  const outputDir = process.env[TRACE_OUTPUT_ENV]
    ?? sessionReadyTraceDirectory(dataDir, sessionId);
  try {
    mkdirSync(outputDir, { recursive: true });
    const sanitized = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );
    appendFileSync(
      join(outputDir, sessionReadyTraceFileName(sessionId)),
      `${JSON.stringify({ at: new Date().toISOString(), event, ...sanitized })}\n`,
    );
  } catch {
    // Diagnostics must never affect the SessionStart hook or prompt delivery.
  }
}

function errorCode(value: unknown): string | undefined {
  const code = (value as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)
    ? code.toLowerCase()
    : undefined;
}

export function sessionReadyErrorKind(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'abort';
  if (error instanceof Error) {
    return errorCode(error)
      ?? errorCode(error.cause)
      ?? (error.name === 'TypeError' ? 'network' : 'error');
  }
  return 'unknown';
}
