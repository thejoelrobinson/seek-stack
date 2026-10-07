# Secure desktop connections

Seek Desktop 0.4 uses a mutually authenticated WebRTC data channel between a paired computer and
the user's trusted Seek host (Work plugin 0.7 or later). The agent runs on that host and reads the observations there.
Internet providers, Wi-Fi observers, HTTPS inspection proxies and TURN relays do not receive
plaintext desktop observations or control messages from this transport.

This does not make the Seek endpoint blind. Its operating system, agent and configured model
provider can access the data they process. Existing task history is not encrypted by this change.
Protecting data from a hosted Seek operator would require running the agent and its model on a
user-controlled endpoint. Compromised endpoints, stolen private identity keys and malicious
application updates remain outside this network transport's protection.

## Pairing and connection authentication

Both endpoints generate persistent Ed25519 identities with Node's cryptographic API. The normal
flow uses a one-use invitation created in the trusted Seek UI, with a ten-minute lifetime, a
256-bit secret and Seek's public identity. The companion proves possession with HMAC-SHA256
over its identity, fresh nonce and enrollment options, without transmitting the invitation secret.
Seek consumes the invitation before asynchronous I/O and signs its complete enrollment response,
including the new device credential, with the pinned host identity. The companion verifies this
signature before replacing saved keys or connecting. Possession of an invitation authorizes
enrollment: keep it private and use a trusted Seek UI. Compromised web code is an endpoint threat.

The manual eight-character pairing-code flow remains available for older clients. Both screens
show a 64-bit security code derived from the device ID and public keys; entering the matching code
on both endpoints is mandatory for that flow. A mismatch means remove the pairing and investigate;
do not accept a replacement key automatically. Verified identities remain viewable in an optional
Device identity disclosure after invitation pairing.

Every connection signs its complete SDP, including the DTLS certificate fingerprint, protocol,
device ID, session ID, two fresh 128-bit challenges, timestamp and ICE configuration. Endpoints
reject wrong keys, modified fingerprints, other devices, replayed session challenges and expired
descriptions before applying them. The pinned `werift` 0.25.0 transport also checks the actual
remote certificate against the negotiated fingerprint before establishing DTLS/SCTP.

The WebSocket contains connection metadata: SDP, candidate IP addresses, ephemeral relay
credentials, public certificate fingerprints, identities and timestamps. A relay can observe
connection timing, addresses and traffic size, or prevent a connection. It cannot substitute
an authenticated endpoint or read the encrypted application channel. The signaling credential
alone cannot authenticate a WebRTC peer.

No application payload is accepted from the WebSocket. There is no automatic downgrade to it.
The local API retains task-bound grants, session epochs, short leases, one-use observations,
input ownership checks and the local Stop shortcut. Disconnects stop control; reconnecting needs
a new grant. Incomplete or oversized messages and excessive queueing fail closed.

## Connections across networks

The default uses local candidates and contacts no third-party STUN server. For devices behind
different NATs, configure an owner-operated TURN service or Cloudflare Realtime TURN once in
**Seek › Settings › Computers › Connections**. Shared secrets/API tokens are protected with the
Windows host's DPAPI and never returned in status or sent to companions. Cloudflare credentials
are minted per connection with a one-hour lifetime. Ordinary HTTPS reverse proxies and Cloudflare tunnels do
not carry WebRTC UDP; TURN is the fallback when direct ICE cannot connect.

Install the updated Seek plugin with its production dependencies (`npm ci --omit=dev
--ignore-scripts` in the installed plugin directory, using its matching lockfile). A file-only
deployment from an older version must also stage these dependencies before enabling pairings.
The repository's plugin installer now does this automatically. Never restart a live host with
only the source files and no `werift` runtime package.

| Variable | Purpose |
| --- | --- |
| `SEEK_DESKTOP_ICE_SERVERS` | JSON array of WebRTC ICE server objects, for example `[{"urls":"stun:relay.example.com:3478"}]`. |
| `SEEK_DESKTOP_TURN_URL` | Comma-separated TURN URLs, for example `turn:relay.example.com:3478,turns:relay.example.com:5349?transport=tcp`. |
| `SEEK_DESKTOP_TURN_SECRET` | Private shared REST authentication secret, at least 32 characters; match the coturn server's `static-auth-secret`. Never commit it or place it in the model prompt. |
| `SEEK_DESKTOP_RELAY_ONLY` | Set to `1` to require TURN; connections fail if no relay is available. |

The environment variables below remain supported when no saved relay configuration exists.
Seek generates expiring, per-device TURN credentials and sends them in authenticated signaling.
The TURN server forwards encrypted packets and holds no desktop decryption key. Use a valid TLS
certificate for `turns:` and enable authenticated allocations, quotas and a restricted relay port
range. Open the TURN listener and relay UDP range on the relay host; do not expose its management
interface or enable loopback/private-network peer access in production.

`npm run smoke:turn` creates a disposable localhost-only coturn 4.18.0-r0 Docker fixture,
requires exclusively relay ICE candidates, checks DTLS fingerprints and exchanges synthetic
content. Its loopback permission and TLS-free listener are test-fixture settings only. It removes
the fixture afterward and does not configure a public relay.

## Validation and rollout

`npm test` includes real peer and companion-to-Seek round trips, fragmented Unicode observations,
fingerprint authentication, altered/expired/wrong-device descriptions, signaling injection,
verification gating, bounded buffering and removal/revocation. The full integration inspects
signaling and transmitted transport packets for a synthetic private marker. Packaged smoke tests
exercise the real DTLS/SCTP stack inside Electron as well as the existing app and native reader.

Windows packaging is verified locally. macOS/Linux packages and native permissions remain for
the existing platform CI and installation on the actual target devices. This is an unsigned
developer preview, not an independently audited security product. Human screen streaming and
phone takeover remain separate unfinished features; this change encrypts the existing agent
desktop observation/control path.

Protocol references: [IETF WebRTC security architecture](https://www.rfc-editor.org/rfc/rfc8827.html),
[werift implementation](https://github.com/shinyoshiaki/werift-webrtc),
[Electron protected storage](https://www.electronjs.org/docs/latest/api/safe-storage), and
[coturn configuration](https://github.com/coturn/coturn/blob/master/README.turnserver).
