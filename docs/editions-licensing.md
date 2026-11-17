# Drivebay editions and licensing

Status: built on branch `feature/editions-licensing` (from `de8e8aa`). Not released. Prices and the payment provider are **proposals for Aaron**, nothing public says a price yet.

## 1. Editions (proposed)

Free stays fully usable for linking your own machines. Paid editions add remote access and more sharing.

| | Free | Pro | Elite | Enterprise |
|---|---|---|---|---|
| Link all your own machines, Tailscale and LAN, WebDAV mounts, phone as a drive | yes | yes | yes | yes |
| "I opened this port myself" direct internet option | yes | yes | yes | yes |
| Remote access from a trusted device (time-limited IP forward, read-only or read-write, auto-off timer) | - | 15 min, 1 h, 4 h | 15 min, 1 h, 4 h, 24 h | 15 min to 24 h |
| Public access over your own port forward | - | yes | yes | yes |
| Folders shared with other people | 3 | 25 | unlimited | unlimited |
| Devices per license | n/a | 3 | 10 | per contract |
| Self-hosted cloud API, offline license file | - | - | - | yes |
| Support | community | email | priority email | agreement |
| Updates included | all free releases | 12 months | 24 months | term / N months |

"Keep what you have": a one-time license never expires. After the updates window, versions released later run as Free, and the version you had keeps working fully.

Not built yet: HTTPS on the remote-access port forward. You said on 16 Nov this should be a Pro feature. Today the forward is plain HTTP and the app says so. When TLS lands, add it to the Pro row and gate it with `entitlements.can("remote_access")` next to the existing check in `linked-http.mjs`.

### Suggested prices (proposal, not published anywhere)

Research, checked 17 Nov 2026:

| Product | Price |
|---|---|
| Tailscale | Personal free (6 users). Standard $8 per user per month, Premium $18. |
| Resilio Sync | Home free. Historical Home Pro $59.99 one-time, Family Pro $99.99 one-time (5 people). Business from about $35 per month. Some reports say Resilio has since folded Pro features into the free download. |
| Nextcloud Enterprise | Standard 71.29 EUR per user per year, Premium 104.99, Ultimate 204.75, minimum 100 users. |
| Syncthing and its clients | Free. The only paid piece is Mobius Sync on iOS, $4.99 one-time. |

| Edition | Proposed price | Notes |
|---|---|---|
| Free | $0 | |
| Pro | **$49 one-time** (alt: $4/month or $39/year) | Close to Resilio Home Pro. 3 devices, 12 months of updates. |
| Elite | **$99 one-time** (alt: $8/month or $79/year) | Close to Resilio Family. 10 devices, 24 months of updates, 24 h sessions, unlimited shared folders. |
| Enterprise | **$40 per machine per year, 25-machine minimum**, or $120 per machine one-time with 12 months of updates | Far below Nextcloud and Tailscale per seat, because there is no hosted service. Quote by hand. |

One-time pricing fits how the licenses work (perpetual plus an updates window, no billing system needed). Subscriptions work too: set a term in the SKU and the license expires.

Launch codes: `promo` codes (below) cover friends, testers and press without a payment.

## 2. How a license works

- **Long key** `DBAY-` plus Crockford base32 of (payload plus 64-byte Ed25519 signature), in groups of 5. The payload holds edition, seats, flags, issued day, expiry day (0 = perpetual), updates-until day (0xFFFF = lifetime), an 8-byte license id and an optional label (max 48 bytes). Signed with the domain string `DRIVEBAY-LICENSE-v1`. Anyone can check it offline with the public key built into the app. Nobody can make one without the private key.
- **Short purchase code** `DBAY-XXXX-XXXX-XXXX-XXXX` (15 random characters plus a check character). The server stores only `sha256("drivebay-code-v1:" + code)`. The first activation mints the long key. A purchase code covers one license, activated on up to `seats` devices. A promo code can create up to `maxLicenses` licenses, one per redeeming device.
- **Activation receipt** `DBAR1.…` ties a license to one device for 30 days, refreshed about weekly in the background. Without a valid receipt a normal key shows "needs online" and the app runs as Free. An **offline** key (Enterprise) needs no activation and no network.
- **Seats** count devices that checked in during the last 120 days. When full, the error lists the devices. Deactivate in the app, or release one with the CLI.
- **Revocation** is online: the next refresh returns revoked, the app marks the key and drops to Free. A network error never takes a license away.
- Test vectors for all three implementations (PHP, JS, Kotlin): `docs/license-test-vectors.json`. These use a test key, not the production key.

Files: PHP `server/cloud-api/lib/license_*.php`, JS `app/src/lib/license/`, Kotlin `android/app/src/main/java/com/lordstryfe/drivebay/license/`.

### Key custody

- The private key lives only on the server at `~/drivebay-data/license/signing.key` (mode 0600, outside the web root, in `.gitignore`).
- **Back it up yourself**, offline (password manager, encrypted USB). If it is lost, no new license can be minted for the existing public key and every app would need a new build with a new public key. `public-keys.mjs`, `LicenseConfig.PUBLIC_KEYS_HEX` and `license_gate.php` each take a list of keys, so a second key can be added alongside the first for a smooth rotation.
- The admin token (SHA-256 of it is in `license/config.json`) is in `/workspace/drivebay-editions/secrets/license-admin-token` on the box. Move it to your password manager and delete the box copy when you are ready.

