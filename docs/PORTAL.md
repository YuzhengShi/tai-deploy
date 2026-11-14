# The student page

TAi's web front for students: `src/portal/` (the server, in the orchestrator's process) and `portal/web/` (the page: plain HTML, CSS and
JavaScript, no build step). One page, one conversation per student, Google sign-in, an allowlist that decides who may come in and which
Canvas user and GitHub account TAi reads for them.

```
browser ──https──> traefik (the world's, /tai) ──> tai-edge (socat) ──unix socket──> orchestrator (the page + the web channel)
                                                                                         │
                       127.0.0.1:8199 (the web channel's own API: no authentication,     └──> one agent container per active student
                       for the host and the tests, never proxied)                             (pi, the gateway to Cerebras, Canvas/GitHub/Piazza tools)
```

## What it does and does not do

* The page is laid out like a messaging app (the layout of Muse / Meta AI's chat window; its own mark and name): a slim rail on the left (the
  conversation, search, **Activity**, the link to the classroom, and the sun/moon at its foot), the
  agent's face and name at the top (the face pulses while TAi works), a **Chats** pill at the top left, at the top right the round
  **voice-call** button (only when calls are on) and the account pill, TAi's replies in rounded bubbles on the left, the student's in blue
  bubbles on the right, centred time stamps (a new day, or half an hour of quiet), and a pill-shaped message box at the bottom: a **+** at
  its left (attach a file; only when files are on) and, at its right end, one round button that is a **microphone** while the box is empty
  (no words, nothing in the file tray; only when voice notes are on) and the **send arrow** once there is something to send. A new
  student's conversation starts with a greeting and a card of four places to start (the first sends at once, the others leave a sentence in
  the box to finish); where voice calls are on there is a fifth, **Talk it through out loud**, which starts a call (see "Voice calls").
* **The pill above the message box** has three states. While TAi's words have arrived that the reader, scrolled up from the bottom, has not
  seen: a blue **"N new messages"** pill with a chevron (announced politely when the count changes), and a click takes the reader to the
  latest. When everything has been seen but the reader is still more than about 80 px above the bottom: a plain round **arrow**, no words
  (its label is "Scroll to the latest message"), which glides to the bottom. At the bottom: nothing. A message is *seen* once its bottom edge
  has been in view, so scrolling down to it by hand clears it as well; what counts is only what TAi says (text, a picture)
  and arrives while the reader is away: reactions, activity cards, time stamps, the typing dots, the words of a voice call, the student's own messages (from this tab or
  another) and whatever a reload brings never count.
* A signed-in student sees their own conversation (kept per student under `store/portal/<folder>.jsonl`, so a reload or a second tab shows
  the same thing), sends messages, and sees TAi's replies when the run ends: three dots in a bubble while it works, with the seconds once it
  takes a while. Replies are shown as Markdown (headings, lists, code blocks with a copy button, tables, safe links) built from DOM nodes:
  nothing a model writes is ever parsed as HTML.
* Every control does something: hovering a reply shows **add a reaction** (a smiley, see below), **copy** (the reply's own text) and **quote**
  (into the message box); the **+** in the message box opens the file picker (no menu: it is "attach a file"); **Chats** (and the search
  icon in the rail) opens a drawer with the conversation's days (the day's first message, how many messages there are, how many spoken lines of a call and how many activities, each by itself; a click takes you there) and
  a search over what the page holds (the last 200 messages, the words of voice notes and of calls, the names of the files messages carried, and the title and
  line of an activity card), an **Activity** entry (see "Activity") and a
  link to the CS6650 classroom; the sun/moon (at the rail's foot; a phone has no rail, so the account menu's theme entry is the way there) switches light and dark. The account menu is
  who is signed in, the theme, **Settings** (only when the server has something to set) and sign out, and nothing else. Before sign-in the same window is the sign-in: a greeting bubble, a card with
  Google's button and the message box switched off.
* **Only what the server switches on is drawn.** `GET /api/me` says which extras this deployment has (`features`: `files`, `pictures`,
  `voiceNotes`, `voiceCalls`, `activity` (the Activity list's entries), `choices` (options to tap, see "Options and quick checks"), with
  `maxUploadBytes` and the `accept` list of extensions); the page
  draws those controls and no others. (`features` also says `memory` and `admin`, and the server still has what they stand for; the page uses
  neither: it has no "What TAi remembers" and no second, teaching-team chat.) With all of them off it is exactly the text chat, apart from the
  Activity entries, which have no switch (the dev server runs that page too, and the e2e checks it).
* **TAi's pictures and emoji.** A diagram TAi draws (`kind:'image'`) is one message: the picture (from `api/media/<id>`, in a frame whose size
  is set before it loads, so a picture arriving never moves the conversation or drags a reader who scrolled back) with its caption (Markdown)
  under it; a click enlarges it (Escape or a click closes it; its alt text is the caption's first sentence). An emoji reaction (`kind:'react'`)
  is a badge on the lower left corner of the student's message it names, with a short pop when it arrives live; a later one on the same
  message replaces it. It is not a message: no bubble, time stamp, pill count, drawer entry or search hit. An emoji on the student's newest
  message also stops the dots (it can be TAi's whole answer; while TAi still works the server's typing flag keeps them). A voice call's
  account is not a bubble at all: it is a compact card (see "Activity"; older histories hold it as `kind:'voice'`, drawn the same way).
* **The student's emoji on TAi's messages.** Every text and picture message of TAi's has a small **smiley** button beside it (next to copy
  and quote: shown on hover and on keyboard focus; on a touch screen, which cannot hover, it is simply there, and copy and quote are not).
  A **long press** on the bubble opens the same thing on a touch screen (a finger that moves is a scroll; the browser's own menu and text
  selection are held back only for the press that opened it). It opens a small row of six, thumbs up, heart, laughing, surprised, sad and
  thanks, next to the bubble (above it, or below when it is near the top): the arrow keys move along them, Enter picks, Escape or Tab close
  it and give the focus back, a click anywhere else closes it. Picking sets the student's emoji (one for a message: a new one replaces the
  old); picking the one that is there takes it back, and so does the badge. It shows as a badge on the bubble's **lower right** corner (the
  mirror of TAi's on the student's; a button that opens the six again; its words for a screen reader are "You reacted" and the emoji) with a
  short pop. The page shows it at once and `POST api/react` keeps it: changes go to the server one after another, a failed one is taken back
  with a plain message, and the lines the poll brings for a message whose change is still on its way do not override the page. It is not a
  message: TAi hears of it with the student's **next** message, as up to three lines ahead of it, for TAi only (see "The calls and what the
  history keeps"). When the student types nothing for a few seconds after their last emoji (`TAI_PORTAL_REACT_REPLY_MS`, 3000 by default, 0
  for never; each emoji starts the wait again, so three taps are one answer) the server hands TAi those lines as a message of its own and TAi
  answers it: not when the student types first (the lines go with their words), takes the emoji back, or is in a voice call. There is none
  on the greeting, the places-to-start card, or an activity card.
* **There are no thumbs.** The thumb up and thumb down beside TAi's replies (and on a call's card), and the menu of reasons under the thumb
  down, are gone from the page, with everything that only they used. `POST api/feedback` stays on the server, but no page calls it any more
  (see "The calls and what the history keeps"). Older histories may still hold `kind:'feedback'` lines; the page ignores them silently: no
  bubble, no count on the pill, no search hit.
