/**
 * CLI boundary regression for a SessionStart hook running inside file/read
 * isolation, where dashboard-daemons is deliberately masked. The hook must use
 * BOTMUX_DAEMON_IPC_PORT and carry the rotating relay capability.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';
import {
  sessionReadyTraceDirectory,
  sessionReadyTraceFileName,
} from '../src/core/session-ready-trace.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runSessionReady(
  dataDir: string,
  relayDir: string,
  port: number,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: extraEnv.BOTMUX_SESSION_ID ?? 'sess_ready_test',
      BOTMUX_LARK_APP_ID: 'cli_ready_test',
      BOTMUX_SEND_RELAY: relayDir,
      BOTMUX_DAEMON_IPC_PORT: String(port),
      ...extraEnv,
    };
    delete env.BOTMUX_TURN_ID;
    delete env.BOTMUX_DISPATCH_ATTEMPT;

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CLI_PATH, 'session-ready'],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify({ source: 'startup' }));
  });
}

describe('botmux session-ready — isolated CLI fallback', () => {
  it('uses the injected daemon port when the discovery directory is absent', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-session-ready-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-session-ready-relay-'));
    tempDirs.push(dataDir, relayDir);
    const capability = 'a'.repeat(64);
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(
      join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ token: capability }),
    );

    let receivedBody = '';
    let receivedUrl = '';
    const server = createServer((req, res) => {
      receivedUrl = req.url ?? '';
      req.setEncoding('utf8');
      req.on('data', chunk => { receivedBody += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const result = await runSessionReady(dataDir, relayDir, port);
      expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
      expect(receivedUrl).toBe('/api/session-ready');
      expect(JSON.parse(receivedBody)).toMatchObject({
        sessionId: 'sess_ready_test',
        source: 'startup',
        originCapability: capability,
      });
      expect(existsSync(join(dataDir, 'session-ready-traces'))).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it('writes a sanitized trace for an authorization rejection', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-session-ready-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-session-ready-relay-'));
    tempDirs.push(dataDir, relayDir);
    const capability = 'b'.repeat(64);
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(
      join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ token: capability }),
    );

    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"origin_unproven"}');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const result = await runSessionReady(dataDir, relayDir, port, {
        BOTMUX_SESSION_READY_TRACE: '1',
      });
      expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
      const lines = readFileSync(
        join(sessionReadyTraceDirectory(dataDir, 'sess_ready_test'), sessionReadyTraceFileName('sess_ready_test')),
        'utf8',
      ).trim().split('\n').map(line => JSON.parse(line));
      expect(lines).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: 'hook_start',
          hasAppId: true,
          hasInjectedPort: true,
          hasRelay: true,
        }),
        expect.objectContaining({
          event: 'hook_port_resolved',
          portSource: 'injected',
        }),
        expect.objectContaining({
          event: 'hook_http_result',
          status: 403,
          transport: 'capability',
          hasCapability: true,
        }),
      ]));
      expect(JSON.stringify(lines)).not.toContain(capability);
      expect(JSON.stringify(lines)).not.toContain(relayDir);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it('records missing session context without calling the daemon', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-session-ready-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-session-ready-relay-'));
    tempDirs.push(dataDir, relayDir);
    const result = await runSessionReady(dataDir, relayDir, 1, {
      BOTMUX_SESSION_ID: '',
      BOTMUX_SESSION_READY_TRACE: '1',
    });

    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
    const lines = readFileSync(
      join(sessionReadyTraceDirectory(dataDir, undefined), sessionReadyTraceFileName(undefined)),
      'utf8',
    ).trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'hook_start', hasSessionId: false, hasAppId: true }),
      expect.objectContaining({ event: 'hook_skip_missing_context', hasSessionId: false, hasAppId: true }),
    ]));
  });

  it('contains a hostile session ID in a hashed trace filename', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-session-ready-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-session-ready-relay-'));
    tempDirs.push(dataDir, relayDir);
    const sessionId = '../../outside';
    const capability = 'c'.repeat(64);
    writeFileSync(
      join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ token: capability }),
    );

    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"origin_unproven"}');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const result = await runSessionReady(dataDir, relayDir, port, {
        BOTMUX_SESSION_ID: sessionId,
        BOTMUX_SESSION_READY_TRACE: '1',
      });
      expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
      expect(existsSync(join(dataDir, 'outside.jsonl'))).toBe(false);
      const traceDir = sessionReadyTraceDirectory(dataDir, sessionId);
      expect(readFileSync(join(traceDir, sessionReadyTraceFileName(sessionId)), 'utf8'))
        .toContain('hook_http_result');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });
});