## 3. Live endpoints

Base `https://mesaandmoon.com/drivebay/`

| URL | What |
|---|---|
| `api/license.php?action=plans` | Public edition summary (no prices until you add them to config) |
| `api/license.php?action=publickey` | Public key |
| `api/license.php` POST `activate`, `refresh`, `deactivate`, `status` | The app calls these |
| `api/webhook.php?provider=stripe\|lemonsqueezy\|fake` | Payment webhook. A provider is on only when its webhook secret is in config. Otherwise 503. |
| `api/license-admin.php` | Admin API for the CLI. Needs the admin token. |
| `upgrade/` | Unlisted, `noindex` upgrade page. Checkout buttons are disabled placeholders. |

Existing `machines.php`, `vault.php` and `health.php` were not changed. Backup taken first: `/workspace/drivebay-editions/backups/live-drivebay-20261117-1420/`.

## 4. Minting and managing codes (admin CLI)

```
node server/cloud-api/tools/license-admin.mjs --help
```

The CLI reads the token from `DRIVEBAY_ADMIN_TOKEN`, `--token-file <path>`, or `~/.drivebay-admin-token`. It talks to the live admin API. The signing key never leaves the server.

```
# one purchase code: Pro, 3 devices, perpetual, 12 months of updates
license-admin.mjs code --edition pro --seats 3 --perpetual --updates-months 12
# Elite, subscription style: ends after 12 months
license-admin.mjs code --edition elite --seats 10 --months 12
# promo: 50 people can each redeem one Pro license free for 12 months, code valid 30 days
license-admin.mjs promo --edition pro --seats 3 --months 12 --max 50 --code-expires-days 30 --note "launch"
# a long key directly (no code step)
license-admin.mjs mint --edition elite --seats 10 --perpetual --lifetime-updates --label "Aaron"
# Enterprise offline file
license-admin.mjs enterprise-file --org "Acme Corp" --seats 250 --perpetual --updates-months 12 --out acme.dbaylicense
license-admin.mjs enterprise-file --org "Acme Corp" --seats 250 --months 12 --out acme.dbaylicense   # yearly term
# manage
license-admin.mjs list [licenses|codes|orders|activations]
license-admin.mjs seats <licenseId>
license-admin.mjs release <licenseId> <machineRef>
license-admin.mjs revoke <licenseId> "reason"      # and: unrevoke
license-admin.mjs outbox                          # emails the webhook queued
```

Your own lifetime Elite code is at `/workspace/drivebay-editions/secrets/aaron-owner-code.txt` (box only). Redeem it on your devices from Settings → Edition and license.

Enterprise renewals: a yearly term is a new file with a later expiry. A one-time license that includes N months of updates is renewed by minting a new file with a later `--updates-months`. There is no automatic renewal flow yet.

## 5. Purchase flow

1. Aaron creates the products at the chosen provider (see decisions). Each gets a SKU. Add the SKUs to `license/config.json` on the server:
   ```json
   "products": {
     "pro":   {"name": "Pro",   "edition": "pro",   "seats": 3,  "termMonths": 0, "updatesMonths": 12},
     "elite": {"name": "Elite", "edition": "elite", "seats": 10, "termMonths": 0, "updatesMonths": 24}
   },
   "providers": {"stripe": {"webhook_secret": "whsec_…"}},
   "checkout": {"provider": "stripe", "enabled": false, "links": {"pro": "https://…", "elite": "https://…"}},
   "prices": {"pro": "$49", "elite": "$99"}
   ```
   `termMonths: 0` means perpetual. The SKU comes from the payment's `metadata.sku` (Stripe) or `custom_data.sku` (Lemon Squeezy), or from a mapping of the payment link or variant to a SKU.
2. Point the provider's webhook at `https://mesaandmoon.com/drivebay/api/webhook.php?provider=stripe` (events `checkout.session.completed`, `charge.refunded`) or `provider=lemonsqueezy` (`order_created`, `order_refunded`).
3. Set `"enabled": true` under `checkout`. The upgrade page then shows real buy buttons.
4. After a paid order the webhook mints a purchase code and writes the email to the **outbox**. Idempotent per provider event and per order, so retries never mint twice. A refund revokes the redeemed license and disables unused codes.

**No email is sent today.** `webhook.php` only queues. Choose how buyers get the code: the provider's own receipt email (put the code in the confirmation page or a license-key field), or wire a sender into `drivebay_handle_order_event`'s `mailer`. Until then read `license-admin.mjs outbox`.

Test it without any payment provider, using the built-in fake provider (needs `providers.fake.webhook_secret` in config, remove it afterwards): `php server/cloud-api/tests/license_test.php` covers it, and `installer/license-server.e2e.test.mjs` does it against a live `php -S`.

## 6. In-app gating