* **Files.** "Attach a file" (the **+**, which opens the picker itself), files dragged onto the window or pasted into the box: each is checked against the size limit and
  the accepted kinds first, goes up at once (`POST api/upload`, the bytes as they are) with a spinner and a progress bar on its chip above the
  box, and goes with the next message (`files: [ids]`, at most five). Removing the chip of a file that is up and was not sent gives the upload
  back (`POST api/upload/release` with `{"id": "<24 hex>"}`, fire and forget: the server frees its place among the ten uploads that may wait
  and deletes its file); signing out gives back what is still in the tray; a failed or a sent file is never released. A refused file says why
  in plain words (never a status code) and can only be removed. Send is on with words or a file that is up, and off while one is still going
  up. Sent files show as chips (pictures as
  thumbnails that enlarge) in the student's bubble. TAi gets the start of a text or code file with the message, reads PDF and Office files with
  its tools, and reads the TEXT of a picture (a screenshot of a terminal or an error) with `read_image_text`: the upload also keeps a copy of the
  picture in the student's `uploads/` folder for it (80 files / 40 MB at most, so screenshots leave room for code), and the message names its path.
  It still cannot see charts, diagrams or layout, and says so, unless `TAI_VISION=1` is set: TAi is then told it can also LOOK at the picture with `look_at_image`
  (a vision model; **the picture goes to z.ai**, see docs/VISION.md). A voice call is told it can look at a stored picture with `look_at_image` where a call may (`TAI_VISION=1` and not `TAI_CALL_VISION=0`, docs/RUN_CARDS.md), and "you cannot see pictures" otherwise.
  A `.tgz` or `.tar.gz` archive of a project is accepted too (the name AND the first bytes must be gzip's; a plain `.gz` or a renamed file is refused): it is kept in `uploads/` like a document and named to the agent
  with the tool that runs it, `run_go` with `upload: <name>` (a call: `run_code`). See docs/OCR.md and docs/RUN_CARDS.md.
* **Voice notes** (`notes.js` for the bubble, `voice.js` for the recorder). Sent as audio, as a voice message is: the microphone button at the
  right end of the empty message box starts recording (`MediaRecorder`: Opus in WebM at 32 kbit/s, or Opus in Ogg or MP4 where the browser cannot (Safari); the browser asks for the
  microphone the first time, and a refused one is explained in plain words). The **recording bar** takes the box's place: a trash button on
  the left (Escape cancels too, wherever the focus is), a pulsing dot, the time (with the longest, 3:00), a live level (a bar for each
  moment, the newest on the right) and **send** on the right. Three minutes is the longest: recording then stops by itself and waits, with
  "Longest note reached. Send it, or delete it." (nothing is sent that was not asked for); a press of the button that said nothing (under
  0.6 s) is not sent. The microphone and the level meter's audio context are let go when the note is sent, deleted, stopped at the limit,
  or the page is left. Send puts the box back and **the note is in the conversation at once** as the student's own message, playable from
  the copy the page holds: a play/pause button, a waveform that is the seek bar (click or drag; Home/End and the arrow keys from the
  keyboard; it is a `slider` with its position said in words), its length, and the words below as small text with a **Show text / Hide
  text** toggle (shown at first when up to 140 characters). The waveform is the loudness the page measured while recording, kept with the
  entry (`peaks`); a note without one gets a fixed pattern. Only one note plays at a time. Under the bubble: "Sending…" while it goes,
  "No words could be made out." when there are none, and, when the upload fails, "Not sent." with the reason and **Try again** (the same id:
  a note whose answer was lost is not sent twice). TAi answers in text like to any message. While a voice **call** is on the microphone button
  is not there: the call's own buttons are in its place (see "Voice calls"), so there is no voice note during a call.
* **Voice calls** (`voice.js`, `voice-worklet.js`, `speech.js`; the protocol is docs/VOICE.md's "Browser protocol"). A call is **a mode of the
  conversation**, not a window beside it: the words of both sides are bubbles in the same thread as the typed chat, and they stay in it after
  the call. The round headset button at the top right, just before the account pill, starts one; a small chevron fused to it offers **Talk it
  through** (below). While a call is on, at the bottom, above the message box, an **orb** is the call: a sphere lit from the upper left, 140 px
  across (110 px on a phone), **blue sky** for a plain call, warm for TAi as the interviewer, teal into blue for "Talk it through" (the colour
  follows the server's `ready.mode` and `mode` messages). It shows the state to the eye and, in `#call-state` (a polite status), to screen
  readers: *connecting* (dim, a slow pulse), *listening* (a slow breathing; the sphere swells with the student's own voice, `--mic`), *thinking*
  (a swirl runs over it), *looking something up* (the same, with a ring around it and "Looking that up…"), *speaking* (rings go out from it
  and it swells with TAi's voice as it is **played**, read from an analyser on the output, `--out`, not as it arrives), *muted* (grey, with a
  slash across it, "You are muted") and *reconnecting* (dim again). Under it: the state, the time used and left, and a small badge, "Mock
  interview" or "Talk it through", when the call is one of those. With reduced motion asked for the orb does not move at all (no breathing,
  rings, swirl or swell): the state is its colour and its label. **The message box in a call** says "Type" (what is typed joins the call, and
  shows in the conversation as a typed message), keeps the **+**, and has, where the microphone and the arrow were, the call's two round
  buttons, 44 px across: **mute** (red while muted) and **end** (blue, a cross). The arrow comes back beside them when something is typed
  (so a phone can send it); there is no voice note while a call is on. The conversation keeps its bottom while the orb's room comes and goes,
  and the orb sits below it, so the last line is never under it. When the call ends the orb's room collapses to a one-line note (what the end
  was, and a close button; an ordinary end goes by itself after a few seconds, a problem stays until it is read) and the message box is its
  own again.
  **What is said is in the conversation, from the history.** The words are lines of kind `speech` (see "The calls and what the history
  keeps"), and the page draws a call's words from those lines and from nothing else: the socket's `transcript` events are not drawn (every
  line would appear twice). The student's are right-aligned blue bubbles like typed ones, TAi's are like its replies, each with a small
  waveform (`role="img"`, "Spoken") that tells spoken from typed. They are not messages: no smiley (and `POST api/react` on one is a 404),
  no quote (TAi's can be copied), nothing on the "N new messages" pill or in the tab's title, no part of the drawer's message count (a day
  says, say, "36 spoken lines" apart), and they do not close the options of a quick check; the drawer's search finds them ("You (spoken)",
  "TAi (spoken)"). They are not read out by a screen reader (`aria-live="off"`): the call said them aloud already. A spoken bubble of over
  600 characters is folded, with **…more** (and "less"). The start of a call, a switch of its kind and its end are marker lines, drawn as
  small centred dividers: "Voice call · 3:42 PM" (or "Mock interview", "Talk it through"), "Switched to Mock interview", "Call ended ·
  8 min"; the call's card in the Activity list follows a few seconds after the end marker, as it always did. While the student speaks and the
  line of their words has not come back, a grey **...** bubble stands on the right (`aria-hidden`): it comes up when the server hears them begin
  (`agent_interrupted`, which the server sends for every start of speech), stays while their microphone is audible or the call has their
  words (a `transcript` of theirs), goes at once when the line arrives, when they mute and when the call ends, and by itself four seconds
  after the last sign of speech; it never comes up from the microphone alone, so a noise cannot make it flash.
  **The two kinds of call:** the headset button is a plain call (`start` with `mode: "chat"`). The chevron opens a menu of two, **Voice
  call** and **Talk it through** (TAi listens while the student explains something out loud, then asks one question): `start` with `mode:
  "talk"` (and `topic`, up to 200 characters, when the page has one: the buttons send none; a dropped connection that is taken up again says
  only `resume`). The same call starts from the new student's card ("Talk it through out loud") and can start in the middle of any call
  (TAi's own choice: `{"type":"mode","mode":"listener"}`). The server's `ready.mode` and `mode` messages say `"conversational"`,
  `"interviewer"` or `"listener"`, and the orb follows: its colour and the badge. The menu closes on Escape (the focus goes back to the
  chevron), Tab and a click elsewhere; the button and the chevron step aside together while a call is on. The microphone (echo cancellation,
  noise suppression, gain control, mono) goes through an AudioWorklet that resamples it to 16 kHz PCM16 in 40 ms frames of 1280 bytes; TAi's
  24 kHz speech is resampled once for the whole stream and scheduled back to back after an 80 ms jitter buffer, and everything queued stops
  at once when the student talks over it (`agent_interrupted`). A dropped connection is taken up again for 30 s (`{"type":"start","resume":true}`).
  A refused microphone (with how to allow it), a call already open, no voice time left today and voice not set up are said in plain words.
  The microphone, the AudioContext and the socket are let go when the call ends, when the server closes it, and when the page is left (a
  hidden tab keeps the call; a reload ends it, and the lines stay).
* **The mock interview link** (`/interview/<token>` behind the base path, which `start_mock_interview` returns) opens the page: the token is
  taken out of the address bar and the session history at once (`history.replaceState`), kept in memory only (never in storage, a URL or a
  log), and after sign-in one screen offers the interview; its button starts the call (the microphone and the speaker need a click anyway),
  with the token in the call's `start` message. A link the server refuses says "This link has expired. Ask TAi for a new one."
* **There is one chat, the student's own.** The page has no second, teaching-team chat: no entry for it in the account menu, no second mode of
  the page (no other starters, name under the face, title or draft), nothing that reads `features.admin` or calls `api/admin/*`. The server still
  has the owner's `api/admin/*` and `features.admin` (see "The calls and what the history keeps"), unused by the page.
* **There is no "What TAi remembers".** The sheet that showed the notes TAi kept (each with its Forget button) and where a student stands, in
  words, is gone from the page: the account-menu entry, its dialog, `memory.js`, and the button on a note's activity card. A note TAi keeps
  still gets its activity card, titled "Remembered", as a plain card with nothing to open. `GET api/memory` and `POST api/memory/forget` (and
  `src/portal/memory-view.ts`, which reads COMPETENCY.md in words) stay on the server, unused by the page; the page does not read
  `features.memory` either.
* **Answers that come while the tab is behind another** are counted in the tab's title ("(2) TAi") and cleared when the tab is in front
  again: the nearest thing to a notification a page that is not open can offer (a notification reaches a closed page only for a student who turned them on: "Settings" below and `NOTIFICATIONS.md`). Only what TAi says
  counts: an activity card or an emoji adds nothing.
* **Code is coloured** (`portal/web/highlight.js` and `highlight.css`, called from `markdown.js`; no library, and what TAi wrote is never parsed as HTML). A fenced block's label picks the
  scanner (Go, shell and terminal sessions, Dockerfile, YAML, JSON, Terraform, SQL, Python, JavaScript, TypeScript, Makefile, diff; a file name works too); a block with no label is guessed
  from its first lines (a Go `package`, `FROM`, a Terraform block, `$ ` prompts, JSON that parses), and `text`, `output` and `log` are never coloured. Colour is a `<span class="hl-KIND">` inside
  the block; the block's text, so **Copy**, a selection and the browser's find, is exactly what TAi wrote, and a block over 20,000 characters, 600 lines or 5,000 coloured runs stays plain.
  Each colour is at least 4.5:1 on the block in light and dark (7:1 under `prefers-contrast: more`; the system's own in forced colors). docs/HIGHLIGHT.md has the rules.
* There is no token streaming (the orchestrator hands over a reply when the run is done), no "new chat" (a student has one continuing
  session; the runner retires it after `TAI_MAX_TURNS_PER_SESSION` answers or `TAI_MAX_CONTEXT_TOKENS`, and the competency files carry the
  memory), and no model switch (the model is `base.env`'s, chosen with `tai_live.sh model`): nothing is drawn that does not work.

### Activity

What happened for the student that is worth finding again (a call, a note TAi kept, a reminder it set, a step of progress, a change in the
course) is not something TAi said, so it is not a bubble. It is a **compact card** in the conversation, at the place where it happened, and a
row of the **Activity sheet** (`portal/web/activity.js`). Both are made from history lines of `kind: 'activity'` and from the long call
summaries that older histories hold as `kind: 'voice'`; everything the server sends goes on the page as text.

* **The card.** A rounded tile with the icon of its kind, the **title** (one line), the **line** under it (one line, cut with an ellipsis when
  it is longer than the card) and the time of day at the right. Each kind has a glyph of its own: `voice` (a headset), `talk` (a microphone),
  `interview` (a clipboard), `memory` (a bookmark), `reminder` (a bell), `progress` (a rising line), `course` (a calendar); a kind the page does
  not know is still a card, with a plain tick and the title the line came with. An old `voice` summary is a card titled "Voice call", its
  first sentence (cut to 110 characters) as the line and the whole summary as its detail. A card with a `detail` is a button as a whole:
  closed at first (`aria-expanded`), and a click, Enter or Space opens the detail right there, line breaks kept; one with only its title and
  its line (a note TAi kept, a reminder, a step of progress, most news of the course) is a plain card with no chevron. There is nothing to
  press in an open card: no thumbs (a call's card had two, and a note's had a "What TAi remembers" button; both are gone), no smiley, copy or
  quote (it is a record, not something TAi said), and a long press does nothing. A card is not an unread message: the pill and the tab's
  title never count it, and it starts and stops no typing dots.
* **Where it is.** On a desktop the **rail**, the slim column on the left, has an **Activity** button (its own icon, `aria-label` and title
  "Activity"), after Search and before the link to the classroom. It is drawn only when the server says `features.activity` (like the other
  extras), a real button (Tab, Enter and Space work), looks pressed (`aria-expanded`) while the sheet is open, and the focus goes back to it
  when the sheet closes. The account menu has no entry for it: it is who is signed in, the theme and sign out. On a phone (up to 720 px) the
  rail is not there and the **Chats drawer** is the left panel: its **Activity** entry (under the search box, at every width) opens the same
  sheet, and the focus goes back to the Chats pill. So the list is reachable at every width.
* **The sheet.** A `<dialog>` (`#activity`): Escape, the close button or a click on the dark around it closes it, and the focus goes back to
  where it came from. Its rows are the cards, newest first, under a heading for each day: **Today**, **Yesterday**, then "Mon, Oct 27" (with
  the year when it is not this one), by the reader's own calendar. Thirty are loaded (`GET api/activity?limit=30`), and **Show more** asks for
  the thirty before the oldest shown (`before=<its n>`) for as long as the server says there are more. A row opens in place to its detail with a
  **Show in the conversation** button (the sheet closes and the reader is taken to the card, open and lit). A line that arrives while the
  sheet is open (the poll brings it) joins the top and a screen reader is told ("New: ..."). With nothing yet it says "Nothing yet. Calls,
  notes TAi keeps and reminders show up here."; a sheet that cannot load says so and offers **Try again**; one opened after the session ended
  closes itself and shows the sign-in.
* **The Chats drawer** counts a day's calls and notes apart from its messages ("4 messages, 10 activities"), and its search finds a card by
  its title and its line (labelled "Activity").

### Settings

The account menu's **Settings** entry (between the theme and Sign out; hidden unless `features.prefs` and one of `features.push` or `features.voiceCalls` are true; GET `api/me` also says `features.email`, false until the mail channel exists) opens a `<dialog id="settings">`
(`portal/web/settings.js`, `settings.css`; the pure parts are tested by `settings.test.js`). Escape, the close button or a click on the dark closes it and the focus goes back to
the account button (the menu item is gone by then). Its sections are drawn only where they work:

* **Notifications** (`features.push`): the switch **Notify me in this browser** (a `role="switch"` button). Pressing it asks the browser's permission (only then, as the press's own first act,
  because Safari wants that), subscribes this browser to the server's push (`api/push/key`, `pushManager.subscribe`, `api/push/subscribe`) and says so in plain words; it says when the
  browser cannot show notifications, when permission was refused (and where to allow it), and on an iPhone or iPad in a Safari tab that the page must first be added to the Home Screen.
  The line under it says when TAi notifies (from the server's own limits). The page never subscribes by itself: a subscription is made only by that press, and **signing out** takes
  this browser's off for the student who signs out. `sw.js` (the service worker, scope = the base path) shows the notification and takes a click to the page.
* **Voice speed** (`features.voiceCalls`): Slower, Normal, Faster (0.85, 1, 1.2), kept by `POST api/prefs` and used from the next call. Until the student chooses, a call runs at the deployment's pace (`TAI_VOICE_SPEED`, 1.2 by default), so `GET api/prefs` says `voiceSpeed: null` and `defaults.voiceSpeed` (read the way `src/voice` reads it) and the select shows that option, marked "(default)" (a default that is none of the three is added as "Default (1.1×)"). A stored 1 is a choice, not the default.
* **Email** (`features.email`): the switch **Email me when I miss a message**, with the address it goes to (the one the student signed in with) and when (`limits.emailAfterMinutes`, `emailDailyMax`); it is `POST api/prefs {notify: {email: {enabled}}}`, refused with `email-off` while e-mail is not on. `NOTIFICATIONS.md`, "E-mail".
* **Time zone**: read only, as the device says it. After sign-in the page sends it to the server (`POST api/prefs {tz}`) when the server has another or none. TAi also reads it at each container start to say a deadline on the student's own clock next to the Pacific one when the two differ (`COURSE_TIME.md`).

The page also tells the server whether it is open and in front: every poll carries `c` (an id made for this page load) and `v` (0 when the tab is behind another), and a zero-wait poll
says so again when the tab changes (`createPresence`), so that a message is not pushed to a page that is looking at it. `manifest.webmanifest` and the icons let the page be added to a
home screen; the content policy has `manifest-src 'self'`.

### Options and quick checks

TAi can offer **options** a student taps instead of typing: a **quick check** (a multiple-choice question whose answer TAi has in mind) or
**quick replies** to a question it asks. The server (`src/choices.ts`) takes the block out of TAi's words, so the page gets the question as the
line's own `text` and the options as `choices` on the same line (two to six, each `{label: 'A'..'F', text}`; `quiz: true` for a quick check).
The answer TAi marked, and its note on it, are in no line the page can read: the server grades a tap and says whether it was right. The page
draws options only when `features.choices` is true (`false`: the question as words alone, and the server takes no tap: 404). The pure parts are
`portal/web/choices.js` (tested by `choices.test.js`); `app.js` only wires them.

* **What it looks like.** Inside TAi's bubble, under the question (the bubble gets a little wider for the buttons): a small **Quick check**
  label, for a quick check only, and a group of buttons (`role="group"`, `aria-label="Options"`), one per option: full width, each a letter chip
  and the option's words (plain text, never HTML), wrapping when they are long, so nothing scrolls sideways on a phone. The bubble's own buttons
  stay as they are: the smiley, copy (the question, then the options as lines, "A. ...") and quote. The line is TAi's message in every other
  respect: the "N new messages" pill counts it, the drawer's search finds its question.
* **How they stand.** Worked out from the lines the page holds, as the server works it out. **Open** while nothing has been said since (an emoji,
  a card of the activity list, a thumb line and TAi's own emoji are not something said): all on. **Answered** once a later line of the student's
  has `choice.to` equal to the line's number: the one chosen is highlighted (`choice.index`), the others dimmed, all off. **Closed** when the
  student has typed or spoken something else, or TAi has said or shown more, since: all off and dimmed, nothing highlighted. A message of the
  student's that is on its way (typed, or a voice note that is going up) closes them at once; one that did not go has said nothing, so the
  options come back and close again when it is tried again. A reload shows the same, from the history; nothing is said aloud for what is only
  read back.
* **A tap** (`POST api/choose {to, index}`, see below) puts the student's own message on the page at once, as a sent message is (the letter and
  the option, "B. A term has at most one leader"; the server's line has the same words and the poll's copy is matched to it), turns **all** the
  buttons off with the one tapped marked as pending, and asks. On success the buttons settle: when the server says `correct` (only when TAi
  marked an answer) the chosen one shows a **tick** (right) or a **cross** ("Not quite"), and **a wrong pick never shows which option was
  right** (the others are only dimmed, the right one exactly as the rest); with no `correct` (quick replies, or a quick check TAi did not key)
  the chosen one is only marked as chosen, with no verdict. The tap is a plain message of the student's: TAi answers it like any other.
* **When it does not go through.** The message the page showed is taken away (nothing was recorded) and: a 502 (TAi cannot be reached) or a 429
  puts the options back on, with a plain word of why; a 409 (`closed`: something has been said that the page had not heard yet; `answered`:
  another tab got there first) settles them to closed, with a word, until the poll brings the lines, when they show what the history says; a 401
  is the sign-in.
* **For a screen reader and the keyboard.** Real `<button>`s in a `group` named Options (Tab, Enter and Space work); the one chosen says so
  (`aria-current`); the verdict, "Correct" or "Not quite", is said politely in a status region when it arrives; a button that is off is
  `aria-disabled` and, if it has the focus, stays focusable, so a tap, a reply or a poll that repaints the options never moves the focus: they
  are repainted in place, never rebuilt.

## The calls and what the history keeps

The page talks to its server in a few JSON calls under the base path (every POST carries `X-TAi: 1` and comes from the page's own origin).
**The server has more calls than the page makes.** `api/feedback`, `api/memory`, `api/memory/forget` and the owner's whole `api/admin/*` (the
second, teaching-team chat: `me`, `history`, `poll`, `send`, `react`, `feedback` and `media/<id>`, and a 404 for `activity`) stay on the server,
with their tests, but the page has no thumbs, no "What TAi remembers" and no second chat, so it calls none of them (marked below):

| Call | What |
| --- | --- |
| `GET api/me` | who, `features` (`files`, `pictures`, `voiceNotes`, `voiceCalls`, `memory`, `activity`, `choices`, `admin`, `voiceNoteSeconds` (180), `maxUploadBytes`, `accept`; the page reads all of them but `memory` and `admin`), `maxChars`, `last`, `typing` |
| `GET api/history?limit=N` / `GET api/poll?after=N&wait=S` | the newest lines (at most 200) / the lines after number `N`, waiting up to `S` seconds for one. **The words of a voice call (`speech`) do not use up the places of `limit`**: the last `N` lines that are not speech come back with the speech lines among them, at most `3N` in all, so a long call does not push the chat from before it off the first screen |
| `POST api/send` `{text, files?}` | a message: `{ok, n}`. The agent gets the text (with the start of attached text files), **and ahead of it a line for each emoji the student put on TAi's messages since TAi was last told of them** (their last message, or TAi's answer to an emoji: see below) |
| `POST api/react` `{to, emoji}` | the student's emoji on one of TAi's messages. `to` is the number of a text or picture message of TAi's in this student's own history (404 for anything else, a call's summary included); `emoji` is one of 👍 ❤️ 😂 😮 😢 🙏, or `""` to take it back (400 for anything else, which is checked on the server). It appends a line (below), wakes the pollers, answers `{ok, changed, n}` (`changed: false` and no line when it is already so), and **starts no agent run by itself**: a quiet moment later the server hands TAi the emoji as a message of its own and TAi answers it (`TAI_PORTAL_REACT_REPLY_MS`, 3000 by default, 0 for never; the next emoji starts the wait again, a typed message or a voice note cancels it, none in a call or when the student is out of messages). 60 a minute per student |
| `POST api/choose` `{to, index}` | the student taps option `index` (0-based) of the line `to`, a line of TAi's in their own history that carries `choices` (404 for anything else, another student's numbers and `features.choices` false included; 400 for a `to` or an `index` that is not a whole number, or an index below 0). Only the options of the last thing said can be tapped, and once: **409** `{error: 'closed'}` when the student or TAi has said something since, `{error: 'answered'}` when a tap is already in the history. A tap is a message, so it is held to the allowance of messages (429 `rate-limited`), and when TAi cannot be reached nothing is recorded (**502** `unavailable`: the options stay tappable). On success the tap is the student's own line, `{role: 'user', text: 'B. A term has at most one leader', id, choice: {to, index, correct?}}` (a message like any other: no `kind`), and the answer is `{ok: true, n, correct?}` (`n` the number of that line; `correct` only when TAi marked an answer, which the server grades: the answer is never sent to the page). TAi is handed the tap with a note of which option it was and whether it was the one it marked, for TAi only; in a voice call the tap goes into the call as typed words do. Not under `api/admin/` |
| `POST api/feedback` `{to, rating, tag?}` | **No longer called by the page** (it has no thumbs; the server keeps the call, its limit and its tests). The student's thumb on one of TAi's replies. `to` is the number of a text or picture message of TAi's, or of a call's card (an `activity` line of type `voice`, `talk` or `interview`, or an old `voice` summary), in this student's own history (404 for anything else: their own messages, TAi's emoji lines, thumbs, voice notes, the other kinds of activity, another student's numbers); `rating` is `"up"`, `"down"` or `""` (take it back; 400 for anything else); `tag` is the reason and goes with `"down"` only: `"long"`, `"robotic"`, `"wrong"` or `"other"` (400 for anything else, and for a tag with another rating). It appends a line (below), wakes the pollers, answers `{ok, changed, n}` (`changed: false` and no line when it is already so, reason included), and **starts no agent run**. 60 a minute per student. Under `api/admin/` too |
| `GET api/memory` | **No longer called by the page** (the sheet is gone). What TAi remembers of the signed-in student, as that sheet showed it: `{memories: [{id, text, label, at}], progress: {solid, gettingThere, justStarted: [{name, aloud}], untouched, mixups: [{belief, about}], works: [string], style} \| null}`. Words only: no score, stability, date or id of COMPETENCY.md; `id` is the note's own (what `forget` takes), `at` when it was saved (ISO), `progress` is `null` for a student with no COMPETENCY.md yet. The student's own folder, from the session: never another's. 404 where the deployment keeps no notes (`features.memory` is false), and under `api/admin/` (there is no such call) |
| `GET api/activity?limit=N&before=N` | the signed-in student's activity list, newest first: `{entries: [line], more}`. The lines are the `activity` lines (below) and the long call summaries that older histories hold as `voice` lines, as they are in the history (`n`, `ts`, `type`, `title`, `text`, `detail`), nothing else (no message, emoji or thumb). `limit` is 1 to 100 (30 when absent or nonsense), `before` a line number: only the lines before it, and `more` says there are older ones. The student's own history, from the session: never another's. 404 under `api/admin/` (the teaching-team chat has none) |
| `POST api/memory/forget` `{id}` | **No longer called by the page.** Takes one of TAi's saved notes about the signed-in student back: `DELETE FROM memories WHERE id = ? AND student_folder = ?` (so another student's id is a 404, as is an id that is gone), then rebuilds `groups/<folder>/memory_store.json`. `{ok: true}`; 400 for an id of another shape; 20 a minute per student |
| `POST api/voicenote?duration=&peaks=&id=` | a voice note: the body is the recording, **its own type as the `Content-Type`** (`audio/webm`, `audio/ogg`, `audio/mp4`, `audio/mpeg` or `audio/wav`, parameters allowed; anything else is a 415, checked again against the bytes, which also give the type it is kept and served under), at most 5 MB, counted as an upload and as a message. `duration` (seconds, from the page's clock: a recorder's WebM carries none), `peaks` (up to 64 numbers 0-100: the waveform) and `id` (the page's UUID for the message: a second note with the same id is not a second message) are optional. It keeps the recording (100 MB per student at most: 413 `quota`), has Deepgram turn it into words, appends the `audio` line, and sends the agent `[Voice note, 0:12] the words` (or `[The student sent a voice note of 0:12 that could not be transcribed: ask them to type it]` when there were none or Deepgram failed: **the recording is kept and shown either way**). Answers `{ok, n, entry}`; 502 `unavailable` when TAi could not be reached (the note is kept, and the same id sent again delivers it); 409 `in-progress` for a copy that arrives while the first is still being turned into words. While a voice call is on its words go into the call as typed words do, and the text agent stays out of it. Students only |
| `POST api/voice/warm` `{}` | the call button was pressed and the microphone has not been asked for yet (`voice.js` sends it first, fire and forget; `src/portal/voice-routes.ts`): starts the student's call tool host so it comes up while the permission prompt is on screen. `{ok, state}` at once (`warming`, `warm`, `active`, `recent`, `budget`, `busy`, `full`, `off`); never waits for the container, nothing the page needs. docs/VOICE.md, "Warming up" |
| `POST api/upload?name=` | a file's bytes, as before (a recording is refused here: 415) |
| `GET api/prefs` | the student's preferences: `{tz (null until told), voiceSpeed (null until chosen), defaults: {voiceSpeed} (what a call uses until then), notify: {push: [{id, added}], email: {enabled}}, limits: {quietStart, quietEnd, dailyMax, maxDevices, emailAfterMinutes and emailDailyMax when e-mail is on}}`. A subscription is never returned, only the 16-hex `id` the page works out for its own (SHA-256 of its endpoint) |
| `POST api/prefs` | a partial update, all or nothing: `{tz?, voiceSpeed?, notify?: {email?: {enabled}}}`. `tz` an IANA name (400 `bad-tz`), `voiceSpeed` 0.8 to 1.4, kept in steps of 0.05 (400 `bad-voice-speed`); any other key is a 400 `unknown-key` (so `notify.push` cannot be written here), e-mail is a 400 `email-off` until the mail channel exists, `{}` is `empty`. Stored in `store/portal/<folder>.prefs.json` (docs/NOTIFICATIONS.md says who reads it) |
| `GET api/push/key` | `{key}`: the VAPID public key, for `pushManager.subscribe`; 404 `push-off` when push is not on |
| `POST api/push/subscribe` | `{endpoint, keys: {p256dh, auth}, expirationTime?}` as the browser's `toJSON()` gives it; the endpoint must be https on a known push service and the keys real (400 `bad-endpoint`, `bad-keys`, `expired`); five browsers a student at most (a sixth takes the oldest's place), one student per browser, 20 a ten minutes (429); `{ok, id, devices}` |
| `POST api/push/unsubscribe` | `{endpoint}` or `{id}`: takes that browser off the student's list (quiet about one that is not there; works when push is off); `{ok, removed, devices}` |
| `GET api/poll?after=&wait=&c=&v=` | `c` (a UUID the page makes per load) and `v` (`0` when its tab is behind another; missing: in front) are optional and say whether the page is open and in front (src/notify/presence.ts); they change nothing in the answer |
| `GET api/me`, `GET api/poll?after=&wait=&sv=` | **Progress** (`PROGRESS.md`): both answer `status` (`{state: 'working' or 'queued', label?, ahead?}`: present only while TAi works on the student's message or the message waits for a container; `label` is one of nine fixed words, `ahead` the number of other students' messages in line, only when the queue knows it) and `sv`, the version of it. `typing` stays as it was. The poll takes the `sv` of the last answer and returns at once when there is a newer one; a change wakes a waiting poll at most once a second. The history line of a reply may carry `sources` (at most four `{kind, label, url?}`: what TAi's tools returned for it, shown as "Looked at"; `url` only for the hosts in `TAI_SOURCE_HOSTS`, the Canvas host and GitHub) |
| `GET api/doc/meta?d=`, `GET api/doc/page?d=&p=`, `GET api/doc/words?d=&p=`, `POST api/doc/open`, `GET api/doc/job?j=` | **The document viewer** (`DOCUMENTS.md`, `VIEWER.md`): a prepared document of this student's (a PDF, a PowerPoint, Word or Excel file turned into page images and words by a disposable container: LibreOffice makes the PDF of an Office file first, `COURSE_DOCS.md`; a deck of the course library, which every student may open, is read through the same routes), its page images and the words of a page, opening one of their attached files (`{n, index}`: which file of which of their own messages, never a name), and the progress of a document being prepared. `features.viewer` says the service is on. The page and words routes have a limit of their own (600 a minute) instead of the shared read limit |
| `POST api/view` `{v: 1, ...}` | **Where the student is looking** (`CHAT_OBJECTS.md` "The view"): the page's whole view (the document and page open, the words selected, the lines of a run card, a chart's point ...), kept in memory for ten minutes and described to TAi when a message is sent (`VIEWER_VOICE.md`); during a call the same view goes over the call's socket instead. `{ok: true}`, or 400 `bad-view` |
| `POST api/predict/run` `{n, guess}`, `GET api/predict/state?n=` | **A prediction card's Run button** (`PREDICT.md`): runs the card's own program in the sandbox, once for each card, leaves the guess and a run card in the chat and tells TAi; the state route says which cards have run |
| `GET api/media/<id>` | a picture, or a voice note, of this student's and nobody else's (another's is a 404). Served with `Accept-Ranges: bytes` and answers a `Range` with 206 (Safari plays no recording it cannot ask for in pieces) |

The history is one JSON line per thing (`store/portal/<folder>.jsonl`), numbered `n`. A line is a text message unless it has a `kind`:

| `kind` (and `role`) | What |
| --- | --- |
| none or `text` | a message: `role`, `text`; the student's carry `id` (what TAi's emoji name) and `files`. **A line of TAi's that asks with options** also carries `choices` (two to six `{label: 'A'..'F', text}`; `text` is the question alone) and, for a quick check, `quiz: true`; the answer TAi marked (`secret`, with `doubt: true` in it when the host dropped a key that other models did not bear out) is the host's alone and is left out of everything the page is sent: for the page a quick check whose key was dropped is a quick check whose taps have no `correct` (only the chosen option is marked). **A student's line that is a tap** carries `choice: {to, index, correct?}` (the line it answers, the option, and whether it was the one TAi marked, when TAi marked one); it is a message in every other respect |
| `image` (assistant) | a picture TAi drew: `media`, and its caption in `text` |
| `object` (assistant) | **a card in the chat** (`CHAT_OBJECTS.md`): `obj` is one of `run` (a run of the student's Go code: `RUN_CARDS.md`), `doc` (a prepared document: opens the viewer), `chart`, `trace`, `predict`; `text` is its one-line summary (what search and a screen reader have). Written only through the history's gate (`src/chat-objects/clean.ts`); never something TAi said: no emoji, not unread |
| `react` (assistant) | TAi's emoji on a student's message: `to` (that message's `n`), `emoji` |
| `react` (**user**) | the student's emoji on one of TAi's messages: `to`, `emoji`, `text: ""`; an empty `emoji` takes the student's emoji back. The last line for a message is how it stands |
| `feedback` (**user**) | the student's thumb on one of TAi's replies or on a call's summary (the page has no thumbs any more and writes none; histories from before may hold them, and the page ignores them silently): `to` (that line's `n`), `rating` (`"up"`, `"down"`, or `""` for a thumb taken back), `tag` (on a `"down"` only, and optional: `"long"`, `"robotic"`, `"wrong"` or `"other"`), `text: ""`. The last line for a message is how it stands. Example: `{"n": 9, "ts": "...", "role": "user", "text": "", "kind": "feedback", "to": 4, "rating": "down", "tag": "long"}`. The humanness report counts these lines straight from `store/portal/<folder>.jsonl` |
| `activity` (assistant) | something that happened for the student, which is not something TAi said: `type` (`voice`, `talk`, `interview` for a call; `memory` a note TAi kept; `reminder` one it set; `progress` a topic that moved on a step; `course` a change in the course or in the student's own standing in it), `title` (at most 60 characters: "Voice call · 4 min"), `text` (one line, at most 140: the gist), `detail` (at most 1500, optional: what the card opens), `items` (a mock interview's line only, optional: at most 8 of `{question, said, band, better, topic}`, strings of one line and at most 240 characters, `band` a level WORD and never a score: the card lists them with a "Practise this" button, docs/VOICE.md "The review card"). The page draws it as a card (see "Activity"), never as a bubble. Written by the orchestrator through `Portal.recordActivity` (a call after it ends, a note, a reminder, a step of progress), `Portal.recordCourseUpdate` (every student who has a conversation here) and `Portal.recordForCanvasUser` (one student, found by their Canvas user id); a student whose history is empty is written to by none of them (they are greeted first) |
| `voice` (assistant) | a voice call's summary as older histories hold it (a call now writes an `activity` line of its own type; the long summary stays in the voice side's records and reaches the text agent as before). Still listed in the activity list, as a call's card |
| `audio` (**user**) | a voice note: `mediaId` (its recording, `api/media/<mediaId>`), `duration`, `peaks`, `text` (the transcript, empty when there was none), `id` |
| `speech` (**user** / assistant) | what was said aloud in a voice call: `text` is the words of one turn (role `user`: the student; `assistant`: TAi), `call` the call's session id. **A marker** has `text: ""` and an `event`: `start` (with `mode`: `conversational`, `interviewer` or `listener`), `mode` (the call switched kind, with the new `mode`) or `end` (with `seconds`, how long the call was). The page draws a call's words from these lines and from nothing else |

A `react` or `feedback` line is not a message: no bubble, no time stamp, nothing in the pill, the drawer or the search, and nothing that looks for "the
student's newest message" (TAi's emoji with an id nobody knows, the page's own emoji for a message that says it worked) takes it for one. An
`audio` line **is** a message of the student's (the page's own emoji may land on its words). A `speech` line is not a message either: it never
counts as unread or toward the drawer's message counts (which say the spoken lines apart), cannot be reacted to (`POST api/react` is a 404 for
it), and does not close the options of a quick check (it is no "something said": see "Options and quick checks"). The voice side's `recentChat`
(`src/voice/hub.ts`, which reads the same file) keeps only plain text lines, so a call's context holds none of them.

