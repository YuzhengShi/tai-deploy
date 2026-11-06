# Notifications that reach a closed page

Until now a message TAi sent on its own (the weekday patrol's "last chance" note, a reminder a student asked for with `schedule_task`) was seen
only if the student happened to open the tab, and a reply that took 20 to 35 seconds was missed whenever the student looked away. This adds, for a
student who turns it on: a **Settings** dialog on the page, **Web Push** (a notification from the browser's own push service, no third-party
service and no new dependency), and the rules that decide when one is sent. **Built locally; not deployed; no real push service has been
spoken to** (see "Not verified").

Everything is off until the owner turns it on: `TAI_NOTIFY=1` and a VAPID key (below) for push, `TAI_NOTIFY_EMAIL=1` and the mail server's settings ("E-mail", below) for e-mail. Without them the page shows no such switch.

## The rules (`src/notify/core.ts`, pure and tested on a fake clock)

A message is pushed when TAi writes to a student and **the student's page is not open and in front**. Then:

1. **A page in front is never pushed to.** Each poll of the page says whether its tab is in front (`GET api/poll?...&c=<page id>&v=1|0`), and so does
   a short request when the tab changes (`visibilitychange`, sent with `keepalive` so it leaves as the tab closes). A page counts as open while one of
   its requests is held and for **5 s** after the last was answered (a live page asks again at once); a held poll that was dropped (tab closed) counts as
   gone at once, so a reply ten seconds after closing the tab is still pushed. A page that dies without a word (a laptop lid closed, a phone off the
   network: no disconnect ever reaches the server) is found out only when the server's own 25 s timer answers its held poll into the dead connection,
   so it can look open for about **30 s** after its last request, and a reply in that window is not pushed (worked out from the 25 s hold and the 5 s,
   checked on a fake clock; never seen with a real dead connection). A tab that is open but behind another is pushed to (the tab title's count stays as it was).
2. **TAi's own messages** (a message that comes when no message of the student's is waiting for its answer) are pushed at most **3 a day** by
   the student's own calendar, and **not between 22:00 and 08:00 in the student's time zone**: such a message is held and **one** generic push is sent
   when quiet hours end, unless the student has had the page in front since (then there is nothing to say) or the day's limit is used. A restart in
   between loses what was held. Not telling a student at night is the point, so a reminder set for 23:00 reaches them at 08:00 (it is in the chat
   when they open it); change the hours or the limit with the settings below.
3. **The reply to a student's message** is pushed when the student waited **at least 20 seconds**, at most once per message of theirs (a long answer
   comes in several messages), urgently, and is **never held**: quiet hours and the daily limit are for TAi's own messages only.
