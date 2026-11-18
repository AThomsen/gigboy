// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadAuthConfig } from './authConfig.js';

const SMTP = { SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'Gigboy <gigboy@example.com>' };
const HTTPS = { PUBLIC_ORIGIN: 'https://gigboy.example.com' };

describe('loadAuthConfig', () => {
  it('defaults to passwords only, as before', () => {
    expect(loadAuthConfig({})).toEqual({ passwords: true, magicLinks: false, passkeys: false });
  });

  it('accepts every method together when their requirements are met', () => {
    expect(loadAuthConfig({ AUTH_MAGIC_LINKS: 'true', AUTH_PASSKEYS: 'true', ...SMTP, ...HTTPS })).toEqual({
      passwords: true,
      magicLinks: true,
      passkeys: true,
    });
  });

  it('accepts fully passwordless: emailed sign-in plus passkeys', () => {
    const config = loadAuthConfig({ AUTH_PASSWORDS: 'false', AUTH_MAGIC_LINKS: 'true', AUTH_PASSKEYS: 'true', ...SMTP, ...HTTPS });
    expect(config).toEqual({ passwords: false, magicLinks: true, passkeys: true });
  });

  it('rejects having no method at all', () => {
    expect(() => loadAuthConfig({ AUTH_PASSWORDS: 'false' })).toThrow(/At least one/);
  });

  it('rejects a flag that is not true/false', () => {
    expect(() => loadAuthConfig({ AUTH_PASSKEYS: 'yes' })).toThrow(/AUTH_PASSKEYS must be/);
  });

  it('requires SMTP and PUBLIC_ORIGIN for magic links', () => {
    expect(() => loadAuthConfig({ AUTH_MAGIC_LINKS: 'true', ...HTTPS })).toThrow(/SMTP_HOST/);
    expect(() => loadAuthConfig({ AUTH_MAGIC_LINKS: 'true', ...SMTP })).toThrow(/PUBLIC_ORIGIN/);
    // Plain http is fine for emailed links.
    expect(loadAuthConfig({ AUTH_MAGIC_LINKS: 'true', ...SMTP, PUBLIC_ORIGIN: 'http://192.168.1.50:6168' }).magicLinks).toBe(true);
  });

  it('requires an https domain for passkeys', () => {
    expect(() => loadAuthConfig({ AUTH_PASSKEYS: 'true' })).toThrow(/PUBLIC_ORIGIN/);
    expect(() => loadAuthConfig({ AUTH_PASSKEYS: 'true', PUBLIC_ORIGIN: 'http://gigboy.lan' })).toThrow(/https/);
    expect(() => loadAuthConfig({ AUTH_PASSKEYS: 'true', PUBLIC_ORIGIN: 'https://192.168.1.50' })).toThrow(/domain name/);
    expect(loadAuthConfig({ AUTH_PASSKEYS: 'true', PUBLIC_ORIGIN: 'http://localhost:6168' }).passkeys).toBe(true);
  });

  it('rejects passkeys as the only method — nobody could add their first one', () => {
    expect(() => loadAuthConfig({ AUTH_PASSWORDS: 'false', AUTH_PASSKEYS: 'true', ...HTTPS })).toThrow(/also needs/);
  });

  it('checks the admin bootstrap variables against the methods', () => {
    expect(() => loadAuthConfig({ ADMIN_EMAIL: 'a@example.com' })).toThrow(/both be set/);
    const passwordless = { AUTH_PASSWORDS: 'false', AUTH_MAGIC_LINKS: 'true', ...SMTP, ...HTTPS };
    expect(loadAuthConfig({ ...passwordless, ADMIN_EMAIL: 'a@example.com' }).passwords).toBe(false);
    expect(() => loadAuthConfig({ ...passwordless, ADMIN_EMAIL: 'a@example.com', ADMIN_PASSWORD: 'secret123' })).toThrow(/ADMIN_PASSWORD is set/);
  });
});