TAi hears of the student's emoji with their **next** message, as one line each ahead of the text, **for TAi only** (never in the student's
bubble, and not in what is injected into a voice call, which has its own context): `[The student reacted 👍 to your earlier message: "the first
80 characters of it"]`, for the emoji put on since TAi was last told of them, net (an emoji that was set and taken back says nothing, a changed
one says its last value), the newest three, oldest first; a message that is a picture without words is `"(a picture)"`. The lines are read
before the new message is written, so they are about what came after the last one. When the student types nothing after an emoji, the same
lines are TAi's message after the quiet moment (`TAI_PORTAL_REACT_REPLY_MS`), and TAi is then told they are told: the next message of the
student's does not carry them again, and the orchestrator hands TAi a word budget of eight for that answer (`reactionOnly` in
`src/reply-shape.ts`: a short answer to a small gesture). That answer is a run like any message, so it is held to the same allowance (30
messages per 10 minutes), and one is never started within a quiet moment of the last.

The student's thumbs (the page has none now; this is for the lines that older histories hold, and for a caller of `POST api/feedback`) are told the
same way, after the emoji, as up to three lines of their own (net per message, oldest change first):
`[The student liked your earlier message: "..."]`, `[The student said your earlier message was too long: "..."]` (or `sounded robotic`,
`was wrong or misleading`), and `[The student gave your earlier message a thumbs down: "..."]` for a thumb down with no reason or with
"something else". For a call's summary the words are `your voice call` instead of `your earlier message`. A thumb that was given and
taken back says nothing; none of it reaches the student's bubble or a call.