4. **The same message is never pushed twice** (by the number the web channel gave it, and, for TAi's own messages, by its words within ten minutes).
5. A student with nothing to be told by (no browser subscribed) costs one small file read and no count.

*Reply or own message* is decided by `Episodes`: a message of the student's (typed, a tap on an option, a voice note, the emoji TAi answers) opens an
episode when `src/portal` hands it to TAi; the typing indicator going off closes it five seconds later (the IPC watcher polls once a second, so a
message of the same answer may still be on its way); 20 minutes of silence closes it. Whatever TAi sends outside an episode is its own. The default
time zone of a student who has not told us theirs is `America/Los_Angeles` (the app's "Pacific"). The page sends the device's zone after sign-in when
it differs from the stored one. **Trap seen:** British Columbia has stopped changing its clocks; in this Node's time zone data `America/Vancouver`
is UTC-7 all year while Los Angeles is UTC-8 in winter, so a student in Vancouver has quiet hours that start an hour "earlier" than the course's.

## What is sent, and what each party can see

The notification says **TAi** / **TAi has a new message**, whatever the message was. The payload is `{"v":1,"t":"TAi","b":"TAi has a new message","tag":"tai-message","ts":...}`,
padded to 256 bytes before encryption (every message is the same size) and encrypted for each browser (RFC 8291 `aes128gcm`, a new salt and sender key
each time). `TAI_PUSH_PREVIEW=1` puts the first ~80 characters of a message of TAi's in the body (never in the one sent at the end of quiet hours);
it is off because a lock screen shows it to whoever holds the phone. TTL is 30 minutes for a reply (`Urgency: high`) and a day for TAi's own message
(`normal`).

| Party | Sees | Cannot see |
| --- | --- | --- |
| Google, Mozilla, Apple or Microsoft (the browser's push service) | that a message was sent to this browser's address at this time, from this host, its size (always the same), the VAPID claim (`aud` = their own origin, `sub` = the page's https address) | the words (end-to-end encrypted to the browser), who the student is (an address is a random token), what the message was about |
| The lock screen / notification centre | "TAi has a new message" (with a preview: the start of the message) | |
| Another person on a shared computer | a notification that TAi wrote | the conversation: the page asks for sign-in |

A subscription (address and two keys) is a capability to wake one device, and is kept in the student's `<folder>.prefs.json`; no call returns it (the
page is given a 16-digit hash of each, to recognise its own). It is useless without the VAPID private key, which is in a mode-600 file outside the
backups (the backups do contain the subscriptions, because they contain `store/portal`). Logs name an address only by its hash and never hold a key,
a payload or a student's words. **One browser belongs to one student**: subscribing takes the address off every other student's file, and signing
out turns this browser's notifications off for the student who signs out.

## The address a student posts (the SSRF door)

`POST api/push/subscribe` takes an address from a signed-in student and the server later connects to it, so it is accepted only if (`src/notify/webpush.ts`,
`validateEndpoint`, tested with every bad form below, and checked again at every send from the stored string):

* it is `https:`, on the default port, with no user name or password, and its host (as the URL parser normalised it) is one of
  `PUSH_SERVICE_HOSTS`: **`fcm.googleapis.com`** and **`web.push.apple.com`** (exact: that host and no other; `api.push.apple.com` is Apple's gateway
  for native apps, not web push), **`.push.services.mozilla.com`** and **`.notify.windows.com`** (a leading dot: any host below it, not the name itself);
* an IP literal (any spelling), a name without a dot (`localhost`, an internal service), a trailing dot, an encoded dot, userinfo tricks
  (`fcm.googleapis.com@evil.example`) and look-alikes (`fcm.googleapis.com.evil.example`, `evilfcm.googleapis.com`, `evil-push.services.mozilla.com`) all fail;
* the name is resolved through a guard that refuses loopback, private, link-local (cloud metadata), CGNAT, multicast and documentation addresses, and the IPv6
  forms that carry an IPv4 address through a gateway (NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, the IPv4-compatible `::/96`); on an IPv6-only host with DNS64 a push
  service that has no IPv6 address of its own would be refused as well (not checked for the four services);
* the request follows **no redirect**, times out after 10 s, reads at most 4 KB of the answer, carries `TTL`, and a payload over 3,000 bytes is refused;
* the keys are checked: `p256dh` is 65 bytes and a point of P-256 (not just 65 bytes), `auth` is 16 bytes, both canonical unpadded base64url; five browsers a
  student at most (a sixth takes the place of the oldest: a student who clears their browser gets a new address each time); 20 subscribes in ten minutes.

A subscription is removed at once on 404 or 410 (or when it fails these checks), and after three 400, 401 or 403 in a row (a key that was changed
since the subscription was made makes every message a 403); a timeout, 429, a 5xx or a redirect leaves it for the next message.

## Settings

| Setting (orchestrator environment) | Default | What it does |
| --- | --- | --- |
| `TAI_NOTIFY` | off | `1`: notifications may be sent (needs the key and a subject). Otherwise the page draws no switch, and `GET api/push/key` is a 404. |
| `TAI_VAPID_KEY_FILE` | unset | A file holding the VAPID private key (the 32-byte scalar as unpadded base64url, or a PEM), mode 600. `tai_live.sh notify vapid` makes it and sets this. |
| `VAPID_PRIVATE_KEY` | unset | The same key in the environment (it wins over the file; for development; the host's `set` command refuses names that end in KEY). Never logged. |
| `VAPID_PUBLIC_KEY` | derived | Optional: the public half. The server works it out from the private key; a value that disagrees keeps push off (one warning in the log). |
| `TAI_PUSH_SUBJECT` | the page's own https address | The VAPID `sub` claim, which the push services see: an `https:` URL or `mailto:`. Never defaulted to anyone's e-mail address. |
| `TAI_PUSH_PREVIEW` | off | `1`: the first ~80 characters in the notification. |
| `TAI_PUSH_DAILY_MAX` | `3` | Pushes of TAi's own messages per student per local day; `0`: none (replies are still pushed). |
| `TAI_PUSH_QUIET_START`, `TAI_PUSH_QUIET_END` | `22:00`, `08:00` | Quiet hours in the student's time zone, for TAi's own messages; equal values: none. |
| `TAI_PUSH_REPLY_AFTER_SECONDS` | `20` | A reply is pushed only if the student waited this long. |
| `TAI_PUSH_DEFAULT_TZ` | `America/Los_Angeles` | The zone of a student who has not told us theirs. |
| `TAI_NOTIFY_EMAIL` | off | `1`: e-mail to a student who turned it on in Settings. Also needs the five below, and the page's https address. |
| `TAI_SMTP_HOST`, `TAI_SMTP_PORT` | unset, `587` | The mail server. `465`: TLS from the first byte. Any other port: STARTTLS is required, and a server that does not offer it is not used. |
| `TAI_SMTP_USER`, `TAI_NOTIFY_FROM` | unset | The login (none: no login) and the address mail is sent from. |
| `SMTP_PASSWORD` (`.env`) | unset | The login's password. Typed hidden with `tai_credentials.sh smtp`, kept in `credentials.env` and so in TAi's `.env`, read with `readEnvFile`; never in the process environment, never given to a container, never logged. |
| `TAI_EMAIL_DAILY_MAX` | `1` | E-mails per student per local day; `0`: none. |
| `TAI_EMAIL_AFTER_MINUTES` | `60` | A message that nobody has looked at this long is written about. |

Turning it on later changes nothing for a student until they turn it on in Settings. **Replacing the VAPID key ends every subscription** (the browser
holds the key its subscription was made for): `notify vapid --force` keeps the old one as `vapid.key.previous`, and each student turns it on again.

## Operator commands (`deploy/cs6650/tai_live.sh`, run from the PC; tested only against a scratch directory)

* `tai_live.sh notify status`: whether it is on (`TAI_NOTIFY`), whether a key is there (never shown), whether e-mail is on and configured (yes or no, and the *names* of what is missing), and counts: browsers, students, preference files.
* `tai_live.sh notify vapid [--force]`: makes the key pair **on the host** when there is none (private key to the file `TAI_VAPID_KEY_FILE` names, or
  `~/tai-live/vapid.key`, mode 600), sets `TAI_VAPID_KEY_FILE`, prints only the public key. An existing key is never replaced without `--force`.
* `tai_live.sh set TAI_NOTIFY=1`, then `restart`; `tai_live.sh logs 30` then shows `notify: push is on` (or the one reason it is not).

## Verifying it live (the owner; none of this has been done)

1. Deploy (new files under `src/` and `portal/web/`; nothing under `container/`, so no image rebuild). `tai_live.sh notify vapid`; `set TAI_NOTIFY=1`; `restart`.
2. `notify status` says on, key present, 0 browsers. The log has `notify: push is on` with the quiet hours and the subject.
3. On a phone: iPhone (iOS 16.4 or later): Safari, Share, **Add to Home Screen**, open TAi from that icon, sign in. Account menu, **Settings**, **Notify me in this browser**,
   allow. `notify status` says 1 browser of 1 student.
4. A reply push: send TAi something that takes over 20 s (a Canvas or Piazza question), lock the phone at once. After the reply: **TAi / TAi has a new message**; a tap opens the page.
5. An own-message push: ask for "a reminder in 2 minutes to check notifications" with the phone locked (outside 22:00 to 08:00 in your zone, or set both quiet settings to `00:00` for the test).
6. With the page in front, neither shows a notification. Switch the switch off: `notify status` says 0. Sign out: the same.
7. If nothing arrives: `logs | grep notify` shows `a push did not go through` with the status the push service gave (403 with a key that was replaced; 410 for a browser that was reset).

## Not verified

No push has been sent to Google, Mozilla, Apple or Microsoft, so these hold only on paper: that each accepts the `vapid t=..., k=...` header with this token, the
`Urgency` header and a padded 358-byte body (the encryption itself is checked against RFC 8291's own example, and read back by a separately written receiver);
that the service worker shows and focuses correctly in a real browser, on iOS and with Chrome's `userVisibleOnly` rule, and that `renotify` makes a push that replaces an unread one sound again (the test checks the option, not Chromium); that a page that died is found out in about 30 s (derived and run on a fake clock, never with a real dead connection); that the page's `visible` signal
is as timely on a phone as in the tests; how `Episodes` meets the real lag between TAi's typing indicator and the IPC watcher (it is tested on a fake clock
with the five seconds of grace the code assumes); the time zone data of the host's Node (22.19) for zones that changed recently (Vancouver). **E-mail: no real SMTP server and no real mailbox has been spoken to.** The client is tested against a stand-in server that speaks the protocol, with TLS (a certificate made in the test): the dialogue, STARTTLS, AUTH PLAIN and LOGIN, dot-stuffing, refusals, retries and timeouts. Not covered: a provider's own behaviour (Gmail or Office 365 may want an app password, may refuse AUTH PLAIN or add limits of their own), delivery to an inbox and not to spam (SPF, DKIM and DMARC of the From domain are the owner's to set), and how the mail looks in a mail program.

## E-mail

For a student who turned it on (Settings, **Email me when I miss a message**, drawn only when `features.email` is true), TAi may send **one short plain-text e-mail** about messages it wrote on its own that nobody has looked at. It is the second channel of the notifier (`src/notify/email-channel.ts`, the client `smtp.ts`), and it is **off unless `TAI_NOTIFY_EMAIL=1` and everything it needs is there**: the host, the from address, the page's https address (the link), the list of students, and, when a login is set, `SMTP_PASSWORD`. Whatever is missing is said once in the log (by name) and the page is told `email: false`.

**The rules** (`decideEmail`, `src/notify/core.ts`: pure, and tested on a fake clock):

1. TAi's own messages only; never a reply. The channel is not given what the push rules decide: it hears of every such message, whether or not a push was sent for it, and has a clock of its own (`mode: 'own'` of `NotifyChannel`).
2. A message is **seen** once a request of a page of the student's, made after TAi wrote it, said the tab was in front (`Presence.lastVisibleAt`: the polls say whether the tab is in front), or such a request is held now. An answer to a poll does not count by itself: it may have gone into a dead connection, and a message of TAi's is just what wakes a held poll, so the page's next request (a live page makes it at once) is the proof that it arrived. A page that is merely open behind other tabs has not been looked at, so it does not count (stricter than "the page polled"). Nothing is sent about a message that was seen.
3. Only when what is left has been unseen **an hour** (`TAI_EMAIL_AFTER_MINUTES`), counted from the oldest of it; one e-mail stands for all of it.
4. **At most one a student a local day** (`TAI_EMAIL_DAILY_MAX`), by the student's own calendar. A mail that could not be sent does not use up the day. When the failure may pass (the connection failed, a timeout, a 4xx answer, after the client's own second try), what it was about is held again and tried an hour later: three tries at most, none scheduled later than three hours after the first, then forgotten. A refusal that will not pass (a 5xx answer, a refused login, a certificate) is not repeated.
5. Not for a message a **push was delivered** for. A push that failed, or none because of quiet hours or the limit, leaves the message to e-mail.
6. No quiet hours (a mail does not buzz), no mail about a message more than a day old, and what was waiting is forgotten at a restart. The daily counts, of e-mails and of pushes, live in memory too: a restart resets them, so a student can get one more of each that day.

**To whom.** Only the address the student signed in with, read from the allowlist by their folder (`recipientOf` in `src/portal/start.ts`). No request, no preference file, no word of a message is ever an address: a stray `address` key in a preferences file is ignored (tested). The student sees the address in the dialog.

**What it says, and why so little.** Subject **TAi has a message for you**; a body of a few plain ASCII lines: that TAi has written and the student has not opened it, the page's own address, and one line on how to stop (turn the switch off in Settings). No message text, no name, no figure, no tracking (no pixel, no personal or unsubscribe link). **Why:** a push is encrypted to one browser; an e-mail crosses mail providers in the clear, is copied into other people's backups, and stays in a mailbox for years. So it says only that there is something, and where to read it.

**The client** (`src/notify/smtp.ts`, node:net and node:tls, no dependency): EHLO, STARTTLS where needed, AUTH PLAIN or LOGIN, MAIL FROM, RCPT TO, DATA with dot-stuffing and a size cap (100 KB), QUIT; 10 s to connect and 20 s for each answer; one connection per message; one more try after a failure that may pass (a connection error, a timeout, a 4xx) and none after one that will not (a 5xx, a refused login, a certificate). One answer of the server is at most 100 lines and 64 KB (and no more than a few answers nobody asked for are kept): a server that sends more, such as one that never ends an answer with a last line, is a failed send at once and not repeated; the last line of an answer may be a bare code (`250`). **Never in the clear:** port 465 is TLS from the first byte; on any other port STARTTLS is required, a server that does not offer it (or whose offer was cut out on the way) gets no login and no mail, and a failed handshake, an untrusted certificate or a wrong name ends the attempt: there is no downgrade and no option that turns verification off. **Header injection:** the recipient and the sender must be plain addresses, a header value (the subject too) may hold no CR, LF or other control character and nothing outside printable ASCII, the body is plain ASCII: all checked before any connection (tested with CR LF Bcc, a second RCPT command, two recipients, NUL, tab, line separators). Errors are logged without the password and with the address as a hash; a server's own words are cleaned of addresses and secrets first.

**Setting it up** (nothing here has been run against the live host):

1. `tai_live.sh set TAI_SMTP_HOST=smtp.example.org TAI_SMTP_PORT=587 TAI_SMTP_USER=tai@example.org TAI_NOTIFY_FROM=tai@example.org` (not secrets).
2. `bash deploy/cs6650/tai_credentials.sh smtp`: type the password in your own terminal (hidden; never in chat or on a command line). It is checked without sending any mail (connect, STARTTLS with certificates checked, login, quit) and only then stored.
3. `tai_live.sh set TAI_NOTIFY_EMAIL=1`, `tai_live.sh restart`, `tai_live.sh notify status` (it says `email: on ...; configured`), `tai_live.sh logs 30` (`notify: e-mail is on`).
4. Turn it on in Settings as a student; to try it quickly start with `TAI_EMAIL_AFTER_MINUTES=2`, let TAi write to you on its own (a reminder of 1 minute), keep the page in the background or closed, and wait.

## Files

`src/notify/` (`webpush.ts` crypto, address rule and sender; `vapid.ts`; `core.ts` the rules; `presence.ts`; `notifier.ts`; `push-channel.ts`; `email-channel.ts`; `smtp.ts`; `config.ts`; `start.ts`; `testing/test-cert.ts` a certificate for the tests),
`src/portal/prefs.ts` and `prefs-routes.ts`, `portal/web/` (`settings.js`, `settings.css`, `sw.js`, `manifest.webmanifest`, the icons made by `portal/qa/make_icons.mjs`),
and one-line hooks in `src/portal/server.ts` (the content policy's `manifest-src`, the file types, the poll's presence call) and `src/portal/start.ts`.