| Where | Free | Pro / Elite |
|---|---|---|
| Desktop Settings → Edition and license | enter code, refresh, deactivate this machine, see edition, seats, renewal, updates | same |
| Remote access on (this computer or another) | friendly upgrade note, the Turn on button is disabled, API returns `402 {upgrade:true,feature,requiredEdition}` | on. 24 h option is Elite and Enterprise only. |
| Public access | blocked at start and at save | on |
| Shared folders | 3 (existing ones are kept) | 25 / unlimited |
| Android Edition and license dialog | same as desktop | |
| Android remote access | upgrade dialog from the phone's own edition, and from a 402 from the computer | on |
| Tailscale, LAN, own-machine linking, direct internet | never gated | |

Where it runs: the computer that opens the door enforces (`linked-http.mjs` returns 402 and treats remote access as off when not entitled). The controlling device also pre-checks so either side can show the upgrade prompt.

## 7. Enterprise self-host

Kit in `server/enterprise/` (see its README for the short admin guide): `install.sh`, `docker-compose.yml`, `Dockerfile` (PHP 8.3 + Apache), `license-gate.php` as `auto_prepend_file`.

- The customer runs the Drivebay cloud API (machine directory and encrypted vault records) on their own server. Drivebay desktop and phone apps point at it through `cloudApi` in `mesa-firebase.json`.
- Sign-in still uses Firebase Authentication, so the customer needs **their own Firebase project** (free plan, Authentication only). Replacing this with their own OIDC or LDAP login is not built.
- The license gate checks the `.dbaylicense` file offline (no phone-home): signature, Enterprise edition, term, updates window versus the image build time, and machine count versus seats.
- It never locks people out. If the file is missing, expired, or the seats are full, existing machines keep working. Only registering a **new** machine is refused (HTTP 402). `GET /api/enterprise-license.php` shows state and seats in use.
- The hosted-only parts (webhook, admin API, public license endpoint) are removed from the image.
- Not tested here: `docker build` (no Docker on the build box). The gate itself is tested with `php -S` and `auto_prepend_file` (`server/cloud-api/tests/gate_test.php`).

## 8. Honest limits

- This is a source-available app. Client-side checks are a deterrent for honest customers, not DRM. Someone who edits the app can turn the checks off. The signed key, receipts and the host-side checks stop casual sharing and keep seats countable.
- Remote access is enforced on the computer that opens the door, but that computer is the user's own machine, so the same limit applies.
- Offline keys cannot be revoked until they expire. Use terms for Enterprise customers you may need to cut off.
- Receipts bind to a hashed device id. If a device reinstalls with a new id it uses a new seat until the old one is released or ages out after 120 days.

## 9. Privacy and licence notes

- Activation sends the code or key, a SHA-256 of the machine id, the device name, platform and app version to `mesaandmoon.com` (the web server sees the IP like any request, and the license database keeps only a hash of it for rate limiting). It never sends file names or contents. The privacy page `privacy.html` does not mention this yet. Suggested paragraph: *"If you activate a paid edition, Drivebay sends your license code, a one-way hash of a random device id, the device's name and (as with any web request) your IP address to Mesa and Moon so we can count devices and prevent sharing. We keep it for as long as the license is active. We never receive your file names or file contents."*
- Order emails and payment details sit with the payment provider. The webhook stores order id, email, SKU and the minted code (hashed).
- Check the Community License wording before launch: paid editions must be consistent with what it says about commercial use and redistribution.

## 10. Tests

| Suite | Command | Result |
|---|---|---|
| JS codec, store, gating | `node --test installer/license.test.mjs installer/license-gating.test.mjs` | pass |
| PHP license server | `php server/cloud-api/tests/license_test.php` (80 checks) | pass |
| Enterprise gate (unit and php -S) | `php server/cloud-api/tests/gate_test.php` (25 checks) | pass |
| JS client and admin CLI against PHP over HTTP | `node --test installer/license-server.e2e.test.mjs` | pass |
| Kotlin (codec, manager, policy) | `cd android && ./gradlew :app:testDebugUnitTest --tests 'com.lordstryfe.drivebay.license.*'` | 15 pass |

When PHP has no ext-sodium, set `SODIUM_COMPAT_AUTOLOAD` to paragonie/sodium_compat's `autoload.php`. Tests cover key generation and verification, tampered and wrong-signer keys, expiry, updates window, seat limits (seats_full, deactivate frees a seat), receipts bound to a machine, revocation, and webhook idempotency (replay, double order, refund).

## 11. Decisions for Aaron

1. Prices and one-time vs subscription (section 1).
2. Payment provider: Stripe Payment Links (cheapest, you handle tax) or Lemon Squeezy (merchant of record, handles VAT and sales tax, higher fee). Creating either account is yours to do. Nothing was signed up for.
3. Seat counts (Pro 3, Elite 10) and the updates window (12 and 24 months).
4. How buyers receive the code (provider email, or a mailer you choose).
5. Enterprise: Firebase-per-customer is acceptable for now?
6. Back up `signing.key` offline, and move the admin token off the box.
7. Add the privacy paragraph and check the Community License wording.