## Who may come in

Google's "Sign in with Google" button hands the page an ID token. The server (`src/portal/auth.ts`) checks it against Google's published
keys: RS256 signature (only that algorithm), issuer, audience (this deployment's client id), expiry, `email_verified`, and a **nonce** the
server issued to that page a moment before and accepts once. The verified address must be on the allowlist (`users.json`, below), else
the page says the address is not on the list and no session exists. The session is a cookie the server signs itself (HMAC-SHA256 with the
secret in `portal-secret`; `HttpOnly; Secure; SameSite=Lax`, limited to `/tai`, 12 hours): nothing is stored, a restart signs nobody out,
and taking an address off the list ends its session at the next request.

What a request may say is deliberately small. The chat a message goes to, the Canvas user id and the GitHub login come from the
allowlist entry of the signed-in address, never from the request; the name TAi is told is the allowlist's, not Google's display name
(which the student chooses and which would otherwise reach the prompt). A POST must be JSON, carry the page's `X-TAi` header and come from
the page's own origin. Limits: 30 sign-in attempts per address per 10 minutes, 30 messages per student per 10 minutes, 6000 characters per
message, 4 waiting polls per student, 16 KB request bodies (a file: 5 MB, 30 uploads per student per 10 minutes; a voice note: 5 MB, counted
as an upload and as a message, and 100 MB of recordings kept per student; 60 emoji changes and 60 thumb changes per student per minute; 20
notes taken back per student per minute; 20 call connections per student per 10 minutes). The page's content policy allows scripts only from itself and Google's one script (`style-src` also allows inline
styles because Google's button sets them on itself), connections only to itself (the call's WebSocket included), pictures and sound from
itself and local previews; the microphone is allowed to the page itself and to nothing embedded in it.

`users.json` (outside the tree, so a deploy never overwrites it; re-read whenever it changes):

```json
{"users": [{"email": "ada@gmail.com", "name": "Ada", "canvasUserId": "123456", "githubUsername": "ada", "role": "owner"}]}
```

`tai_live.sh users add EMAIL [--name N] [--canvas ID] [--github LOGIN] [--owner] [--from-facts]` edits it; `--from-facts` takes the Canvas
id, name and GitHub login that `tai_credentials.sh` found when it checked the owner's own tokens. `role` is only a label (the owner's chat
is a student chat like any other: no admin rights). An address is matched exactly (lower-cased), Gmail dots included.

