# Self-hosting Gigboy

Gigboy is self-hosted only: run your own copy on your own infrastructure with Docker Compose.
There is no hosted SaaS version, and no third-party account (Firebase, Stripe, Cloudflare) is
involved anywhere in the stack — it's just this app, a Postgres database, and a volume for
uploaded files.

> This build covers: sign-in by password, emailed link/code and/or passkey (see
> [Sign-in methods](#sign-in-methods)) with full profile management (email/username/avatar/
> full name/password changes, account deletion); personal and band-owned songs, songlists, and
> setlists; bands with invite-link membership; band technical riders/stage plots with public
> share links; song PDF attachments (20MB cap); song hand notes, recordings and stems; band logo
> upload; OG-tag social previews; per-resource collaboration invites; trash/soft-delete with
> 30-day retention; and band press kits (rich text, images, video/presave links, public share
> links) — all with full feature access (no plan gating).

## Prerequisites

- Docker and Docker Compose
- No other dependencies — Postgres runs as a container

## Setup

1. Copy the example env file:

   ```sh
   cp .env.example .env
   ```

2. Generate a session secret and set it in `.env`:

   ```sh
   openssl rand -hex 32
   ```

3. Pick a Postgres password and set it as `POSTGRES_PASSWORD` in `.env`, then make
   sure `DATABASE_URL` uses the same password (the example file's `DATABASE_URL` already
   points at the `postgres` service host used by Compose — just swap in your password).

4. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` — see [Admin account and invites](#admin-account-and-invites)
   below. Set both, or leave both unset if an admin already exists from a previous run. (Going
   passwordless? Set only `ADMIN_EMAIL` — see [Sign-in methods](#sign-in-methods).)

5. Bring the stack up:

   ```sh
   docker compose pull
   docker compose up -d
   ```

   This pulls the prebuilt `app` image from GHCR instead of compiling it on your device. On a
   NAS or other low-power hardware, building the image in place (`--build`) runs a full
   Node/Vite/TypeScript build inside the container and can spike CPU/RAM enough to make the
   Docker engine or container manager UI become unresponsive — pulling the prebuilt image
   avoids that entirely. Only use `--build` if you're developing locally on a machine with
   plenty of RAM, or have modified the source and want to build your own image.

   The GHCR package (`ghcr.io/blindpassasjer/gigboy`) is public, so `docker compose pull`
   works with no login on the NAS.

   Docker Compose auto-loads `.env` from the project directory — no `--env-file` flag needed,
   whether you're using the CLI or a GUI container tool (Synology/QNAP/UGREEN-style Docker
   apps, Portainer, etc.).

   The `app` container waits for Postgres to report healthy, then runs pending database
   migrations and bootstraps the admin account (if configured) automatically on every start
   (via `docker-entrypoint.sh`) before starting the server — so `docker compose up` is always
   enough, including on first run and after upgrades that add new migrations.

6. Open `http://localhost:6168` (or whatever `PORT` you set) and log in as the admin account
   you configured in step 4. There is no open self-registration — every other account is
   created by an admin generating an invite link (see below).

   **Accessing over plain HTTP (no reverse proxy / no TLS)** — the default and common case for
   a home NAS or LAN deployment (e.g. `http://192.168.1.50:6168`) — session cookies are set
   *without* the `Secure` flag by default (`COOKIE_SECURE=false`), since a `Secure` cookie is
   silently dropped by the browser over plain HTTP: login would appear to succeed but every
   API call afterward would 401 with "Authentication required." Only set `COOKIE_SECURE=true`
   in `.env` once you've put a reverse proxy in front of the container that terminates
   real HTTPS.

   **When you do put a reverse proxy in front**, also set two more variables in `.env`:
   - `PUBLIC_ORIGIN` — the canonical public URL of the instance, e.g.
     `https://gigboy.example.com` (scheme + host, no trailing slash). This is used to build
     invite links, press-kit share URLs and social-preview tags. (Calendar subscription links
     don't need it: they're built from the address the page is opened at.) Without it those URLs are
     derived from the incoming `Host` header, which a client can forge.
   - `TRUST_PROXY` — set to `1` for a single proxy hop (or a subnet/list per Express's
     "trust proxy" docs). The auth rate limiter keys on the client IP; behind a proxy with
     this left at its default (`false`) every request looks like it comes from the proxy, so
     one abuser trips the limit for everyone. Leave it `false` when the container is exposed
     directly — setting `1` without a real proxy lets clients spoof their IP.

## Admin account and invites

Gigboy has no open self-registration. The first account is bootstrapped from environment
variables, and every account after that is created from an invite link: a server invite from an
admin, or a band invite link opened for sign-up, where an admin has allowed that for the band (see below).

**Bootstrapping the first admin** — set both `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`
before running `docker compose up` for the first time. On startup, `docker-entrypoint.sh` runs
pending migrations and then a bootstrap step that creates the admin account if it doesn't
already exist (matched by email) and leaves it untouched if it does — safe to leave the
variables set across restarts. Setting only one of the two is a startup error. Leave both
unset once the admin account exists from a previous run.

**Inviting new users** — log in as an admin and open the shield icon in the top bar
(`/admin/invites`) to generate invite links: optionally pin an invite to one email address,
then create the link. Every invite creates a regular member — there's no admin choice at
invite time, since band ownership is unconditional (whoever creates a band owns it) and has
nothing to do with site-wide admin access. Copy the link (it's copied to your clipboard
automatically) and share it with the person you're inviting — they open it at
`/invite/<token>` to choose a username and create their account (with a password, unless emailed
sign-in is on — see below). Links expire after
7 days and can be revoked from the same page before they're used.

**Band invite links** — any band editor can create a link under the band's members page. They
choose how many days it lasts (1–365, default 7) and, where allowed, whether people without an
account may sign up through it: such a link creates a regular member account and joins it to the
band in one step, without a separate server invite. Who may create sign-up links is set per band
by an admin on the Bands tab (`/admin/bands`), under **Allow new member sign-up**: *No* (the
default), *Owner* or *Editors* (owner and editors). Tightening it also stops sign-up through
links already shared by people it no longer allows. Anyone holding such a link can
create an account until it expires. New accounts remember who invited them (shown on the Users
tab), and band members remember whose link they joined through (shown in the band's member list).

**Promoting/demoting admins** — on the Users tab (`/admin/users`), each user (other than
yourself) has a "Make admin" / "Remove admin" button to grant or revoke site-wide admin access
(inviting users, managing storage quotas, deleting accounts). You can't change your own role
this way, and the last remaining admin can't be demoted — ask another admin, or promote someone
else first.

**Managing storage quotas** — the "Users" tab next to Invites (`/admin/users`) lists every
account with the storage used across bands they own, and lets an admin set (or reset to the
5GB default) each user's storage quota. Uploads (attachments, recordings, stems, press kit
images, band logos) that would push a band's total usage past the uploading user's quota are rejected
server-side.

**Who can create bands** — by default every account can create bands (and owns the ones it
creates). Set `ANYONE_CAN_CREATE_BANDS=false` to let only admins create bands; everyone else then
joins bands through invite links. Changing it doesn't affect bands that already exist.

**Transferring band ownership** — a band's owner can hand it to another member in the band's
settings, under **Transfer ownership**. Admins can do the same for any band they're a member of —
useful when an owner leaves, or when an admin sets bands up for others while
`ANYONE_CAN_CREATE_BANDS=false`. The new owner must already be a member; a viewer is made an
editor. The band's storage then counts against the new owner's quota.

## Sign-in methods

Three ways to sign in, each switched on or off in `.env`. Any combination works as long as people
can always get in; the server refuses to start otherwise, and says what's missing.

| Variable | Default | What it needs |
| --- | --- | --- |
| `AUTH_PASSWORDS` | `true` | Nothing — works over plain HTTP on a LAN. |
| `AUTH_MAGIC_LINKS` | `false` | An SMTP server (`SMTP_HOST`, `SMTP_FROM`, usually `SMTP_USER`/`SMTP_PASSWORD`) and `PUBLIC_ORIGIN`. |
| `AUTH_PASSKEYS` | `false` | `PUBLIC_ORIGIN` on `https://` with a domain name, plus passwords or magic links. |

**Emailed sign-in (magic links)** — people enter their email and get a one-time **link and 6-digit
code**, valid for 15 minutes. It doubles as "forgot my password" and "lost my passkey". If someone
has lost access to their inbox too, an admin can change their email address on the Users tab
(`/admin/users`). The code exists for **installed apps**: on iOS, a home-screen app doesn't share
cookies with Safari, so a link tapped in Mail signs in Safari, not the app. Typing the code in the
app works everywhere. `PUBLIC_ORIGIN` is required so the link in the email can't be pointed
elsewhere by a forged `Host` header.

**Passkeys** — sign in with a fingerprint, face or screen lock. People add passkeys in their
profile, or right after accepting an invite. Browsers only allow passkeys on HTTPS (or
`localhost`), and a passkey is bound to the domain in `PUBLIC_ORIGIN`. **Changing that domain later
makes every existing passkey stop working** (people then sign in another way and add a new one).
Plain-HTTP LAN installs can't use passkeys.

**Fully passwordless** — `AUTH_PASSWORDS=false`, `AUTH_MAGIC_LINKS=true`, and optionally
`AUTH_PASSKEYS=true`. Set only `ADMIN_EMAIL` (not `ADMIN_PASSWORD`); the admin signs in with an
emailed code. Existing accounts keep their stored passwords, but they're no longer accepted. Turn
passwords back on and they work again.

Mixing is fine. With all three on, the login screen offers a password field, an "email me a code"
fallback and a passkey button. Accounts created without a password can set one from their profile
whenever passwords are on.

## Ultimate Guitar search

The song form can search Ultimate Guitar and import a song from a link. Ultimate Guitar can't be
read from the browser, so **your server** makes these requests. To keep that to a trickle, answers
are cached (searches for a day, songs for 30 days) and the server sends Ultimate Guitar at most
`ULTIMATE_GUITAR_MAX_REQUESTS_PER_HOUR` requests an hour (default 60), after which users are asked
to try again later.

Set `ULTIMATE_GUITAR_SEARCH=false` to turn search and link import off, for example if you'd rather
your server never contacts Ultimate Guitar. Importing a file shared from the Ultimate Guitar app
(`lyrics_tmp`) never contacts it and works either way.

If Ultimate Guitar blocks your server (most likely on a data-centre IP), users see a message saying
so, and the file import and pasting chords into the song form still work.

## Stems

A song can carry **stems**: separate, time-aligned audio files for vocals, drums, bass and so on,
which the band plays together in the song's **Stems** tool. Each stem can be muted, soloed and
given its own volume, and an A–B loop helps when practising a passage.

Gigboy doesn't separate songs itself. Use any source separator, for example
[StemDeck](https://github.com/stemdeckapp/stemdeck), Demucs or a DAW, export the stems, and as a band editor choose
**Import stems…** in the song. You can pick a ZIP of stems or several MP3 or WAV files (up to 50MB
per stem, all at the same sample rate). The stem name comes from the end of each file name
(`My_Song_vocals.mp3` becomes `vocals`), and importing a stem with the same name again replaces it.
Export all stems of a song together, so they have exactly the same length.

The player keeps the stems sample-locked: it decodes a few seconds of each stem at a time in a
worker and mixes them in one AudioWorklet, so even long songs with many stems fit in a phone's
memory. Stem files are kept in the browser's Cache Storage after the first play, so a song plays
without a network connection once it has been opened. Stems count toward the band's storage quota.

MP3 decoding uses [mpg123-decoder](https://github.com/eshaz/wasm-audio-decoders), a WebAssembly
build of mpg123 (LGPL-2.1), loaded as a separate script.

## Data persistence

Postgres data lives in `./data/postgres`, and uploaded song attachments live in
`./data/attachments` (mounted at `/data/attachments` in the `app` container) — both are
bind-mounted host folders next to your `docker-compose.yml`, not named Docker volumes. Both
survive `docker compose down` and container restarts/rebuilds; they're only removed if you
delete the `data/` folder yourself.

Note: Postgres runs as the `PUID`/`PGID` set in `.env` (defaults to `999:999`, the built-in
`postgres` user), and `./data/postgres` needs to be owned by that same UID/GID on the host —
Compose creates the folder on first run, but as `root`, so Postgres will fail to start with a
permissions error unless you fix ownership first:

```sh
mkdir -p data/postgres data/attachments
chown -R 999:999 data/postgres   # or your custom PUID:PGID if you changed it in .env
```

If you'd rather Postgres's files be owned by your own host user (so you can browse/back them up
without `sudo`), set `PUID`/`PGID` in `.env` to your `id -u`/`id -g` and `chown` accordingly
before the first `docker compose up`.

## Backing up

Back up both folders — the database and the attachment files are separate stores. The
bundled script does both in one go (run it from the folder that holds `docker-compose.yml`):

```sh
scripts/backup.sh backup            # writes backups/gigboy-<timestamp>/{db.sql.gz,attachments.tar.gz}
scripts/backup.sh restore backups/gigboy-20261119-030000   # replaces the current data
```

Backups are staged and only moved into place once both parts succeed, so a failed run never
leaves a half-written backup behind. To run it nightly and keep the last 14:

```sh
0 3 * * *  cd /path/to/gigboy && KEEP=14 scripts/backup.sh backup
```

Copy the `backups/` folder off the machine too — a backup on the same disk doesn't survive
the disk. Restoring asks for confirmation (set `YES=1` to skip it) and the app should be
restarted afterwards (`docker compose restart app`).

Prefer doing it by hand? These are the equivalent commands:

```sh
docker compose exec postgres pg_dump -U gigboy gigboy > backup.sql
tar czf attachments-backup.tar.gz -C data/attachments .

# restore
cat backup.sql | docker compose exec -T postgres psql -U gigboy gigboy
tar xzf attachments-backup.tar.gz -C data/attachments
```

If you put a reverse proxy in front of the container (not part of the default Compose setup,
which exposes `PORT` directly), make sure its own request body size limit allows uploads up
to 50MB (recordings and stems go up to 50MB each) — Express itself already accepts them, e.g.
nginx `client_max_body_size 50m;`.

The setlist "now playing" sync uses Server-Sent Events on
`/api/bands/*/setlists/*/session/stream`. If your proxy buffers responses (nginx does by
default), followers' screens will lag or not update — disable buffering for that path, e.g.
nginx `proxy_buffering off;` (Gigboy already sends `X-Accel-Buffering: no`, which nginx
honours) and make sure the proxy read timeout is longer than the 25s keepalive.

## Updating

```sh
git pull
docker compose pull
docker compose up -d
```

Migrations run automatically on startup, so new schema changes are applied before the app
serves traffic.

## Development (without Docker)

Run a local Postgres instance yourself, then:

```sh
export DATABASE_URL=postgres://gigboy:yourpassword@localhost:5432/gigboy
export SESSION_SECRET=$(openssl rand -hex 32)
npm run db:migrate
npm run server:dev
```

This starts the API only, listening on `PORT` (default 6168). Run `npm run dev` (Vite) separately
for the frontend during development — it serves on its own port (5173 by default) and calls the
API via relative `/api/...` requests, so use a reverse proxy (or open the Vite dev server through
one) if you need both running against a single origin; otherwise `npm run build` + `npm run
server:dev` serves the built frontend and API together from the same origin/port.
