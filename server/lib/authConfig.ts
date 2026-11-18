/**
 * Which sign-in methods this instance offers, read from the environment:
 *
 *   AUTH_PASSWORDS   (default true)  — email + password
 *   AUTH_MAGIC_LINKS (default false) — a one-time link + 6-digit code by email; needs SMTP
 *   AUTH_PASSKEYS    (default false) — WebAuthn passkeys; needs an https PUBLIC_ORIGIN
 *
 * Invalid combinations throw, so the server (and the admin bootstrap) refuse to start rather
 * than come up in a state where nobody can sign in.
 */
export interface AuthConfig {
  passwords: boolean;
  magicLinks: boolean;
  passkeys: boolean;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
}

export interface PasskeyConfig {
  /** The relying party ID: PUBLIC_ORIGIN's hostname. */
  rpID: string;
  /** PUBLIC_ORIGIN, the only origin a passkey ceremony is accepted from. */
  origin: string;
}

type Env = Record<string, string | undefined>;

function readFlag(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be "true" or "false" (got "${env[name]}").`);
}

export function readPublicOrigin(env: Env = process.env): string | null {
  const raw = env.PUBLIC_ORIGIN?.trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

export function readSmtpConfig(env: Env = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  const from = env.SMTP_FROM?.trim();
  if (!host || !from) return null;
  const port = Number(env.SMTP_PORT?.trim() || 587);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`SMTP_PORT must be a port number (got "${env.SMTP_PORT}").`);
  }
  return {
    host,
    port,
    // Port 465 is implicit TLS; anything else upgrades with STARTTLS when the server offers it.
    secure: readFlag(env, 'SMTP_SECURE', port === 465),
    user: env.SMTP_USER?.trim() || null,
    password: env.SMTP_PASSWORD || null,
    from,
  };
}

export function readPasskeyConfig(env: Env = process.env): PasskeyConfig | null {
  const origin = readPublicOrigin(env);
  if (!origin) return null;
  const url = new URL(origin);
  return { rpID: url.hostname, origin: url.origin };
}

/** Parses and validates the sign-in configuration. Throws with an operator-facing message. */
export function loadAuthConfig(env: Env = process.env): AuthConfig {
  const config: AuthConfig = {
    passwords: readFlag(env, 'AUTH_PASSWORDS', true),
    magicLinks: readFlag(env, 'AUTH_MAGIC_LINKS', false),
    passkeys: readFlag(env, 'AUTH_PASSKEYS', false),
  };

  if (!config.passwords && !config.magicLinks && !config.passkeys) {
    throw new Error('At least one of AUTH_PASSWORDS, AUTH_MAGIC_LINKS and AUTH_PASSKEYS must be enabled.');
  }

  const publicOrigin = readPublicOrigin(env);
  if (publicOrigin) {
    let url: URL;
    try {
      url = new URL(publicOrigin);
    } catch {
      throw new Error(`PUBLIC_ORIGIN must be a URL like https://gigboy.example.com (got "${publicOrigin}").`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`PUBLIC_ORIGIN must start with https:// or http:// (got "${publicOrigin}").`);
    }
  }

  if (config.magicLinks) {
    if (!readSmtpConfig(env)) {
      throw new Error('AUTH_MAGIC_LINKS=true needs SMTP_HOST and SMTP_FROM to be set, so sign-in emails can be sent.');
    }
    // The link in the email must never be built from the request's Host header: a forged
    // header would send the victim a link to the attacker's server, carrying their token.
    if (!publicOrigin) {
      throw new Error('AUTH_MAGIC_LINKS=true needs PUBLIC_ORIGIN to be set, so sign-in links point at this server.');
    }
  }

  if (config.passkeys) {
    if (!publicOrigin) {
      throw new Error('AUTH_PASSKEYS=true needs PUBLIC_ORIGIN to be set (e.g. https://gigboy.example.com).');
    }
    const url = new URL(publicOrigin);
    // Browsers only offer WebAuthn in a secure context: https, or plain http on localhost.
    const isLocalhost = url.hostname === 'localhost' || url.hostname.endsWith('.localhost');
    if (url.protocol !== 'https:' && !isLocalhost) {
      throw new Error('AUTH_PASSKEYS=true needs an https:// PUBLIC_ORIGIN — browsers only allow passkeys over HTTPS.');
    }
    if (/^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) {
      throw new Error('AUTH_PASSKEYS=true needs PUBLIC_ORIGIN to use a domain name — passkeys cannot be tied to an IP address.');
    }
    // A passkey has to be created while signed in some other way, and a lost device needs a
    // way back in.
    if (!config.passwords && !config.magicLinks) {
      throw new Error('AUTH_PASSKEYS=true also needs AUTH_PASSWORDS or AUTH_MAGIC_LINKS, so users can sign in to add their first passkey and recover a lost one.');
    }
  }

  const adminEmail = Boolean(env.ADMIN_EMAIL);
  const adminPassword = Boolean(env.ADMIN_PASSWORD);
  if (config.passwords) {
    if (adminEmail !== adminPassword) {
      throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must both be set, or both left unset.');
    }
  } else if (adminPassword) {
    throw new Error('ADMIN_PASSWORD is set but AUTH_PASSWORDS=false. Remove ADMIN_PASSWORD — the admin signs in with an emailed link.');
  }

  return config;
}

let cached: AuthConfig | null = null;

/** The validated config for this process, loaded on first use. */
export function getAuthConfig(): AuthConfig {
  cached ??= loadAuthConfig();
  return cached;
}