## Setting it up

1. `tai_credentials.sh` (Canvas, GitHub, Piazza), run by the operator at hidden prompts.
2. `tai_live.sh deploy` (tree, build, a clean knowledge corpus, the agent image `tai-agent:live`, the live gateway `tai-live-litellm`, the
   `tai-live` systemd service). Nothing is reachable from outside yet.
3. Google sign-in, by the operator (the client id is public; there is no client secret in this flow):
   Google Cloud console → APIs & Services → OAuth consent screen (External; app name TAi; scopes openid, email, profile; publish it: a
   consent screen left in "Testing" lets only the listed test users in) → Credentials → Create credentials → OAuth client ID → Web
   application → Authorized JavaScript origins `https://tai.example.edu` (nothing under redirect URIs) → copy the client id
   (`…apps.googleusercontent.com`), then `tai_live.sh set TAI_GOOGLE_CLIENT_ID=<it>` and `tai_live.sh restart`.
4. `tai_live.sh users add <your gmail> --owner --from-facts`.
5. `tai_live.sh expose` puts `/tai` behind the world's traefik (a `tai-edge` container found by its labels; the world's compose file is not
   touched). `tai_live.sh unexpose` takes it away; the service keeps running.
6. `tai_live.sh check` (from the host: through the socket, that the voice model and the agent's model each answer a one-word request through
   the gateway (a provider that refuses the key, as with its billing on 2026-11-04, shows as "PAYMENT REQUIRED"; the gateway's own health
   check stays green), through traefik with `--resolve`, and that the host's own API is on loopback and
   not reachable from the agents' network) and `tai_live.sh smoke` (one read-only conversation as the owner with the real tokens, through
   the loopback API).

