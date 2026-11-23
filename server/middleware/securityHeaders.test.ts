// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { securityHeaders } from './securityHeaders.js';

function csp(): Map<string, string[]> {
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => { headers[k] = v; } } as unknown as Response;
  securityHeaders({} as Request, res, () => {});
  return new Map(
    headers['Content-Security-Policy'].split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values] as [string, string[]];
    }),
  );
}

describe('securityHeaders', () => {
  it('lets WebAssembly compile (stem player MP3 decoder) without allowing JavaScript eval', () => {
    const scriptSrc = csp().get('script-src')!;
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it('allows same-origin workers (stem decoder worker) and blob: workers (Tone.js)', () => {
    expect(csp().get('worker-src')).toEqual(["'self'", 'blob:']);
  });
});