Without a client id the page runs closed: it loads and says sign-in is not set up. Without `users.json` nobody gets in.

## Settings (orchestrator environment; `tai_live.sh` writes them to `orch.env`)

| Setting | What |
| --- | --- |
| `TAI_PORTAL_SOCKET` / `TAI_PORTAL_PORT`, `TAI_PORTAL_HOST` | Where the page listens: a unix socket (live) or a loopback port. Anything wider than loopback is refused. Neither set: no page. |
| `TAI_PORTAL_USERS_FILE`, `TAI_PORTAL_SECRET_FILE` | Required with the page: the allowlist and the cookie secret (64 hex digits, mode 600). It will not start without them. |
| `TAI_GOOGLE_CLIENT_ID` | The OAuth web client id. Empty: sign-in is closed. |
| `TAI_PORTAL_ORIGIN` | `https://the.host`: POSTs must come from it, the cookie is `Secure` under https. |
| `TAI_PORTAL_BASE_PATH` | `/tai`: the cookie's path, and the `<base>` the page's relative addresses resolve against. |
| `TAI_PORTAL_TRUST_PROXY` | `1` behind traefik: the last `X-Forwarded-For` entry is the client (per-address limits). |
| `TAI_PORTAL_REACT_REPLY_MS` | How long the student must go without an emoji or a message before TAi answers the emoji they put on its messages (3000). `0`: TAi never answers an emoji by itself (it hears of them with the next message, as it always did). Bounded; nonsense is the default. |
| `TAI_PORTAL_SESSION_HOURS`, `TAI_PORTAL_HISTORY_DIR`, `TAI_PORTAL_STATIC_DIR`, `TAI_PORTAL_JWKS_URL` | Session length (12), where histories go (`store/portal`), where the page's files are (`portal/web`), where Google's keys are (tests). |
| `TAI_WEB_OUTBOX_LOG` | `0`: do not append every outbound message to `store/web-outbox.jsonl` (the live deployment keeps its histories in the page's own store). |

## Checking it

* `npx vitest run src/portal portal/web` (310 tests, and one skipped): the token checks (forged, expired, wrong audience, wrong nonce, algorithm confusion,
  unknown key, key rotation), sessions, the allowlist, the server (who can reach what, cross-student isolation, limits, request shapes,
  restarts), the extras' server side (`features.test.ts`: pictures; TAi's emoji and the student's own, their validation, their isolation, what
  TAi is told of them and that they start no run of their own; TAi's answer to them (one a quiet moment after the last, one answer for three
  taps, one for an emoji on that answer, none when the student types first, takes it back or is in a voice call, none for a student out of
  messages, told of the notes once, switched off by the setting); the activity list (`api/activity`: the lines and the old call summaries,
  newest first, a page at a time, the bounds of `limit` and `before`, the student's own and nobody's else, a 404 in the teaching-team chat;
  `recordActivity` clipping what is too long; a change in the course reaching every student who has a conversation and no one who has not;
  one student's standing found by their Canvas user id and reaching nobody else; a thumb on a call and not on a note); the student's thumbs (`api/feedback`: the line each change makes and none when nothing
  changes, what is refused, a picture and a call's summary, the teaching-team chat's own, the limit, what TAi is told with the next message:
  net, three at most, after the emoji, once, and never a call; that the readers of the history do not take the line for a message and read it
  back after a restart) and `feedback.test.ts` (the request, the lines TAi reads); what TAi remembers (`api/memory` and `api/memory/forget`: a
  student's own notes and file and nobody else's, a note only by its id and the session's folder, the checks every POST gets, the limit, no
  call in the teaching-team chat) and `memory-view.test.ts` (COMPETENCY.md in words with no number of it left, its three spellings, the SQL
  and that it always names the folder); uploads; voice notes: the five types by the content type and by the bytes, the size, the
  quota, the ranges a player asks for, another student's recording, a transcriber that is down or hears nothing, a retry, a note while a call
  is on; the call's socket), the Markdown renderer (hostile text, text built to be slow), the call's audio arithmetic at 48, 44.1 and 16 kHz
  (`voice.test.js`: the capture worklet's frames, their rate and pitch; TAi's chunks joined without a seam; the first message of a call: plain,
  an interview's token, "Talk it through" and its topic, a resume), the voice note's pure parts (`notes.test.js`: the clock, the waveform,
  where a click on the seek bar lands), the activity list's pure parts (`activity.test.js`: a history line as a card, the first sentence of
  an old call summary, a day's heading, the time on a card), the options a student can tap (`choices.test.js`: which lines have options and
  which are not, how they stand from the lines the page holds: open, answered by which and right or not, closed, in whatever order the lines
  came; what the buttons look like in each, a wrong pick giving nothing away; what copying and tapping say), a call's place in the conversation (`speech.test.js`: what a line of a call and a marker are, what a marker says,
  how long a call was, when a bubble is folded and how the "..." of a student who is speaking comes up, holds and goes; `voice.test.js` also
  has the level the orb shows) and that every file the page imports is one the server serves (`pagefiles.test.js`;
  the page's own tests of thumbs and of "What TAi remembers" went with them). The server's tests of what the page no longer calls stay (`api/feedback`,
  `api/memory`, `api/admin/*`). The
  server's TypeScript is not checked by vitest:
  `npx tsc --noEmit -p tsconfig.json` is (the dev server swallows compile errors on purpose, to run on a machine without every dependency).
* `uv run --no-project --python 3.11 --with playwright python portal/qa/portal_e2e.py [--out DIR] [--only NAME,NAME]` is the whole browser
  suite in one command: it starts a fresh `node portal/qa/dev_server.mjs --port=0` (the real page in front of a pretend TAi; it accepts
  `dev:<address>` where Google's token would go) and drives it in Edge, with Chromium's fake microphone playing a 440 Hz tone. First the
  text chat as before: sign-in through a fake Google button, a conversation with a table, code and hostile markup, the pill and its arrow,
  the plus (the file picker) and the microphone/send button, a reload, a second tab, light and dark, a phone (the top bar's four things in a
  row), sign-out, an address that is not on the list. Then each extra as another student, in a context of its own: pictures and the lightbox,
  TAi's emoji, the student's emoji on TAi's messages (the smiley on hover and focus, the six, the badge and its pop, a reload, a second tab
  that changes it live, taking it back, the keyboard, Escape, Tab and outside clicks, a picture, what TAi is told with the next message,
  none for a call's card; and on a touch screen, with real touch events: the tap, the long press, a finger that moves, the browser's menu
  held back for that press only; and no thumbs beside a reply, hovering or not), talking it
  through (the chevron and its menu, the start message, the listener's badge, orb and colours, a switch into and out of the interviewer in
  the middle of a call, a dropped connection taken up again, the end and the call's card with nothing to press in it, the card's fifth place
  to start, a phone), TAi answering a student's emoji (the dev server's control port turns the answer on for that flow: one a moment after the emoji, one
  more for an emoji on that answer, one answer for two emoji, none when the student types first, takes it back or is in a call), the
  activity list (the rail's Activity button: after Search and before the classroom link, drawn, pressed while the sheet is open, opened by
  click and by Enter, the focus back on it, and an account menu that is who, the theme and sign out; a card of every kind in the conversation
  and as a row of the sheet: its own icon, the line cut with an ellipsis, closed and opened by click, Enter and Space, nothing to press in
  an open one, nothing to open without a detail, an old call summary, no count on the pill or in the tab's title, a line of a thumb, such as
  older histories hold, ignored silently; Today, Yesterday and a date, a line that arrives while the sheet is open, Show more by thirty, Show in the conversation, the Chats drawer's entry, its count and
  its search, a server that cannot be reached, a reload, a session that ended; on a phone, where there is no rail and the drawer's entry is
  the way in, with real touches), options to tap (a quick check, held back at the server's answer to see the page in between: the student's
  message at once, all buttons off with the one tapped marked, then a tick and "Correct" said politely; the answer TAi marked nowhere in the
  history or on the page; a reload showing it answered from the lines; a wrong pick with a cross, "Not quite" and nothing given away, the
  right option looking like the other one not picked; quick replies with no verdict and markup in an option shown as words; the options closed
  by words typed instead and by TAi saying more, left open by an emoji and a card of the activity list; copying the question and its options;
  the drawer's search; Tab, Enter and Space with the focus staying put through a reply and a poll; a server that cannot be reached, one that
  says too fast, something said that the page had not heard of and a tap made in another tab, each settling the options; a phone with a long
  option; reduced motion asked for, the ring on the option tapped keeping still; a voice note that does not go leaving the options on and
  closing them while it is tried again; a quick check whose key was dropped, with a pick and no verdict; the page with the feature off
  showing the question as words), files (the picker, drag and drop, paste, progress, what is refused, the five-file limit; one release per
  removed file, twelve remove-and-retry rounds past the ten-upload limit, none for a sent or failed file, the rest at sign-out), voice notes
  (recorded from the fake microphone and sent as audio: the recording bar, its level, the bubble at once, the words and their toggle, TAi's
  line, playing, pausing, seeking by click and keys, one at a time, a reload and playing from the server, a note nobody could make out, a
  transcriber that is down, an upload that fails and is tried again, cancelling and Escape, the microphone let go, the three-minute stop with
  a fake clock, a phone), the pill's every state (the arrow, "N new messages", what does not count, "seen" by the bottom edge, the 80 px
  line, no flicker while it glides), a call against `portal/qa/fake_voice.mjs` (a WebSocket that speaks the browser protocol and measures
  what arrives: frames of 1280 bytes, 25 a second, carrying the tone at 440 Hz, which only a right resampling ratio gives; then the orb at the bottom
  (where it sits and how big, the call's two buttons in the message box in the microphone's place), the call's words as lines of the
  conversation (never captions), the states, typing into the call, no voice note while it is on, interruption emptying playback, the interviewer
  (and the divider that says so), mute (red, the orb grey with a slash), a dropped
  connection taken up again, the end letting go of the microphone and the AudioContext (and the orb's room collapsing, the box its own again,
  a divider with the call's length, then its card), busy/budget/not-configured, a refused microphone, leaving the page), a call in the
  conversation (the student's lines on the right and TAi's on the left, with the waveform of spoken lines; the grey ... that comes up when the
  server hears the student begin, stays while their microphone is audible, goes with the line, with the mute and by itself four seconds after
  the last sign of speech, a quiet microphone being a context of its own; not unread, not among the drawer's messages but counted apart, no
  smiley or quote, `api/react` a 404, closing no quick check; a long bubble folded and opened and copied whole; the drawer's search finding
  what was said; a reload keeping the lines and the dividers; 260 more lines not pushing the chat from before the call off the first
  screen), the orb in each state and what it follows (TAi's voice as it is played, the student's) with its colour for each kind of call,
  with reduced motion asked for, a call on a phone (the smaller orb, buttons of 44 px, the last line clear of it, a tap on each), the interview link (signed out first, and an expired one), signing out during a call, reduced motion, and the page with
  every feature off. No console error, content-policy violation or sideways overflow on a phone is allowed anywhere. 918 checks. Screenshots go to `--out`: every new
  element in dark and light, desktop (1280x800) and a 390 px phone (`NAME-THEME-SIZE.png`). `--only` runs some flows (`main_flow` is the
  first walk). `node portal/qa/dev_server.mjs` alone runs the page for looking at: 127.0.0.1:8787, with the tests' control port on 8788
  (make TAi send a picture, an emoji or a line of text, or ask with options to tap (a quick check, with the right option as the server's
  secret, or quick replies), steer the call (TAi speaks, the student speaks: their line of speech with the ... before it, lines of a call made before, a marker), make the transcriber fail or say something, make TAi unreachable for a student, add a line of the
  activity list for a student, set how long TAi waits before it answers an emoji, read what it measured)
  and the page with every feature off on 8789; `--base http://127.0.0.1:8787/` points the suite at it (fresh conversations needed). It does
  not test Google itself, a real microphone, a real phone or Safari: the real sign-in, a real call and a voice note from a phone are the
  owner's to try once.

## The teaching view

`portal/web/team.html` is a read-only page for the owner role (`features.team`, an owner-only **Teaching view** entry in the account menu): the class's
competency heat map, the misconceptions across the class, the patrol's last week, the quick checks' results per question, who needs attention, and the voice
use. Its two calls (`GET api/team/overview`, `GET api/team/student?folder=`) are owner-only on the server (401 signed out, 403 for anyone else) and are
`no-store`; `serveStatic` now puts the content policy on every `.html` file, not only `index.html`. What each panel is, where its numbers come from, what never
leaves the server, how to give someone the owner role and what was not verified: `docs/TEAM_VIEW.md`. Tests: `src/portal/team.test.ts`,
`src/portal/team-routes.test.ts`, `src/portal/team-db.test.ts` (skipped where sqlite has no build) and `portal/web/team.test.js`.
