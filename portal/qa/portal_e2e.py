"""The student page in a real browser (Edge through Playwright): sign in through a fake Google button, a conversation with markdown, code,
a table and hostile markup, hover actions, the "N new messages" pill and its arrow, the Chats drawer and its search, the plus (it opens the file
picker) and the microphone/send button, a reload, a second tab, the light theme, a phone screen (the top bar must fit), signing out, and an
address that is not on the list. Then what the server can switch on, each as another student in a fresh browser context: TAi's pictures (a
lightbox) and emoji reactions, the student's own emoji on TAi's messages (the button, the six, the badge, the keyboard, a second tab, what TAi
is told with the next message; on a touch screen with a real long press), attached files (the picker, drag and drop, paste, progress, what is
refused), voice notes (recorded from Chromium's fake microphone, sent as audio: the bubble at once, the words under it, playing and seeking, a
note nobody could make out, a transcriber that is down, an upload that fails and is tried again, the three-minute stop, during a call), the
"new messages" pill's every state, a voice call (the microphone really streams: a test tone through the fake microphone, checked for frame
size, rate and pitch at the fake server; captions, interruption, the interviewer, mute, a dropped connection, the end; the call's account
comes back as a compact card, not a bubble), TAi answering a student's emoji (a moment after the last one, unless they type first, take it
back or are in a call), the activity list (calls, notes TAi kept, reminders, progress and course news as cards in the conversation and as
the days of a sheet that the rail's Activity button opens, and on a phone the Chats drawer: opening one, paging, a line that arrives while
the sheet is open, the Chats drawer's search, a phone), the mock interview link, and the same page with every feature off. (The page has no
thumbs, no "What TAi remembers" and no second, teaching-team chat any more: what the server still has of them is not used by the page.)

    uv run --no-project --python 3.11 --with playwright python portal/qa/portal_e2e.py [--out DIR] [--headed] [--only NAME,NAME]
        starts its own dev server (node portal/qa/dev_server.mjs --port=0: fresh, on free ports) and stops it at the end;
        --only runs just those flows (main_flow is the signed-out walk; the names are the functions in FLOWS below)
    uv run --no-project --python 3.11 --with playwright python portal/qa/portal_e2e.py --base http://127.0.0.1:8787/
        against a dev server already running (it must be fresh: the checks expect new conversations); its control port is the next one
    uv run --no-project --python 3.11 --with playwright python portal/qa/portal_e2e.py --gate-only --base https://the.host/tai/

Google's script is replaced by a fake that renders a button; clicking it hands the page's own callback the credential
"dev:<address>", which the dev server accepts in place of a Google token. What this checks is the page: that it asks the server for a
nonce and gives it to Google's initialize, signs in and out, shows what arrives as text and never as HTML, keeps the conversation across a
reload and a second tab, and holds up on a phone. It does not check Google itself (--gate-only is for the real deployment: it loads the
real Google script and fails on any [GSI_LOGGER] line), nor a real microphone, a real phone or Safari. Screenshots go to --out (every new
element in dark and light, desktop 1280x800 and a 390 px phone: NAME-THEME-SIZE.png).
Exit status: 0 everything held, 1 a check failed (the report says which), 2 the run itself failed."""
from __future__ import annotations

import argparse
import json
import math
import queue
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import wave
from datetime import datetime, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]

FAKE_GOOGLE = r"""
(() => {
  window.__gsi = { initialized: [], rendered: 0, credential: 'dev:ada@example.com' };
  window.google = { accounts: { id: {
    initialize(config) { window.__gsi.config = config; window.__gsi.initialized.push({ client_id: config.client_id, nonce: config.nonce }); },
    renderButton(el, options) {
      window.__gsi.rendered++; window.__gsi.options = options;
      const b = document.createElement('button');
      b.id = 'fake-google'; b.type = 'button'; b.textContent = 'Sign in with Google (fake)';
      b.addEventListener('click', () => window.__gsi.config.callback({ credential: window.__gsi.credential }));
      el.replaceChildren(b);
    },
  } } };
})();
"""

# What the page cannot see about itself: content-policy violations, and the microphones and audio contexts it opened (so a test can see
# that a call let go of them). Injected by the browser, outside the page's content policy.
PAGE_PROBE = r"""
(() => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  window.__streams = [];
  window.__contexts = [];
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const real = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints) => { const s = await real(constraints); window.__streams.push(s); return s; };
  }
  if (window.AudioContext) {
    const Real = window.AudioContext;
    window.AudioContext = class extends Real { constructor(...a) { super(...a); window.__contexts.push(this); } };
  }
})();
"""

results: list[tuple[bool, str]] = []


def check(ok: bool, what: str, detail: str = "") -> None:
    results.append((bool(ok), what))
    print(("  ok   " if ok else "  FAIL ") + what + (f"  [{detail}]" if detail and not ok else ""))


def wait_for(page, predicate_js: str, timeout_ms: int = 15000) -> bool:
    # Polls with evaluate(): wait_for_function() compiles a string in the page, and the page's content policy forbids that (as it should)
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        try:
            if page.evaluate(predicate_js):
                return True
        except Exception:
            pass
        page.wait_for_timeout(100)
    return False


def settle(page, predicate, timeout_ms: int = 5000) -> bool:
    """Waits for something the test itself collects (requests, responses): page.wait_for_timeout keeps Playwright's events coming in."""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        if predicate():
            return True
        page.wait_for_timeout(50)
    return bool(predicate())


def sign_in(page, address: str = "dev:ada@example.com") -> None:
    page.evaluate("(c) => { window.__gsi.credential = c; }", address)
    page.click("#fake-google")


def send(page, text: str) -> None:
    page.fill("#input", text)
    page.press("#input", "Enter")


REPLIES = ".row.assistant[data-n]"        # what TAi said (the greeting and the starter card have no number)


def reply_count(page) -> int:
    return page.locator(REPLIES).count()


def wait_reply(page, count: int, timeout_ms: int = 15000) -> bool:
    return wait_for(page, f"document.querySelectorAll('{REPLIES}').length === {count}", timeout_ms)


def watch(page, problems: list[str]) -> None:
    page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
    page.on("console", lambda m: m.type == "error" and "401" not in m.text and "403" not in m.text and "Failed to load resource" not in m.text and problems.append(f"console: {m.text}"))


class Control:
    """The dev server's control port: what a test makes the pretend TAi do, and what it saw."""

    def __init__(self, base: str):
        self.base = base

    def post(self, path: str, body: str = "") -> dict:
        req = urllib.request.Request(self.base + path, data=body.encode("utf-8"), method="POST")
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.loads(res.read() or b"null")

    def get(self, path: str):
        with urllib.request.urlopen(self.base + path, timeout=10) as res:
            data = res.read()
            return data if res.headers.get("content-type", "").startswith("image/") else json.loads(data)


def fake_microphone(path: Path) -> Path:
    """A WAV for Chromium's fake microphone: a 440 Hz tone, its loudness swaying 3 times a second (so it is not a steady whine)."""
    rate, seconds = 48000, 3
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(rate * seconds):
            t = i / rate
            amp = 0.42 + 0.18 * math.sin(2 * math.pi * 3 * t)
            frames += struct.pack("<h", int(32767 * amp * math.sin(2 * math.pi * 440 * t)))
        w.writeframes(bytes(frames))
    return path


def shots(page, out: Path, name: str, wait_ms: int = 300, focus: str = "") -> None:
    """One element, four ways: dark and light, desktop and a 390 px phone (`focus`: JS that scrolls it into view after each resize)."""
    theme = page.evaluate("document.documentElement.dataset.theme")
    size = page.viewport_size
    for mode in ("dark", "light"):
        page.evaluate("(t) => { document.documentElement.dataset.theme = t; }", mode)
        for label, view in (("desktop", {"width": 1280, "height": 800}), ("phone", {"width": 390, "height": 844})):
            page.set_viewport_size(view)
            page.wait_for_timeout(wait_ms)
            if focus:
                page.evaluate(focus)
                page.wait_for_timeout(150)
            page.screenshot(path=str(out / f"{name}-{mode}-{label}.png"))
            if mode == "dark" and label == "phone":
                check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), f"{name}: nothing sticks out sideways on a phone")
    page.evaluate("(t) => { document.documentElement.dataset.theme = t; }", theme)
    page.set_viewport_size(size)
    page.wait_for_timeout(150)


def main_flow(browser, base: str, out: Path) -> None:
    """The page as a visitor and then a student meets it: sign-in, a conversation, a reload, a second tab, themes, a phone, sign-out."""
    context = browser.new_context(viewport={"width": 1280, "height": 800}, color_scheme="dark", permissions=["clipboard-read", "clipboard-write"])
    context.route("https://accounts.google.com/**", lambda route: route.abort())          # the real script never loads: the fake stands in
    context.add_init_script(FAKE_GOOGLE)
    context.add_init_script(PAGE_PROBE)
    page = context.new_page()
    problems: list[str] = []
    page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
    page.on("console", lambda m: m.type == "error" and "401" not in m.text and "403" not in m.text and "Failed to load resource" not in m.text and problems.append(f"console: {m.text}"))

    print("signed out")
    page.goto(base)
    check(wait_for(page, "document.querySelector('#fake-google')"), "the sign-in button is drawn")
    gsi = page.evaluate("window.__gsi")
    check(len(gsi["initialized"]) == 1 and gsi["initialized"][0]["client_id"].endswith(".apps.googleusercontent.com"), "Google is initialised with the client id")
    check(len(gsi["initialized"][0]["nonce"]) >= 24, "Google is given a nonce the server issued")
    check(page.evaluate("document.querySelector('#chat').dataset.mode") == "gate", "a signed-out visitor sees the sign-in conversation")
    check(page.is_disabled("#input") and "Sign in" in (page.get_attribute("#input", "placeholder") or ""), "the message box is there but off, and says why")
    check(page.locator("#chats-btn").is_hidden() and page.locator("#account").is_hidden() and page.locator("#rail-main").is_hidden(), "no chats, account or search before sign-in")
    check(page.locator(".row[data-n]").count() == 0, "none of a conversation is shown")
    check(page.evaluate("fetch('api/history').then(r => r.status)") == 401, "the conversation's API refuses a signed-out visitor")
    page.wait_for_timeout(700)
    page.screenshot(path=str(out / "01-gate-dark.png"))

    print("signing in")
    sign_in(page)
    check(wait_for(page, "document.querySelector('#chat').dataset.mode === 'chat'"), "signing in shows the conversation")
    check("Hi Ada" in page.locator(".row.assistant .bubble").first.inner_text(), "TAi greets the student by the name the teaching team gave")
    check(page.locator(".starter .card-row").count() == 5, "five places to start are offered (the last one is talking it through by voice: calls are on)")
    check(page.locator(".stamp").count() >= 1, "the conversation carries a time stamp")
    check(page.locator("#chats-btn").is_visible() and "Ada" in page.inner_text("#avatar"), "Chats and the account pill appear")
    check(page.locator(".name-pill").inner_text() == "TAi" and page.locator("#avatar-ring img").is_visible(), "TAi's face and name sit at the top")
    check(page.get_attribute("#input", "placeholder") == "Message" and not page.is_disabled("#input"), "the message box is on")
    page.wait_for_timeout(700)
    page.screenshot(path=str(out / "02-start-dark.png"))
    page.locator(".starter .card-row").nth(1).click()
    check(page.input_value("#input") == "I'm stuck on ", "a place to start that needs more words leaves the sentence in the box")
    page.fill("#input", "")

    print("a conversation")
    check(page.is_disabled("#send"), "send is off while the box is empty")
    page.locator(".starter .card-row").first.click()
    check(wait_for(page, "document.querySelectorAll('.row.user').length === 1"), "the first place to start sends at once and shows at once")
    check(wait_for(page, "!!document.querySelector('.row.typing')"), "TAi is shown to be working: dots in a bubble")
    check(page.locator("#avatar-ring.working").count() == 1, "and so is its face")
    check(wait_reply(page, 1), "the reply arrives")
    check(page.locator(".row.typing").count() == 0 and page.locator("#avatar-ring.working").count() == 0, "the dots go away with the reply")
    check(page.evaluate("getComputedStyle(document.querySelector('.row.user .bubble')).backgroundColor") == "rgb(10, 132, 255)", "what the student says is in a blue bubble")
    check(page.evaluate("getComputedStyle(document.querySelector('.row.assistant[data-n] .bubble')).backgroundColor") != "rgb(10, 132, 255)", "and what TAi says is not")

    send(page, "Explain a table of consensus protocols")
    check(wait_reply(page, 2), "a second reply arrives")
    check(page.locator(f"{REPLIES} table").count() == 1 and page.locator(f"{REPLIES} th").count() == 3, "a table is drawn as a table, inside the bubble")
    page.screenshot(path=str(out / "03-conversation-dark.png"))

    send(page, "show me code")
    check(wait_reply(page, 3), "a third reply arrives")
    check(page.locator(".code pre code").count() == 1 and "func worker" in page.inner_text(".code pre code"), "code is shown in a block")
    page.click(".code-copy")
    check(wait_for(page, "document.querySelector('.code-copy').textContent === 'Copied'", 3000), "the copy button says it copied")
    check("func worker" in page.evaluate("navigator.clipboard.readText()"), "the code reached the clipboard")
    # colour (portal/web/highlight.js): spans per token, and the block's text exactly as it was, so the copy button still copies what it says
    check(page.locator(".code pre code span.hl-keyword").count() >= 3 and page.locator(".code pre code span.hl-function").count() >= 1, "Go code is coloured: keywords and a function are spans")
    check(page.evaluate("document.querySelector('.code pre').textContent") == page.evaluate("navigator.clipboard.readText()"), "colour leaves the text of the block alone: the clipboard has exactly it")
    check(page.evaluate("getComputedStyle(document.querySelector('.code .hl-keyword')).color") != page.evaluate("getComputedStyle(document.querySelector('.code pre')).color"), "a keyword is drawn in a colour of its own, not the plain text's")

    send(page, "a list please")
    check(wait_reply(page, 4), "a fourth reply arrives")
    check(page.locator(f"{REPLIES} ol > li").count() == 3 and page.locator(f"{REPLIES} ol ul li").count() == 2, "a nested list is drawn as one")

    print("what can be done with a reply")
    last = page.locator(REPLIES).last
    last.hover()
    check(wait_for(page, "getComputedStyle(document.querySelectorAll('.row.assistant[data-n] .actions')[3]).opacity === '1'", 3000), "hovering a reply shows copy and quote beside it")
    last.locator(".act[data-act='copy']").click()
    check("Three things to check" in page.evaluate("navigator.clipboard.readText()"), "copy puts the reply's own text on the clipboard")
    last.hover()
    last.locator(".act[data-act='quote']").click()
    check(page.input_value("#input").startswith("> Three things to check:"), "quote puts the reply in the box as a quotation")
    page.fill("#input", "")

    send(page, "html")
    check(wait_reply(page, 5), "a reply full of markup arrives")
    check(page.evaluate("window.__pwned") is None, "no script ran")
    check(page.locator(f"{REPLIES} .md script").count() == 0 and page.locator(f"{REPLIES} .md img").count() == 0, "no script or picture came out of the text")
    check("<script>" in page.locator(REPLIES).nth(4).inner_text(), "the markup is shown as the words it is")
    links = page.locator(f"{REPLIES} a")
    check(links.count() == 1 and links.first.get_attribute("href") == "https://example.com/safe", "only the safe address became a link", str([links.nth(i).get_attribute("href") for i in range(links.count())]))
    check(links.first.get_attribute("rel") == "noopener noreferrer nofollow", "links open without handing over the page")
    page.screenshot(path=str(out / "04-markup-dark.png"))

    send(page, "a long answer")
    check(wait_reply(page, 6), "a long reply arrives")
    check(page.evaluate("document.querySelector('#jump').hidden"), "at the bottom there is no pill")
    send(page, "one more while I am looking back")
    page.wait_for_timeout(300)
    page.evaluate("document.querySelector('#scroller').scrollTo({top: 0})")      # the student looks back while the reply is on its way
    check(wait_reply(page, 7), "a reply arrives while the reader is looking back")
    shown = wait_for(page, "!document.querySelector('#jump').hidden && !document.querySelector('#jump').classList.contains('is-arrow')", 4000)
    check(shown, "an \"N new messages\" pill says there is something unseen below")
    pill = page.inner_text("#jump-text")
    check(pill == "1 new message", "and counts it (the student's own message, sent just before, does not count)", pill)
    check(page.evaluate("document.querySelector('#scroller').scrollTop") < 50, "the page did not drag the reader down")
    page.screenshot(path=str(out / "05-jump-dark.png"))
    if shown:
        page.click("#jump")
        check(wait_for(page, "document.querySelector('#jump').hidden", 4000), "the pill takes the reader to the latest and goes away")
    page.evaluate("document.querySelector('#scroller').scrollTo({top: 0})")       # looking back again, with nothing new
    check(wait_for(page, "!document.querySelector('#jump').hidden && document.querySelector('#jump').classList.contains('is-arrow')", 3000) and page.inner_text("#jump-text") == "", "with everything seen, the pill is a plain arrow with no words")
    page.evaluate("document.querySelector('#scroller').scrollTo({top: 1e9})")
    check(wait_for(page, "document.querySelector('#jump').hidden", 3000), "and at the bottom it is gone")

    print("the Chats drawer")
    total = page.locator(".row[data-n]").count()
    page.click("#chats-btn")
    check(page.locator("#drawer").is_visible() and page.locator(".day").count() == 1, "Chats lists the days of the conversation")
    check(page.locator(".day-label").first.inner_text() == "Today" and page.locator(".day-count").first.inner_text() == f"{total} messages", "with today's message count", page.locator(".day-count").first.inner_text())
    page.fill("#search-input", "consensus")
    check(wait_for(page, "document.querySelectorAll('.hit').length >= 1", 3000), "searching finds the messages that match")
    check(page.locator(".hit mark").first.inner_text().lower() == "consensus", "and marks where")
    page.fill("#search-input", "zzzz-not-there")
    check(wait_for(page, "document.querySelectorAll('.hit').length === 0 && !!document.querySelector('.drawer-empty')", 3000), "and says so when nothing matches")
    page.fill("#search-input", "consensus")
    wait_for(page, "document.querySelectorAll('.hit').length >= 1", 3000)
    page.screenshot(path=str(out / "06-drawer-dark.png"))
    page.locator(".hit").first.click()
    check(page.locator("#drawer").is_hidden(), "choosing one closes the drawer")
    check(wait_for(page, "!!document.querySelector('.row.flash')", 2500), "and the message is lit where it is")
    page.click("#rail-search")
    check(page.locator("#drawer").is_visible() and page.evaluate("document.activeElement.id") == "search-input", "the search icon opens it with the cursor in the search")
    page.keyboard.press("Escape")
    check(page.locator("#drawer").is_hidden(), "Escape closes it")

    print("the plus and the microphone")
    check(page.evaluate("document.querySelector('#plus-menu') === null"), "the plus has no menu any more")
    with page.expect_file_chooser(timeout=5000) as chooser:
        page.click("#plus")
    check(chooser.value.is_multiple(), "the plus opens the file picker itself, for several files")
    check(page.get_attribute("#plus", "aria-label") == "Attach a file", "and says so")
    check(page.locator("#mic").is_visible() and page.locator("#send").is_hidden(), "with the box empty the round button at the right end is a microphone")
    where = "(() => { const b = document.querySelector('%s'); return [b.offsetLeft, b.offsetTop, b.offsetWidth, b.offsetHeight]; })()"       # layout, not the rectangle on the screen: the pop scales the button for a moment
    mic_box = page.evaluate(where % "#mic")
    page.fill("#input", "a few words")
    check(page.locator("#send").is_visible() and page.locator("#mic").is_hidden(), "with words in the box it is the arrow")
    check(page.evaluate(where % "#send") == mic_box, "in the very same place")
    page.fill("#input", "   ")
    check(page.locator("#mic").is_visible() and page.locator("#send").is_hidden(), "spaces alone are an empty box: the microphone again")
    page.fill("#input", "")

    print("reload and a second tab")
    total = page.locator(".row[data-n]").count()
    page.reload()
    check(wait_for(page, "document.querySelectorAll('.row[data-n]').length > 0"), "after a reload the conversation is still there")
    check(page.locator(".row[data-n]").count() == total, "with every message once", f"{page.locator('.row[data-n]').count()} != {total}")
    check(page.locator(".starter").count() == 0, "and the places to start are not offered again")
    second = context.new_page()
    second.goto(base)
    check(wait_for(second, f"document.querySelectorAll('.row[data-n]').length === {total}"), "a second tab shows the same conversation")
    send(page, "tab one says hello")
    check(wait_for(second, "document.querySelectorAll('.row.user').length === " + str(page.locator('.row.user').count()), 8000), "what one tab sends reaches the other")
    check(wait_for(second, "document.querySelectorAll('.row.assistant[data-n]').length === 8", 10000), "and so does the reply")
    second.close()

    print("themes and screens")
    page.click("#theme")
    check(page.evaluate("document.documentElement.dataset.theme") == "light", "the theme button switches to light")
    page.wait_for_timeout(300)
    page.screenshot(path=str(out / "07-conversation-light.png"))
    page.reload()
    check(wait_for(page, "document.querySelectorAll('.row[data-n]').length > 0") and page.evaluate("document.documentElement.dataset.theme") == "light", "the choice is remembered")
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(400)
    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "on a phone nothing sticks out sideways")
    check(page.locator(".rail").is_hidden(), "the side rail gives way on a phone")
    box = page.locator("#composer").bounding_box()
    check(box is not None and box["y"] + box["height"] <= 844 and box["x"] >= 0 and box["x"] + box["width"] <= 390, "the message box fits the screen")
    # the top: the Chats pill, the face, the call button and the account must all fit, side by side and apart
    top = page.evaluate("""(() => {
        const box = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
        return { chats: box('#chats-btn'), face: box('#avatar-ring'), call: box('#call-btn'), group: box('#call-group'), account: box('#avatar'), name: box('#name-pill') };
    })()""")
    apart = lambda a, b: a["r"] <= b["l"] + 0.5
    check(apart(top["chats"], top["face"]) and apart(top["face"], top["group"]) and apart(top["group"], top["account"]) and top["call"]["l"] >= top["group"]["l"] - 0.5 and top["call"]["r"] <= top["group"]["r"] + 0.5, "on a phone the top has the Chats pill, the face, the call button (with its chevron) and the account in a row, apart", str(top))
    check(top["chats"]["l"] >= 0 and top["account"]["r"] <= 390, "all inside the screen", str(top))
    check(top["call"]["b"] - top["call"]["t"] > 30 and abs((top["call"]["t"] + top["call"]["b"]) / 2 - (top["account"]["t"] + top["account"]["b"]) / 2) < 4, "the call button is as tall as its neighbour and level with it")
    page.screenshot(path=str(out / "08-conversation-phone-light.png"))
    page.click("#chats-btn")
    page.wait_for_timeout(450)                     # it slides in
    check(page.locator("#drawer").is_visible() and page.evaluate("document.querySelector('#drawer').getBoundingClientRect().left") == 0, "Chats opens over the whole phone")
    page.screenshot(path=str(out / "09-drawer-phone-light.png"))
    page.keyboard.press("Escape")
    page.click("#avatar")                          # the rail's sun/moon is not there on a phone: the account menu has it
    check("dark" in page.inner_text("#menu-theme").lower(), "on a phone the account menu offers the other theme")
    page.click("#menu-theme")
    check(page.evaluate("document.documentElement.dataset.theme") == "dark", "and switches to it")
    page.screenshot(path=str(out / "09b-phone-dark.png"))
    page.set_viewport_size({"width": 1280, "height": 800})

    print("signing out")
    page.click("#avatar")
    check(page.locator("#menu").is_visible() and "ada@example.com" in page.inner_text("#menu"), "the account menu shows who is signed in")
    page.click("#signout")
    check(wait_for(page, "document.querySelector('#chat').dataset.mode === 'gate'"), "signing out returns to the sign-in conversation")
    check(page.evaluate("fetch('api/history').then(r => r.status)") == 401, "and the session is really gone")
    check(page.locator(".row[data-n]").count() == 0, "with nothing of the conversation left on the screen")

    print("an address that is not on the list")
    page.evaluate("window.__gsi.credential = 'dev:mallory@example.com'")
    page.wait_for_selector("#fake-google")
    page.click("#fake-google")
    check(wait_for(page, "!!document.querySelector('.gate-note')"), "a stranger is told so, in a bubble")
    note = page.inner_text(".gate-note")
    check("mallory@example.com" in note and "not on my list" in note, "naming the address that was refused", note)
    check(page.evaluate("document.querySelector('#chat').dataset.mode") == "gate", "and is not let in")

    print("a visitor who signs in with a bad token")
    page.evaluate("window.__gsi.credential = 'forged'")
    page.wait_for_selector("#fake-google")
    page.click("#fake-google")
    check(wait_for(page, "document.querySelector('.gate-note') && document.querySelector('.gate-note').textContent.includes('did not work')"), "a forged token is refused with a plain message")
    check(page.evaluate("document.querySelector('#chat').dataset.mode") == "gate", "and does not open the conversation")
    page.screenshot(path=str(out / "10-refused-dark.png"))

    check(not problems, "the page logged no errors", "; ".join(problems[:3]))
    check(not page.evaluate("window.__csp"), "and its content policy refused nothing", str(page.evaluate("window.__csp")))
    context.close()


def run(args, base: str, control: str, off: str) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    mic = fake_microphone(out / "fake-mic.wav")
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=not args.headed, args=[
            "--use-fake-ui-for-media-stream",                      # the microphone prompt says yes by itself
            "--use-fake-device-for-media-stream",
            f"--use-file-for-fake-audio-capture={mic}",            # and the microphone hears the test tone
        ])
        wanted = [name for name in (args.only or "").split(",") if name]
        flows = {flow.__name__: flow for flow in FLOWS}
        unknown = [name for name in wanted if name not in flows and name != "main_flow"]
        if unknown:
            print("no such flow:", unknown, "- there are:", ["main_flow"] + list(flows))
            return 2
        if not wanted or "main_flow" in wanted:
            main_flow(browser, base, out)

        # what the server can switch on, each as another student, in a context of its own
        ctl = Control(control)
        for name, flow in flows.items():
            if wanted and name not in wanted:
                continue
            try:
                flow(browser, base, off, ctl, out)
            except Exception as err:      # a flow that breaks off is a failed check, and the others still run
                check(False, f"{flow.__name__} ran to its end", f"{type(err).__name__}: {str(err)[:1500]}")
        browser.close()
    failed = [what for ok, what in results if not ok]
    print("\n" + f"{len(results) - len(failed)} of {len(results)} checks held" + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else 0


# ---------------------------------------------------------------- what the server can switch on

def student(browser, url: str, address: str, **options):
    """A fresh context (its own cookies), signed in as `address` at `url`; the microphone allowed. `options` change the context (a touch screen, say)."""
    settings = {"viewport": {"width": 1280, "height": 800}, "color_scheme": "dark", "permissions": ["clipboard-read", "clipboard-write", "microphone"], **options}
    context = browser.new_context(**settings)
    context.set_default_timeout(15000)
    context.route("https://accounts.google.com/**", lambda route: route.abort())
    context.add_init_script(FAKE_GOOGLE)
    context.add_init_script(PAGE_PROBE)
    page = context.new_page()
    problems: list[str] = []
    watch(page, problems)
    page.goto(url)
    page.wait_for_selector("#fake-google")
    sign_in(page, address)
    if not wait_for(page, "document.querySelector('#chat').dataset.mode === 'chat'"):
        raise RuntimeError(f"{address} could not sign in")
    return context, page, problems


def clean(page, problems: list[str], who: str) -> None:
    check(not problems, f"{who}: the page logged no errors", "; ".join(problems[:3]))
    check(not page.evaluate("window.__csp"), f"{who}: its content policy refused nothing", str(page.evaluate("window.__csp")))


DROP_JS = r"""
async ([name, bytes, type, only]) => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(bytes)], name, { type }));
  const target = document.querySelector('#scroller');
  const fire = (kind) => { const e = new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: dt }); target.dispatchEvent(e); return e.defaultPrevented; };
  const entered = fire('dragenter');
  const overlay = !document.querySelector('#dropzone').hidden;
  if (only === 'enter') return { entered, overlay };
  fire('dragover');
  const dropped = fire('drop');
  return { entered, overlay, dropped, after: !document.querySelector('#dropzone').hidden };
}
"""

PASTE_JS = r"""
([name, text]) => {
  const dt = new DataTransfer();
  dt.items.add(new File([text], name, { type: 'text/plain' }));
  const e = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
  document.querySelector('#input').dispatchEvent(e);
  return e.defaultPrevented;
}
"""

LAST_USER_BADGE = "(() => { const rows = document.querySelectorAll('.row.user'); const b = rows.length && rows[rows.length - 1].querySelector('.react'); return b ? b.dataset.emoji : ''; })()"


def features_off(browser, base, off, ctl, out):
    print("every new feature switched off (the plain page)")
    context, page, problems = student(browser, off, "dev:dave@example.com")
    features = page.evaluate("fetch('api/me').then(r => r.json()).then(d => d.features)")
    check(not any(features.get(k) for k in ("files", "pictures", "voiceNotes", "voiceCalls")), "the server says nothing new is on", str(features))
    check(page.locator("#plus").is_hidden() and page.locator("#mic").is_hidden() and page.locator("#send").is_visible(), "the attach button and the microphone are not drawn: the message box and send only")
    check(page.locator("#call-btn").is_hidden() and page.locator("#call-more").is_hidden(), "there is no call button, and no chevron beside it")
    check(page.locator(".starter .card-row").count() == 4 and page.locator(".starter [data-call]").count() == 0, "the places to start are the four that need no voice")
    check(page.locator("#tray").is_hidden() and page.locator("#call").is_hidden() and page.locator("#recbar").is_hidden(), "no file tray, call panel or recorder")
    dropped = page.evaluate(DROP_JS, ["notes.md", list(b"# notes"), "text/markdown", ""])
    check(not dropped["entered"] and not dropped["overlay"] and not dropped["dropped"], "a file dragged onto the window is left alone", str(dropped))
    check(not page.evaluate(PASTE_JS, ["notes.md", "# notes"]) and page.locator("#tray").is_hidden(), "and so is a file pasted into the box")
    send(page, "hello from the plain page")
    check(wait_reply(page, 1), "the text chat works as before")
    plain = page.locator(REPLIES).first
    plain_n = int(plain.get_attribute("data-n"))
    plain.hover()
    plain.locator(".act[data-act='react']").click()
    page.locator(".picker .pick[data-emoji='🙏']").click()
    check(page.evaluate(MY_BADGE, plain_n) == "🙏", "an emoji on a reply is part of the plain chat too")
    page.reload()
    check(wait_for(page, f"({MY_BADGE})({plain_n}) === '🙏'"), "and the server keeps it")
    check(features.get("choices") is False, "the server offers no options to tap here", str(features))
    ctl.post("choices?who=dave", json.dumps({"options": ["Every heartbeat starts a new term", "A term has at most one leader"], "quiz": True, "key": 1}))
    check(wait_for(page, "document.querySelectorAll('.row.assistant[data-n]').length === 2", 8000), "TAi asks a question with options")
    check(page.locator(".row.has-choices").count() == 0 and page.locator(".choice").count() == 0 and page.locator(REPLIES).last.inner_text() == "Which of these is true of a Raft term?", "the page that is not offered options shows the question as words alone")
    check(page.evaluate("fetch('api/choose', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tai': '1' }, body: JSON.stringify({ to: 1, index: 0 }) }).then((r) => r.status)") == 404, "and its server takes no tap")
    page.screenshot(path=str(out / "20-features-off-dark.png"))
    clean(page, problems, "the plain page")
    context.close()


def pictures_and_reactions(browser, base, off, ctl, out):
    print("TAi's pictures")
    context, page, problems = student(browser, base, "dev:bob@example.com")
    send(page, "hello there")
    check(wait_reply(page, 1), "bob's first reply arrives")
    ctl.post("image?who=bob")
    check(wait_for(page, "!!document.querySelector('.row.assistant .pic img')"), "a picture from TAi arrives in the conversation")
    row_height = page.evaluate("document.querySelector('.pic').closest('.row').getBoundingClientRect().height")
    frame = page.evaluate("(() => { const r = document.querySelector('.pic').getBoundingClientRect(); return [r.width, r.height]; })()")
    check(wait_for(page, "(() => { const i = document.querySelector('.pic img'); return i.complete && i.naturalWidth > 0; })()"), "the picture loads")
    check(re.fullmatch(r"api/media/[0-9a-f]{32}", page.get_attribute(".pic img", "src") or "") is not None, "from api/media/<its id>, relative to the page's base")
    after = page.evaluate("document.querySelector('.pic').closest('.row').getBoundingClientRect().height")
    frame_after = page.evaluate("(() => { const r = document.querySelector('.pic').getBoundingClientRect(); return [r.width, r.height]; })()")
    check(abs(after - row_height) < 0.5 and frame == frame_after, "its frame had its size before the picture came: nothing moved when it loaded", f"{row_height} -> {after}, {frame} -> {frame_after}")
    one = page.evaluate("(() => { const row = document.querySelector('.pic').closest('.row'); return row.querySelectorAll('.bubble').length === 1 && !!row.querySelector('.bubble .md strong') && row.querySelector('.bubble .md').textContent.includes('Who wins a tie?'); })()")
    check(one, "the picture and its caption (Markdown) are one message")
    check(page.get_attribute(".pic img", "alt") == "Here is a Raft election: the candidate asks the others for their votes.", "the picture's alt text is the caption's first sentence", page.get_attribute(".pic img", "alt") or "")
    check(page.locator(".pic").get_attribute("aria-label", timeout=2000).startswith("Enlarge the picture"), "and its button says it enlarges it")
    shots(page, out, "30-picture")

    page.click(".pic")
    check(page.evaluate("document.querySelector('#lightbox').open"), "a click enlarges the picture")
    check(page.evaluate("document.activeElement.id") == "lightbox-close", "with the focus on its close button")
    check(wait_for(page, "(() => { const i = document.querySelector('#lightbox-img'); return i.naturalWidth > 0 && i.src === document.querySelector('.pic img').src; })()", 4000), "showing the same picture")
    shots(page, out, "31-lightbox")
    page.keyboard.press("Escape")
    check(not page.evaluate("document.querySelector('#lightbox').open"), "Escape closes it")
    check(page.evaluate("document.activeElement.classList.contains('pic')"), "and the focus goes back to the picture")
    page.click(".pic")
    page.mouse.click(40, 400)
    check(not page.evaluate("document.querySelector('#lightbox').open"), "a click anywhere closes it too")

    print("a picture while the reader looks back")
    send(page, "a long answer please")
    check(wait_reply(page, 3), "a long reply arrives")
    page.evaluate("document.querySelector('#scroller').scrollTo({top: 0})")
    page.wait_for_timeout(400)
    ctl.post("image?who=bob")
    check(wait_for(page, "document.querySelectorAll('.pic').length === 2"), "a second picture arrives")
    page.wait_for_timeout(1200)
    check(page.evaluate("document.querySelector('#scroller').scrollTop") < 50, "it does not drag the reader down")
    check(wait_for(page, "!document.querySelector('#jump').hidden", 3000), "the pill says there is more below")
    page.click("#jump")
    check(wait_for(page, "(() => { const i = document.querySelectorAll('.pic img')[1]; return i && i.complete && i.naturalWidth > 0; })()", 6000), "and below, the picture is there")
    ctl.post("image?who=bob&missing=1&caption=" + urllib.parse.quote("This one is gone."))
    check(wait_for(page, "!!document.querySelector('.pic.broken')"), "a picture that cannot be loaded says so, in its frame")
    check("could not be loaded" in page.inner_text(".pic.broken"), "in plain words")

    print("TAi's emoji on a message")
    rows = page.locator(".row[data-n]").count()
    stamps = page.locator(".stamp").count()
    ctl.post("react?who=bob&emoji=" + urllib.parse.quote("🎯"))
    check(wait_for(page, f"{LAST_USER_BADGE} === '🎯'"), "TAi's emoji lands on the corner of the student's message")
    check(page.evaluate("(() => { const rows = document.querySelectorAll('.row.user'); return rows[rows.length - 1].querySelector('.react').classList.contains('pop'); })()"), "with a short pop as it arrives")
    check(page.locator(".row[data-n]").count() == rows and page.locator(".stamp").count() == stamps, "it is not a message: no bubble, no time stamp")
    page.wait_for_timeout(700)                         # the pop scales the badge from 0.2: measure it at rest, not on a slow machine's first frames
    corner = page.evaluate("(() => { const rows = document.querySelectorAll('.row.user'); const b = rows[rows.length - 1].querySelector('.bubble'); const r = b.getBoundingClientRect(), e = b.querySelector('.react').getBoundingClientRect(); return e.left < r.left && e.bottom > r.bottom && e.right > r.left && e.top < r.bottom; })()")
    check(corner, "it sits on the bubble's lower left corner")
    shots(page, out, "32-reaction", focus="(() => { const rows = document.querySelectorAll('.row.user'); rows[rows.length - 1].scrollIntoView({ block: 'center' }); })()")
    ctl.post("react?who=bob&emoji=" + urllib.parse.quote("💡"))
    check(wait_for(page, f"{LAST_USER_BADGE} === '💡'") and page.evaluate("(() => { const rows = document.querySelectorAll('.row.user'); return rows[rows.length - 1].querySelectorAll('.react').length; })()") == 1, "a later emoji on the same message takes the first one's place")
    page.click("#chats-btn")
    count = page.locator(".day-count").first.inner_text()
    check(count == f"{page.locator('.row[data-n]').count()} messages", "the drawer does not count it as a message", count)
    page.fill("#search-input", "💡")
    check(wait_for(page, "document.querySelectorAll('.hit').length === 0", 2000), "nor does its search find it")
    page.keyboard.press("Escape")
    page.evaluate("document.querySelector('#scroller').scrollTo({top: 0})")
    page.wait_for_timeout(500)
    pill = page.evaluate("document.querySelector('#jump').hidden ? '' : document.querySelector('#jump-text').textContent")
    ctl.post("react?who=bob&emoji=" + urllib.parse.quote("👍"))
    check(wait_for(page, f"{LAST_USER_BADGE} === '👍'"), "an emoji arrives while the reader looks back")
    page.wait_for_timeout(400)
    check(page.evaluate("document.querySelector('#jump').hidden ? '' : document.querySelector('#jump-text').textContent") == pill, "and the \"N messages\" pill does not count it", pill)
    page.click("#jump") if pill else page.evaluate("document.querySelector('#scroller').scrollTo({top: 1e9})")
    send(page, "thanks, that helps")
    check(wait_for(page, f"{LAST_USER_BADGE} === '👍'", 8000), "an emoji can be TAi's whole answer")
    check(wait_for(page, "!document.querySelector('.row.typing')", 6000), "and then the dots stop: nothing waits for words that will not come")
    page.reload()
    check(wait_for(page, "document.querySelectorAll('.react').length === 2"), "after a reload the emoji are still there")
    check(page.evaluate("[...document.querySelectorAll('.react')].every((b) => !b.classList.contains('pop') && b.dataset.emoji === '👍')"), "the latest on each message, without the pop")
    check(page.locator(".pic").count() == 3, "and so are the pictures")
    clean(page, problems, "pictures and emoji")
    context.close()


def attachments(browser, base, off, ctl, out):
    print("attaching files")
    context, page, problems = student(browser, base, "dev:bob@example.com")
    uploads: list[str] = []
    releases: list[str] = []                    # the bodies of POST api/upload/release
    page.on("request", lambda r: "api/upload?" in r.url and uploads.append(urllib.parse.unquote(r.url.split("name=")[1].split("&")[0])))
    page.on("request", lambda r: "api/upload/release" in r.url and releases.append(r.post_data or ""))
    with page.expect_file_chooser(timeout=5000) as chooser:
        page.click("#plus")
    check(chooser.value.is_multiple(), "the plus is Attach a file: it opens the picker itself, with no menu in between")
    accept = page.get_attribute("#file-input", "accept") or ""
    check(".go" in accept.split(",") and ".pdf" in accept.split(",") and "image/png" in accept and ".exe" not in accept, "the file picker offers what TAi can read", accept[:120])
    replies = reply_count(page)

    source = b'package main\n\nfunc main() { panic("boom") }\n'
    page.set_input_files("#file-input", files=[{"name": "main.go", "mimeType": "text/plain", "buffer": source}])
    check(wait_for(page, "!!document.querySelector('#tray .chip[data-state=done]')"), "a chosen file goes up at once, and its chip says it is ready")
    check("main.go" in page.inner_text("#tray .chip") and f"{len(source)} B" in page.inner_text("#tray .chip"), "the chip names the file and its size", page.inner_text("#tray .chip"))
    check(not page.is_disabled("#send"), "send is on with a file and no words")
    page.click("#send")
    check(wait_for(page, "(() => { const rows = document.querySelectorAll('.row.user'); const r = rows[rows.length - 1]; return !!r && !!r.querySelector('.file') && r.querySelector('.file-name').textContent === 'main.go'; })()"), "the file goes with the message, as a chip in the student's bubble")
    check(page.locator("#tray").is_hidden(), "and the tray empties")
    check(wait_reply(page, replies + 1), "TAi answers")
    check("I can see what you attached: main.go" in page.locator(REPLIES).last.inner_text() and "package main" in page.locator(REPLIES).last.inner_text(), "naming the file and quoting its first line: it was handed the file", page.locator(REPLIES).last.inner_text()[:160])
    seen = ctl.get("seen?who=bob")
    check(any("/workspace/group/uploads/main.go" in s for s in seen), "(the message it got points at the file in the student's workspace)")

    print("a file on its way")
    ctl.post("upload-delay?ms=2500")
    cdp = context.new_cdp_session(page)
    cdp.send("Network.enable")
    cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 20, "downloadThroughput": 4_000_000, "uploadThroughput": 400_000})
    with page.expect_response(lambda r: "api/upload?name=measurements.csv" in r.url, timeout=40000) as measured:
        page.set_input_files("#file-input", files=[{"name": "measurements.csv", "mimeType": "text/csv", "buffer": b"t,latency_ms\n" + b"1,12\n" * 220_000}])
        check(wait_for(page, "!!document.querySelector('#tray .chip[data-state=uploading]')", 3000), "a file going up shows a spinner and a progress bar")
        page.fill("#input", "here is my data")
        check(page.is_disabled("#send"), "send waits while a file is still going up")
        page.wait_for_timeout(600)
        shots(page, out, "40-upload-in-progress", wait_ms=150)
    check(wait_for(page, "!!document.querySelector('#tray .chip[data-state=done]')", 30000), "and the chip says ready when it is up")
    measured_id = measured.value.json().get("id")
    cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})
    ctl.post("upload-delay?ms=0")
    check(not page.is_disabled("#send"), "then send is on")
    page.click("#tray .chip-x")
    check(page.locator("#tray").is_hidden(), "a chip's x forgets the file")
    check(settle(page, lambda: len(releases) >= 1, 4000) and len(releases) == 1 and json.loads(releases[0]) == {"id": measured_id}, "and gives its upload back: one release, with that file's id", str(releases))
    page.fill("#input", "")
    check(page.is_disabled("#send"), "with nothing left to send, send is off again")

    print("a picture")
    picture = ctl.get("png")
    page.set_input_files("#file-input", files=[{"name": "whiteboard.png", "mimeType": "image/png", "buffer": picture}])
    check(wait_for(page, "(() => { const c = document.querySelector('#tray .chip[data-state=done]'); return !!c && c.querySelector('.chip-thumb img').src.startsWith('blob:'); })()"), "a picture's chip shows the picture (a local preview)")
    replies = reply_count(page)
    send(page, "what is wrong with this diagram?")
    check(wait_for(page, "(() => { const t = [...document.querySelectorAll('.row.user .thumb img')].pop(); return !!t && t.complete && t.naturalWidth > 0 && /^api\\/media\\/[0-9a-f]{32}$/.test(t.getAttribute('src')); })()"), "it shows as a thumbnail in the student's bubble, from api/media")
    check(wait_reply(page, replies + 1) and all(x in page.locator(REPLIES).last.inner_text() for x in ("can't see pictures", "read the text in a picture")), "and TAi is told it can read the text of it (the server kept a copy for its tools) but cannot see it")
    page.locator(".row.user .thumb").last.click()
    check(page.evaluate("document.querySelector('#lightbox').open"), "a thumbnail enlarges too")
    page.keyboard.press("Escape")

    print("what TAi cannot take")
    page.set_input_files("#file-input", files=[{"name": "tool.exe", "mimeType": "application/octet-stream", "buffer": b"MZ\x90\x00"}])
    check(wait_for(page, "!!document.querySelector('#tray .chip[data-state=failed]')", 3000) and page.inner_text("#toast") == "TAi can't read that kind of file.", "a kind of file TAi cannot read is refused in plain words", page.inner_text("#toast"))
    check("tool.exe" not in uploads, "before anything is sent")
    chip = page.inner_text("#tray .chip")
    check(page.locator("#tray .chip[data-state=failed] .chip-x").count() == 1 and "Not attached" in chip and "can't read" in chip, "its chip says why, on itself, and can only be removed", chip)
    page.click("#tray .chip-x")
    page.set_input_files("#file-input", files=[{"name": "huge.txt", "mimeType": "text/plain", "buffer": b"a" * (5 * 1024 * 1024 + 1)}])
    check(wait_for(page, "!!document.querySelector('#tray .chip[data-state=failed]')", 3000) and "5.0 MB" in page.inner_text("#toast") and "huge.txt" not in uploads, "a file over the limit is stopped before it is sent", page.inner_text("#toast"))
    check("5.0 MB" in page.inner_text("#tray .chip"), "and its chip names the limit", page.inner_text("#tray .chip"))
    page.click("#tray .chip-x")
    page.set_input_files("#file-input", files=[{"name": "fake.png", "mimeType": "image/png", "buffer": b"this is not a picture"}])
    check(wait_for(page, "!!document.querySelector('#tray .chip[data-state=failed]')", 5000) and "fake.png" in uploads and page.inner_text("#toast") == "TAi can't read that kind of file.", "what the server refuses (a .png that is not a picture) is said in plain words too")
    shots(page, out, "41-refused-file")
    page.click("#tray .chip-x")
    page.set_input_files("#file-input", files=[{"name": f"part{i}.txt", "mimeType": "text/plain", "buffer": f"part {i}\n".encode()} for i in range(6)])
    check(wait_for(page, "document.querySelectorAll('#tray .chip').length === 5", 3000) and "up to 5" in page.inner_text("#toast"), "no more than five files go with one message")
    check(wait_for(page, "document.querySelectorAll('#tray .chip[data-state=done]').length === 5", 8000), "the five go up")
    shots(page, out, "42-tray")
    send(page, "five parts")
    check(wait_for(page, "(() => { const rows = document.querySelectorAll('.row.user'); return rows[rows.length - 1].querySelectorAll('.file').length === 5; })()"), "and go with the message together")
    shots(page, out, "43-sent-files")

    print("drag and drop, and paste")
    enter = page.evaluate(DROP_JS, ["notes.md", list(b"# my notes\n- raft"), "text/markdown", "enter"])
    check(enter["entered"] and enter["overlay"], "dragging files over the window shows where to drop them")
    shots(page, out, "44-drop", wait_ms=150)
    page.evaluate("() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'x.md')); document.querySelector('#scroller').dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: dt })); }")
    check(page.locator("#dropzone").is_hidden(), "and takes it away when they leave")
    dropped = page.evaluate(DROP_JS, ["notes.md", list(b"# my notes\n- raft"), "text/markdown", ""])
    check(dropped["dropped"] and not dropped["after"], "dropping them attaches them, and the overlay goes", str(dropped))
    check(wait_for(page, "[...document.querySelectorAll('#tray .chip[data-state=done] .chip-name')].some((n) => n.textContent === 'notes.md')", 5000), "the dropped file goes up")
    check(page.evaluate(PASTE_JS, ["trace.log", "panic: runtime error: index out of range"]), "a file pasted into the message box is taken")
    check(wait_for(page, "[...document.querySelectorAll('#tray .chip[data-state=done] .chip-name')].some((n) => n.textContent === 'trace.log')", 5000), "and attached")
    replies = reply_count(page)
    send(page, "two more files")
    check(wait_reply(page, replies + 1) and "notes.md" in page.locator(REPLIES).last.inner_text() and "trace.log" in page.locator(REPLIES).last.inner_text(), "both reach TAi")
    page.reload()
    check(wait_for(page, "document.querySelectorAll('.row.user .file').length === 8 && document.querySelectorAll('.row.user .thumb').length === 1"), "after a reload the files are still shown with their messages")
    check(len(releases) == 1, "removing failed chips and sending files gave nothing back: the one release is the removed ready file's", str(releases))
    clean(page, problems, "attachments")
    context.close()


def upload_release(browser, base, off, ctl, out):
    print("giving uploads back (POST api/upload/release)")
    context, page, problems = student(browser, base, "dev:dave@example.com")
    releases: list[str] = []
    answers: list[int] = []
    page.on("request", lambda r: "api/upload/release" in r.url and releases.append(r.post_data or ""))
    page.on("response", lambda r: "api/upload/release" in r.url and answers.append(r.status))
    ids: list[str] = []
    for i in range(12):           # the server lets ten uploads wait at once: without the releases the eleventh would be refused
        with page.expect_response(lambda r: "api/upload?name=" in r.url) as answer:
            page.set_input_files("#file-input", files=[{"name": f"attempt{i}.txt", "mimeType": "text/plain", "buffer": f"attempt {i}\n".encode()}])
        ids.append((answer.value.json() or {}).get("id", ""))
        if not wait_for(page, "!!document.querySelector('#tray .chip[data-state=done]')", 5000):
            break
        page.click("#tray .chip-x")
        settle(page, lambda: len(answers) == len(ids), 5000)
    check(len(ids) == 12 and all(ids), "twelve files go up and are removed again, one after another", f"{len(ids)} went up")
    check([json.loads(body).get("id") for body in releases] == ids, "each removal sends exactly one release, with that file's id", f"{len(releases)} releases")
    check(answers == [200] * 12, "and the server takes each one", str(answers))
    with page.expect_response(lambda r: "api/upload?name=" in r.url) as answer:
        page.set_input_files("#file-input", files=[{"name": "after.txt", "mimeType": "text/plain", "buffer": b"after twelve rounds\n"}])
    check(answer.value.status == 200 and wait_for(page, "!!document.querySelector('#tray .chip[data-state=done]')", 5000), "after twelve rounds (more than the ten that may wait) the server still takes a file", str(answer.value.status))
    before = len(releases)
    send(page, "here it is")
    check(wait_for(page, "[...document.querySelectorAll('.row.user .file-name')].some((n) => n.textContent === 'after.txt')", 5000), "it goes with a message")
    page.wait_for_timeout(800)
    check(len(releases) == before, "and a file that went with a message is never released")
    page.set_input_files("#file-input", files=[{"name": "tool.exe", "mimeType": "application/octet-stream", "buffer": b"MZ"}])
    wait_for(page, "!!document.querySelector('#tray .chip[data-state=failed]')", 3000)
    page.click("#tray .chip-x")
    page.wait_for_timeout(500)
    check(len(releases) == before, "nor is a file whose upload failed (nothing waits for it)")
    with page.expect_response(lambda r: "api/upload?name=" in r.url) as answer:
        page.set_input_files("#file-input", files=[{"name": "left.txt", "mimeType": "text/plain", "buffer": b"left in the tray\n"}])
    waiting = (answer.value.json() or {}).get("id", "")
    wait_for(page, "!!document.querySelector('#tray .chip[data-state=done]')", 5000)
    page.click("#avatar")
    page.click("#signout")
    check(wait_for(page, "document.querySelector('#chat').dataset.mode === 'gate'", 5000), "signing out with a file still in the tray")
    check(settle(page, lambda: len(answers) == before + 1, 4000) and json.loads(releases[-1]).get("id") == waiting and answers[-1] == 200, "gives that file back while the session still holds", f"{releases[-1:]} {answers[-1:]}")
    clean(page, problems, "giving uploads back")
    context.close()


NOTE_ROWS = "document.querySelectorAll('.row.user.note-row')"
MY_BADGE = "(n) => { const row = document.querySelector(`.row.assistant[data-n='${n}']`); const b = row && row.querySelector(':scope > .bubble > .react.mine'); return b ? b.dataset.emoji : ''; }"
PICKER_OPEN = "!!document.querySelector('#messages .picker')"
JUMP = "(() => { const j = document.querySelector('#jump'); return j.hidden ? 'hidden' : j.classList.contains('is-arrow') ? 'arrow' : 'count: ' + document.querySelector('#jump-text').textContent; })()"
FROM_BOTTOM = "(() => { const sc = document.querySelector('#scroller'); return sc.scrollHeight - sc.scrollTop - sc.clientHeight; })()"


def record_note(page, seconds: float = 1.3) -> None:
    """The student's way to a voice note: the microphone, a moment of talking, send."""
    page.click("#mic")
    if not wait_for(page, "document.querySelector('#recbar').dataset.phase === 'recording'", 6000):
        raise RuntimeError("the recording did not start")
    page.wait_for_timeout(int(seconds * 1000))
    page.click("#rec-send")


def note_time_to_seconds(text: str) -> int:
    minutes, seconds = text.split(":")
    return int(minutes) * 60 + int(seconds)


def voice_notes(browser, base, off, ctl, out):
    print("a voice note")
    context, page, problems = student(browser, base, "dev:hana@example.com")
    words = "How does Raft pick a new leader when the old one fails?"
    ctl.post("transcript", words)
    ctl.post("transcript-fail?on=0")
    before = ctl.get("notes")["count"]
    check(page.locator("#mic").is_visible() and page.locator("#plus").is_visible() and page.locator("#send").is_hidden(), "the microphone is the round button at the right end of the empty message box")
    check(page.get_attribute("#mic", "aria-label") == "Record a voice note", "and says what it does")
    page.click("#mic")
    check(wait_for(page, "document.querySelector('#recbar').dataset.phase === 'recording' && !document.querySelector('#recbar').hidden", 6000), "clicking it records (the browser asks for the microphone the first time)")
    check(page.locator("#composer").is_hidden(), "the recording bar takes the message box's place")
    check(page.evaluate("document.activeElement.id") == "rec-send", "with the focus on its send button")
    order = page.evaluate("['#rec-cancel', '.rec-dot', '#rec-time', '#rec-level', '#rec-send'].map((s) => document.querySelector(s).getBoundingClientRect().left)")
    check(order == sorted(order) and page.get_attribute("#rec-cancel", "aria-label") == "Delete the recording", "a trash button on the left, then a dot, the time, the level, and send on the right", str(order))
    check(page.evaluate("getComputedStyle(document.querySelector('.rec-dot')).animationName") == "blink", "the dot pulses")
    page.wait_for_timeout(1500)
    levels = page.evaluate("[...document.querySelectorAll('#rec-level i')].map((i) => i.style.height)")
    check(len(set(levels)) > 3, "the level indicator moves with the voice", str(levels[-12:]))
    check(page.inner_text("#rec-time") in ("0:01", "0:02") and "3:00" in page.inner_text(".rec-time"), "the timer runs, with the longest a note may be beside it", page.inner_text(".rec-time"))
    shots(page, out, "50-voice-note-recording", wait_ms=150)
    users = page.locator(".row.user").count()
    page.click("#rec-send")
    check(wait_for(page, "document.querySelector('#recbar').hidden && !document.querySelector('#composer').hidden", 3000), "send puts the message box back at once (the recorder only has to hand over its last piece)")
    check(wait_for(page, f"{NOTE_ROWS}.length === 1", 3000) and page.locator(".row.user").count() == users + 1, "and the note is already in the conversation, as the student's own message")
    check(page.locator(".note-row .note-play").is_visible() and page.get_attribute(".note-row .note-wave", "role") == "slider" and re.fullmatch(r"\d:\d\d", page.inner_text(".note-row .note-time")) is not None, "a play button, a waveform that is a slider, and how long it is")
    check(page.evaluate("getComputedStyle(document.querySelector('.note-row .bubble')).backgroundColor") == "rgb(10, 132, 255)", "in the student's blue bubble")
    check(wait_for(page, "!!document.querySelector('.note-row .note-text') && !document.querySelector('.note-row .note-text').hidden", 8000), "the words come back under it")
    check(page.inner_text(".note-row .note-text") == words, "as the transcript, in small text", page.inner_text(".note-row .note-text"))
    check(page.inner_text(".note-row .note-toggle") == "Hide text" and page.get_attribute(".note-row .note-toggle", "aria-expanded") == "true", "a short one is shown, with a Hide text toggle")
    page.click(".note-row .note-toggle")
    check(page.locator(".note-row .note-text").is_hidden() and page.inner_text(".note-row .note-toggle") == "Show text" and page.get_attribute(".note-row .note-toggle", "aria-expanded") == "false", "which hides them, and offers Show text")
    page.click(".note-row .note-toggle")
    check(page.locator(".note-row .note-text").is_visible(), "and shows them again")
    notes = ctl.get("notes")
    check(notes["count"] == before + 1 and notes["last"]["mime"].startswith("audio/webm") and notes["last"]["size"] > 500, "the server heard it as Opus in WebM, whole", str(notes["last"]))
    seconds_said = note_time_to_seconds(page.inner_text(".note-row .note-time"))
    per_second = notes["last"]["size"] / max(seconds_said, 1)
    print(f"       measured: {notes['last']['size']} bytes for a note of about {seconds_said} s: {per_second:.0f} bytes a second, {per_second * 180 / 1e6:.2f} MB for three minutes (the limit is 5 MB)")
    check(per_second * 180 < 5 * 1024 * 1024 / 2, "three minutes of it fit the 5 MB upload limit, with room to spare", f"{per_second * 180 / 1e6:.2f} MB")
    seen = ctl.get("seen?who=hana")
    check(re.fullmatch(r"\[Voice note, 0:0\d\] " + re.escape(words), seen[-1]) is not None, "TAi was sent [Voice note, 0:0x] and the words", seen[-1][:90])
    check(wait_reply(page, 1) and "I heard you say" in page.locator(REPLIES).last.inner_text(), "and answers in text, as to any message")
    check("[Voice note" not in page.locator(".row.user").last.inner_text(), "(the student's bubble does not show TAi's note line)")
    entries = page.evaluate("fetch('api/history').then(r => r.json()).then(d => d.entries.filter((e) => e.kind === 'audio'))")
    check(len(entries) == 1 and entries[0]["role"] == "user" and entries[0]["text"] == words and re.fullmatch(r"[0-9a-f]{32}", entries[0].get("mediaId", "")) is not None and 0 < entries[0]["duration"] < 6, "the history keeps it as an audio line: its recording, its length and its words", str(entries))
    check(len(entries[0].get("peaks", [])) == 48 and max(entries[0]["peaks"]) == 100, "and the bars of its waveform")
    shots(page, out, "51-voice-note", focus="document.querySelector('.note-row').scrollIntoView({ block: 'center' })")

    print("playing it")
    sound = context.new_page()                           # the same student on a second tab: the bubble must turn up there, from the history
    watch(sound, problems)
    sound.goto(base)
    check(wait_for(sound, f"{NOTE_ROWS}.length === 1 && !!document.querySelector('.note-row .note-text')", 8000), "a second tab shows the note, with its words")
    sound.close()
    record_note(page, 3.6)                              # a longer one to play and to seek in
    check(wait_for(page, f"{NOTE_ROWS}.length === 2 && !!document.querySelectorAll('.note-row .note-text')[1]", 8000), "a second, longer note")
    wait_reply(page, 2)
    second_note = page.locator(".note-row").nth(1)
    total = note_time_to_seconds(second_note.locator(".note-time").inner_text())
    check(3 <= total <= 6, "its length is the page's own clock", str(total))
    second_note.locator(".note-play").click()
    check(wait_for(page, "document.querySelectorAll('.note-row')[1].querySelector('.bubble').classList.contains('is-playing')", 4000), "the play button plays it")
    check(second_note.locator(".note-play").get_attribute("aria-label") == "Pause voice note", "and becomes a pause button")
    check(wait_for(page, "Number(document.querySelectorAll('.note-row')[1].querySelector('.note-wave').getAttribute('aria-valuenow')) >= 1", 5000), "the position moves on", second_note.locator(".note-wave").get_attribute("aria-valuenow") or "")
    check(re.fullmatch(r"\d:\d\d of \d:\d\d", second_note.locator(".note-wave").get_attribute("aria-valuetext") or "") is not None, "and says where it is, in words, for a screen reader", second_note.locator(".note-wave").get_attribute("aria-valuetext") or "")
    check(page.evaluate("parseFloat(getComputedStyle(document.querySelectorAll('.note-row')[1].querySelector('.bubble')).getPropertyValue('--p')) > 0"), "and the played part of the waveform is lit")
    second_note.locator(".note-play").click()
    check(wait_for(page, "!document.querySelectorAll('.note-row')[1].querySelector('.bubble').classList.contains('is-playing')", 2000), "pause stops it")
    box = second_note.locator(".note-wave").bounding_box()
    page.mouse.click(box["x"] + box["width"] * 0.75, box["y"] + box["height"] / 2)
    check(wait_for(page, f"Math.abs(Number(document.querySelectorAll('.note-row')[1].querySelector('.note-wave').getAttribute('aria-valuenow')) - {total * 0.75}) <= 1.6", 3000), "a click on the waveform seeks to that part", second_note.locator(".note-wave").get_attribute("aria-valuenow") or "")
    second_note.locator(".note-wave").focus()
    page.keyboard.press("Home")
    check(wait_for(page, "document.querySelectorAll('.note-row')[1].querySelector('.note-wave').getAttribute('aria-valuenow') === '0'", 2000), "Home goes to the start, from the keyboard")
    page.keyboard.press("ArrowRight")
    check(wait_for(page, "Number(document.querySelectorAll('.note-row')[1].querySelector('.note-wave').getAttribute('aria-valuenow')) >= 3", 2000), "and an arrow key moves it on by a few seconds")
    page.keyboard.press("Home")
    page.locator(".note-row").nth(0).locator(".note-play").click()
    page.wait_for_timeout(300)
    second_note.locator(".note-play").click()
    check(wait_for(page, "document.querySelectorAll('.note-row')[1].querySelector('.bubble').classList.contains('is-playing') && !document.querySelectorAll('.note-row')[0].querySelector('.bubble').classList.contains('is-playing')", 3000), "only one note plays at a time")
    second_note.locator(".note-play").click()

    print("a note that is kept: after a reload it is played from the server")
    served: list[tuple[int, str]] = []
    page.on("response", lambda r: "api/media/" in r.url and served.append((r.status, r.headers.get("content-type", ""))))
    page.reload()
    check(wait_for(page, f"{NOTE_ROWS}.length === 2 && document.querySelectorAll('.note-row .note-text').length === 2", 8000), "after a reload both notes are there, with their words")
    check(note_time_to_seconds(page.locator(".note-row").nth(1).locator(".note-time").inner_text()) == total, "and their lengths")
    page.locator(".note-row").nth(1).locator(".note-play").click()
    check(settle(page, lambda: any(status in (200, 206) and kind == "audio/webm" for status, kind in served), 6000), "the recording comes from api/media/<id>, as audio/webm", str(served))
    check(wait_for(page, "Number(document.querySelectorAll('.note-row')[1].querySelector('.note-wave').getAttribute('aria-valuenow')) >= 1", 6000), "and plays")
    page.locator(".note-row").nth(1).locator(".note-play").click()
    box = page.locator(".note-row").nth(1).locator(".note-wave").bounding_box()
    page.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] / 2)
    check(wait_for(page, f"Math.abs(Number(document.querySelectorAll('.note-row')[1].querySelector('.note-wave').getAttribute('aria-valuenow')) - {total * 0.5}) <= 1.6", 4000), "and seeks, from the server", page.locator(".note-row").nth(1).locator(".note-wave").get_attribute("aria-valuenow") or "")
    ctl.post("react?who=hana&emoji=" + urllib.parse.quote("🎯"))
    check(wait_for(page, f"{LAST_USER_BADGE} === '🎯'", 5000), "TAi's emoji can sit on a voice note too")
    page.click("#chats-btn")
    check(page.locator(".day-count").first.inner_text() == f"{page.locator('.row[data-n]').count()} messages", "the drawer counts the notes as messages")
    page.fill("#search-input", "pick a new leader")
    check(wait_for(page, "document.querySelectorAll('.hit').length >= 1", 3000), "and its search finds them by their words")
    page.keyboard.press("Escape")

    print("a note that is not sent")
    count = ctl.get("notes")["count"]
    page.click("#mic")
    wait_for(page, "document.querySelector('#recbar').dataset.phase === 'recording'", 5000)
    page.wait_for_timeout(500)
    page.click("#rec-cancel")
    check(page.locator("#recbar").is_hidden() and page.locator("#composer").is_visible(), "the trash button puts the message box back")
    page.wait_for_timeout(400)
    check(ctl.get("notes")["count"] == count and page.locator(".note-row").count() == 2, "and sends nothing")
    check(page.evaluate("window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))") and page.evaluate("window.__contexts.every((c) => c.state === 'closed')"), "the microphone and the level meter are let go")
    page.click("#mic")
    wait_for(page, "document.querySelector('#recbar').dataset.phase === 'recording'", 5000)
    page.mouse.click(640, 300)                         # the focus is somewhere else now
    page.keyboard.press("Escape")
    check(page.locator("#recbar").is_hidden() and ctl.get("notes")["count"] == count, "Escape cancels it, wherever the focus is")
    check(page.evaluate("window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))"), "(and lets the microphone go)")
    page.click("#mic")
    wait_for(page, "document.querySelector('#recbar').dataset.phase === 'recording'", 5000)
    page.click("#rec-send")
    check(wait_for(page, "!document.querySelector('#toast').hidden && document.querySelector('#toast').textContent.includes('too short')", 3000) and page.locator(".note-row").count() == 2, "a press of the microphone that was not meant (nothing said) is not sent")

    print("a note nobody could make out")
    ctl.post("transcript", "")
    record_note(page, 1.1)
    check(wait_for(page, f"{NOTE_ROWS}.length === 3 && !!document.querySelectorAll('.note-row')[2].querySelector('.note-state') && document.querySelectorAll('.note-row')[2].querySelector('.note-state').textContent === 'No words could be made out.'", 8000), "with no words it says so, under the bubble (and still plays)")
    check(page.locator(".note-row").nth(2).locator(".note-toggle").is_hidden(), "(no text to hide)")
    seen = ctl.get("seen?who=hana")
    check(re.fullmatch(r"\[The student sent a voice note of 0:0\d that could not be transcribed: ask them to type it\]", seen[-1]) is not None, "TAi is told it could not be transcribed, and to ask for it typed", seen[-1])
    check(wait_reply(page, 3) and "could not make out" in page.locator(REPLIES).last.inner_text(), "and does")
    ctl.post("transcript-fail?on=1")
    ctl.post("transcript", words)
    record_note(page, 1.1)
    check(wait_for(page, f"{NOTE_ROWS}.length === 4 && !!document.querySelectorAll('.note-row')[3].querySelector('.note-state')", 8000), "when the transcriber is down the note is still sent and shown")
    page.locator(".note-row").nth(3).locator(".note-play").click()
    check(wait_for(page, "document.querySelectorAll('.note-row')[3].querySelector('.bubble').classList.contains('is-playing')", 4000), "and it can still be played: the recording is not lost")
    page.locator(".note-row").nth(3).locator(".note-play").click()
    check(re.fullmatch(r"\[The student sent a voice note of 0:0\d that could not be transcribed.*\]", ctl.get("seen?who=hana")[-1]) is not None, "TAi is told the same")
    ctl.post("transcript-fail?on=0")

    print("a note whose upload fails")
    wait_reply(page, 4)
    page.route("**/api/voicenote*", lambda route: route.abort())
    record_note(page, 1.1)
    check(wait_for(page, f"{NOTE_ROWS}.length === 5 && document.querySelectorAll('.note-row')[4].querySelector('.bubble').dataset.state === 'failed'", 8000), "a note that does not go says so on its bubble")
    check(page.locator(".note-row").nth(4).locator(".note-state").inner_text().startswith("Not sent.") and page.locator(".note-row").nth(4).locator(".note-retry").is_visible(), "with a button to try again")
    check("check your connection" in page.locator(".note-row").nth(4).locator(".note-state").inner_text().lower() and page.locator(".row.typing").count() == 0, "and why, in plain words, on the bubble (no dots wait for an answer)", page.locator(".note-row").nth(4).locator(".note-state").inner_text())
    shots(page, out, "52-voice-note-failed", focus="document.querySelectorAll('.note-row')[4].scrollIntoView({ block: 'center' })")
    page.unroute("**/api/voicenote*")
    page.locator(".note-row").nth(4).locator(".note-retry").click()
    check(wait_for(page, "document.querySelectorAll('.note-row')[4].querySelector('.bubble').dataset.state === 'ready' && !!document.querySelectorAll('.note-row')[4].querySelector('.note-text')", 8000), "trying again sends it")
    check(page.evaluate("fetch('api/history').then(r => r.json()).then(d => d.entries.filter((e) => e.kind === 'audio').length)") == 5 and not page.locator(".note-row.failed").count(), "once: five notes in the history, none marked as failed")
    check(wait_reply(page, 5), "and TAi answers")

    print("a voice note stops by itself at three minutes")
    timed = context.new_page()
    watch(timed, problems)
    timed.clock.install()
    timed.goto(base)
    wait_for(timed, "document.querySelector('#chat').dataset.mode === 'chat'")
    sent_before = ctl.get("notes")["count"]
    timed.click("#mic")
    wait_for(timed, "document.querySelector('#recbar').dataset.phase === 'recording'", 5000)
    timed.wait_for_timeout(700)
    timed.clock.fast_forward("03:01")
    check(wait_for(timed, "document.querySelector('#recbar').dataset.phase === 'full'", 5000), "after three minutes it stops recording on its own")
    check(timed.inner_text("#rec-time") == "3:00" and timed.locator("#rec-send").is_enabled() and not timed.locator("#recbar").is_hidden(), "and waits, with send ready: nothing is sent that was not asked for")
    check(timed.inner_text("#rec-label").startswith("Longest note reached") and ctl.get("notes")["count"] == sent_before, "saying so")
    shots(timed, out, "53-voice-note-full", wait_ms=150)
    timed.click("#rec-send")
    check(wait_for(timed, "(() => { const t = [...document.querySelectorAll('.note-row .note-time')].pop(); return !!t && t.textContent === '3:00'; })()", 8000), "send sends it, as a note of three minutes")
    check(timed.evaluate("window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')) && window.__contexts.every((c) => c.state === 'closed')"), "(the microphone and the meter are let go when it stops)")
    timed.close()

    print("a note on a phone")
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(300)
    page.click("#mic")
    wait_for(page, "document.querySelector('#recbar').dataset.phase === 'recording'", 5000)
    page.wait_for_timeout(900)
    fits = page.evaluate("(() => { const r = document.querySelector('#recbar').getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth; })()")
    check(fits, "the recording bar fits a phone, and nothing sticks out sideways")
    page.click("#rec-cancel")
    page.locator(".note-row").nth(1).scroll_into_view_if_needed()
    check(page.evaluate("(() => { const b = document.querySelectorAll('.note-row')[1].querySelector('.bubble').getBoundingClientRect(); return b.left >= 0 && b.right <= window.innerWidth; })()"), "and so does a note's bubble")
    page.set_viewport_size({"width": 1280, "height": 800})
    clean(page, problems, "voice notes")
    context.close()


def student_reactions(browser, base, off, ctl, out):
    print("the student's emoji on TAi's messages")
    context, page, problems = student(browser, base, "dev:erin@example.com")
    posts: list[dict] = []
    page.on("request", lambda r: r.method == "POST" and "api/react" in r.url and posts.append(json.loads(r.post_data or "{}")))
    send(page, "hello there")
    check(wait_reply(page, 1), "TAi answers")
    ctl.post("image?who=erin")
    check(wait_for(page, "document.querySelectorAll('.pic').length === 1"), "and draws a diagram")
    check(page.locator(".row.assistant:not([data-n]) .act").count() == 0 and page.locator(".row.assistant:not([data-n]) .react").count() == 0, "the greeting and the card of places to start have no reaction button")
    reply = page.locator(".row.assistant[data-n]").first
    pic = page.locator(".row.assistant:has(.pic)")
    n = int(reply.get_attribute("data-n"))
    button = reply.locator(".act[data-act='react']")
    check(button.count() == 1 and button.get_attribute("aria-label") == "Add a reaction", "each reply has an \"add reaction\" button beside it")
    check(pic.locator(".act[data-act='react']").count() == 1, "(a picture too)")
    page.mouse.move(5, 5)
    page.wait_for_timeout(300)
    opacity = "(row) => getComputedStyle(row.querySelector('.actions')).opacity"
    check(reply.evaluate(opacity) == "0", "it is not there until it is wanted")
    reply.hover()
    check(wait_for(page, "getComputedStyle(document.querySelector('.row.assistant[data-n] .actions')).opacity === '1'", 3000), "hovering the reply shows it, next to copy and quote")
    check([b.get_attribute("data-act") for b in reply.locator(".act").all()] == ["react", "copy", "quote"], "(the smiley first, then copy and quote: no thumbs)")
    page.mouse.move(5, 5)
    button.focus()
    check(wait_for(page, "getComputedStyle(document.querySelector('.row.assistant[data-n] .actions')).opacity === '1'", 3000), "and so does keyboard focus on it")
    page.evaluate("document.activeElement.blur()")

    reply.hover()
    button.click()
    picker = page.locator("#messages .picker")
    check(picker.is_visible() and picker.get_attribute("role") == "group" and picker.get_attribute("aria-label") == "React to this message", "pressing it opens a small row of emoji beside the bubble")
    check([b.inner_text() for b in picker.locator(".pick").all()] == ["👍", "❤️", "😂", "😮", "😢", "🙏"], "six of them: thumbs up, heart, laughing, surprised, sad, thanks")
    check(all((b.get_attribute("aria-label") or "").startswith("React with ") for b in picker.locator(".pick").all()), "each named for a screen reader")
    check(page.evaluate("document.activeElement.classList.contains('pick')") and button.get_attribute("aria-expanded") == "true", "the focus is inside it")
    box, anchor = picker.bounding_box(), reply.locator(".bubble").bounding_box()
    check(abs(box["x"] - anchor["x"]) < 30 and (box["y"] + box["height"] <= anchor["y"] + 1 or box["y"] >= anchor["y"] + anchor["height"] - 1), "next to the bubble: above it or below it, on its side")
    shots(page, out, "90-reaction-picker", focus=f"document.querySelector('.row.assistant[data-n=\"{n}\"]').scrollIntoView({{ block: 'center' }})")
    stamps, rows = page.locator(".stamp").count(), page.locator(".row[data-n]").count()
    picker.locator(".pick[data-emoji='👍']").click()
    check(not page.evaluate(PICKER_OPEN) and button.get_attribute("aria-expanded") == "false", "picking one closes it")
    check(page.evaluate(MY_BADGE, n) == "👍", "and puts it on the corner of TAi's bubble")
    badge = reply.locator(".bubble > .react.mine")
    check(badge.evaluate("(b) => b.classList.contains('pop')") and badge.text_content() == "You reacted 👍", "with a short pop, and the words \"You reacted 👍\" for a screen reader")
    page.wait_for_timeout(700)
    corner = page.evaluate("(() => { const row = document.querySelector('.row.assistant[data-n]'); const r = row.querySelector('.bubble').getBoundingClientRect(), e = row.querySelector('.react.mine').getBoundingClientRect(); return e.right > r.right && e.bottom > r.bottom && e.left < r.right && e.top < r.bottom; })()")
    check(corner, "it sits on the bubble's lower right corner (the mirror of TAi's on the student's)")
    check(posts == [{"to": n, "emoji": "👍"}], "the page told the server", str(posts))
    mine = "fetch('api/history').then(r => r.json()).then(d => d.entries.filter((e) => e.kind === 'react' && e.role === 'user').map((e) => [e.to, e.emoji]))"
    check(page.evaluate(mine) == [[n, "👍"]], "which keeps it in the history, as the student's own line")
    check(page.locator(".row[data-n]").count() == rows and page.locator(".stamp").count() == stamps and page.locator(".row.typing").count() == 0, "it is not a message: no bubble, no time stamp, no dots")
    check(len(ctl.get("seen?who=erin")) == 1, "and TAi was not asked anything")
    shots(page, out, "91-reaction-badge", focus=f"document.querySelector('.row.assistant[data-n=\"{n}\"]').scrollIntoView({{ block: 'center' }})")

    print("the tab's unread count")
    page.evaluate("() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); }")
    check(page.title() == "TAi", "(this tab is behind another one now, and has no count)", page.title())
    other_tab = context.new_page()
    watch(other_tab, problems)
    other_tab.goto(base)
    check(wait_for(other_tab, "document.querySelectorAll('.row.assistant[data-n]').length === 2") and other_tab.evaluate(MY_BADGE, n) == "👍", "a second tab shows the emoji")
    other_tab.locator(f".row.assistant[data-n='{n}']").hover()
    other_tab.locator(f".row.assistant[data-n='{n}'] .act[data-act='react']").click()
    other_tab.locator(".picker .pick[data-emoji='😂']").click()
    check(wait_for(page, f"({MY_BADGE})({n}) === '😂'", 8000), "and changes it here while this tab is behind")
    page.wait_for_timeout(300)
    check(page.title() == "TAi", "an emoji on a message is not an answer: the tab's title gets no (1)", page.title())
    other_tab.locator(f".row.assistant[data-n='{n}']").hover()
    other_tab.locator(f".row.assistant[data-n='{n}'] .act[data-act='react']").click()
    other_tab.locator(".picker .pick[data-emoji='😂']").click()
    check(wait_for(page, f"({MY_BADGE})({n}) === ''", 8000), "(and takes it back)")
    page.evaluate("() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); }")
    other_tab.close()
    page.locator(f".row.assistant[data-n='{n}']").hover()
    button.click()
    page.locator(".picker .pick[data-emoji='👍']").click()
    check(wait_for(page, f"({MY_BADGE})({n}) === '👍'"), "(and it is as it was)")

    print("kept by the server")
    page.reload()
    check(wait_for(page, f"document.querySelectorAll('.row.assistant[data-n]').length === 2") and page.evaluate(MY_BADGE, n) == "👍", "a reload shows it")
    check(page.evaluate(f"!document.querySelector('.row.assistant[data-n=\"{n}\"] .react.mine').classList.contains('pop')"), "(without the pop)")
    second = context.new_page()
    watch(second, problems)
    second.goto(base)
    check(wait_for(second, "document.querySelectorAll('.row.assistant[data-n]').length === 2") and second.evaluate(MY_BADGE, n) == "👍", "and so does a second tab")
    second.locator(f".row.assistant[data-n='{n}']").hover()
    second.locator(f".row.assistant[data-n='{n}'] .act[data-act='react']").click()
    second.locator(".picker .pick[data-emoji='❤️']").click()
    check(wait_for(page, f"({MY_BADGE})({n}) === '❤️'", 8000), "changing it in the second tab changes it in the first, as it happens")
    check(page.locator(".react.mine").count() == 1, "one emoji for a message: the new one took the old one's place")
    second.locator(f".row.assistant[data-n='{n}']").hover()
    second.locator(f".row.assistant[data-n='{n}'] .act[data-act='react']").click()
    check(second.locator(".picker .pick[aria-pressed='true']").get_attribute("data-emoji") == "❤️", "the picker shows which one is there")
    second.locator(".picker .pick[data-emoji='❤️']").click()
    check(second.evaluate(MY_BADGE, n) == "" and wait_for(page, f"({MY_BADGE})({n}) === ''", 8000), "picking the same one again takes it back (in both tabs)")
    check(page.evaluate(mine)[-1] == [n, ""], "and the history says so: an empty emoji")
    page.reload()
    check(wait_for(page, "document.querySelectorAll('.row.assistant[data-n]').length === 2") and page.locator(".react.mine").count() == 0, "after a reload it is gone")
    second.close()

    print("the badge, the keyboard, and the ways out")
    reply.hover()
    button.click()
    page.locator(".picker .pick[data-emoji='😂']").click()
    badge = reply.locator(".bubble > .react.mine")
    badge.click()
    check(page.evaluate(PICKER_OPEN) and page.locator(".picker .pick[aria-pressed='true']").get_attribute("data-emoji") == "😂", "pressing the badge opens the six again")
    page.locator(".picker .pick[data-emoji='😂']").click()
    check(reply.locator(".react.mine").count() == 0, "and the same one takes it back")
    button.focus()
    page.keyboard.press("Enter")
    check(page.evaluate(PICKER_OPEN) and page.evaluate("document.activeElement.classList.contains('pick')"), "from the keyboard, Enter on the button opens it with the focus inside")
    page.keyboard.press("ArrowRight")
    check(page.evaluate("document.activeElement.dataset.emoji") == "❤️", "the arrow keys move along the six")
    page.keyboard.press("End")
    check(page.evaluate("document.activeElement.dataset.emoji") == "🙏", "(End goes to the last)")
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("Enter")
    check(page.evaluate(MY_BADGE, n) == "😮" and not page.evaluate(PICKER_OPEN), "Enter picks")
    check(page.evaluate("document.activeElement.dataset.act") == "react", "and the focus goes back to the button")
    page.keyboard.press("Enter")
    page.keyboard.press("Escape")
    check(not page.evaluate(PICKER_OPEN) and page.evaluate("document.activeElement.dataset.act") == "react" and page.evaluate(MY_BADGE, n) == "😮", "Escape closes it without picking, and the focus goes back")
    page.keyboard.press("Enter")
    page.keyboard.press("Tab")
    check(not page.evaluate(PICKER_OPEN) and page.evaluate("document.activeElement.dataset.act") == "react", "so does Tab (back to the button: the six are for the arrow keys)")
    reply.hover()
    button.click()
    page.mouse.click(1000, 300)
    check(not page.evaluate(PICKER_OPEN), "a click anywhere else closes it")
    button.click()
    page.locator(".row.assistant:has(.pic) .act[data-act='react']").click()
    check(page.locator("#messages .picker").count() == 1 and page.evaluate(PICKER_OPEN), "only one set of six is open at a time")
    page.keyboard.press("Escape")

    print("a picture can be reacted to too")
    pic.hover()
    pic.locator(".act[data-act='react']").click()
    page.locator(".picker .pick[data-emoji='🙏']").click()
    pn = int(pic.get_attribute("data-n"))
    check(wait_for(page, f"({MY_BADGE})({pn}) === '🙏'") and pic.locator(".bubble.has-pic > .react.mine").count() == 1, "on the picture's bubble")
    check(posts[-1] == {"to": pn, "emoji": "🙏"}, "and it went to the server", str(posts[-1]))

    print("what TAi hears of them")
    check(len(ctl.get("seen?who=erin")) == 1, "so far TAi has heard nothing: they are not messages")
    page.click("#chats-btn")
    check(page.locator(".day-count").first.inner_text() == f"{page.locator('.row[data-n]').count()} messages", "the drawer does not count them as messages")
    page.fill("#search-input", "😮")
    check(wait_for(page, "document.querySelectorAll('.hit').length === 0", 2000), "nor does its search find them")
    page.keyboard.press("Escape")
    send(page, "tell me more about it")
    check(wait_reply(page, 3), "the next message is answered as any")
    heard = ctl.get("seen?who=erin")[-1].split("\n")
    check(len(heard) == 3 and heard[0].startswith('[The student reacted 😮 to your earlier message: "Good place to dig. What do you already know about') and heard[1].startswith('[The student reacted 🙏 to your earlier message: "Here is a Raft election') and heard[2] == "tell me more about it", "goes ahead of it with a line for each, for TAi only", str(heard))
    check(page.locator(".row.user").last.inner_text() == "tell me more about it", "the student's own bubble shows only what they wrote")
    check(page.locator(REPLIES).last.inner_text().startswith('Good place to dig. What do you already know about "tell me more about it"'), "(TAi answered the message, not the lines)")
    send(page, "and one more")
    check(wait_reply(page, 4) and ctl.get("seen?who=erin")[-1] == "and one more", "told once: the next message has no lines")
    shots(page, out, "92-reaction-after", focus=f"document.querySelector('.row.assistant[data-n=\"{n}\"]').scrollIntoView({{ block: 'center' }})")
    clean(page, problems, "the student's emoji")
    context.close()


def touch_reactions(browser, base, off, ctl, out):
    print("reacting on a touch screen")
    context, page, problems = student(browser, base, "dev:frank@example.com", viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2)
    check(page.evaluate("matchMedia('(hover: none)').matches"), "(this browser is a touch screen: nothing to hover)")
    posts: list[dict] = []
    page.on("request", lambda r: r.method == "POST" and "api/react" in r.url and posts.append(json.loads(r.post_data or "{}")))
    send(page, "hello there")
    check(wait_reply(page, 1), "TAi answers")
    reply = page.locator(".row.assistant[data-n]").first
    n = int(reply.get_attribute("data-n"))
    check(reply.evaluate("(row) => getComputedStyle(row.querySelector('.actions')).opacity") == "1" and reply.locator(".act[data-act='react']").is_visible(), "the reaction button is simply there beside the reply: no hovering on a touch screen")
    check(not reply.locator(".act[data-act='copy']").is_visible(), "(copy and quote need more room than a phone has)")
    box = reply.locator(".bubble").bounding_box()
    check(box["x"] + box["width"] <= 390 - 16, "and the bubble still fits next to it")
    reply.locator(".act[data-act='react']").tap()
    check(page.evaluate(PICKER_OPEN), "a tap on it opens the six")
    fits = page.evaluate("(() => { const r = document.querySelector('#messages .picker').getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; })()")
    check(fits, "which fit the screen")
    page.screenshot(path=str(out / "93-touch-picker-dark-phone.png"))
    page.locator(".picker .pick[data-emoji='❤️']").tap()
    check(page.evaluate(MY_BADGE, n) == "❤️" and posts == [{"to": n, "emoji": "❤️"}], "a tap on an emoji picks it")
    page.wait_for_timeout(700)
    page.screenshot(path=str(out / "94-touch-badge-dark-phone.png"))
    reply.locator(".bubble > .react.mine").tap()
    page.locator(".picker .pick[data-emoji='❤️']").tap()
    check(page.evaluate(MY_BADGE, n) == "", "and the badge takes it back")

    print("a long press")
    cdp = context.new_cdp_session(page)

    def finger(kind: str, x: float, y: float) -> None:
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [] if kind == "touchEnd" else [{"x": x, "y": y}]})

    bubble = reply.locator(".bubble").bounding_box()
    x, y = bubble["x"] + 30, bubble["y"] + bubble["height"] / 2
    finger("touchStart", x, y)
    page.wait_for_timeout(150)
    finger("touchEnd", x, y)
    page.wait_for_timeout(700)
    check(not page.evaluate(PICKER_OPEN), "a short touch on the bubble does nothing")
    finger("touchStart", x, y)
    page.wait_for_timeout(120)
    finger("touchMove", x, y + 40)
    page.wait_for_timeout(700)
    finger("touchEnd", x, y + 40)
    check(not page.evaluate(PICKER_OPEN), "neither does a finger that moves (that is a scroll)")
    finger("touchStart", x, y)
    page.wait_for_timeout(750)
    check(page.evaluate(PICKER_OPEN), "a long press on the bubble opens the six")
    held = page.evaluate("(() => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); document.querySelector('.row.assistant[data-n] .bubble').dispatchEvent(e); return e.defaultPrevented; })()")
    finger("touchEnd", x, y)
    check(held, "(the browser's own menu for a long press is held back for that press)")
    page.wait_for_timeout(1300)
    later = page.evaluate("(() => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); document.querySelector('.row.assistant[data-n] .bubble').dispatchEvent(e); return e.defaultPrevented; })()")
    check(not later, "and only for that press")
    check(page.evaluate(PICKER_OPEN), "the six stay open when the finger lifts")
    page.locator(".picker .pick[data-emoji='😢']").tap()
    check(page.evaluate(MY_BADGE, n) == "😢", "and a tap picks")
    reply.locator(".bubble").tap()
    page.wait_for_timeout(300)
    check(not page.evaluate(PICKER_OPEN), "a tap elsewhere closes the six")
    greeting = page.locator(".row.assistant:not([data-n]) .bubble").first.bounding_box()
    finger("touchStart", greeting["x"] + 30, greeting["y"] + greeting["height"] / 2)
    page.wait_for_timeout(750)
    finger("touchEnd", greeting["x"] + 30, greeting["y"] + greeting["height"] / 2)
    check(not page.evaluate(PICKER_OPEN), "a long press on the greeting does nothing: it is not a message of TAi's to react to")
    page.evaluate("document.documentElement.dataset.theme = 'light'")
    page.wait_for_timeout(300)
    reply.scroll_into_view_if_needed()
    page.screenshot(path=str(out / "94-touch-badge-light-phone.png"))
    clean(page, problems, "the touch screen")
    context.close()


def jump_pill(browser, base, off, ctl, out):
    print('the "new messages" pill')
    context, page, problems = student(browser, base, "dev:gina@example.com")
    for i in range(3):
        send(page, "a long answer please")
        check(wait_reply(page, i + 1), f"a long answer arrives ({i + 1})")
    check(page.evaluate(JUMP) == "hidden", "at the bottom there is nothing")
    page.evaluate("document.querySelector('#scroller').scrollTo({top: 0})")
    check(wait_for(page, f"{JUMP} === 'arrow'", 3000), "scrolled up from the bottom with everything seen, it is a plain arrow")
    check(page.inner_text("#jump-text") == "" and page.get_attribute("#jump", "aria-label") == "Scroll to the latest message" and page.evaluate("document.querySelector('#jump').tagName") == "BUTTON", "a button with no words, named for a screen reader")
    size = page.locator("#jump").bounding_box()
    check(abs(size["width"] - size["height"]) < 1 and size["width"] >= 40, "and round", str(size))
    check(page.inner_text("#jump-live") == "", "(nothing is announced for it)")
    shots(page, out, "95-jump-arrow")

    print("new messages while the reader looks back")
    ctl.post("say?who=gina&text=" + urllib.parse.quote("The first thing TAi says."))
    check(wait_for(page, f"{JUMP} === 'count: 1 new message'", 5000), "one that comes while the reader is up there is \"1 new message\"")
    check(page.get_attribute("#jump", "aria-label") is None and page.locator("#jump svg").is_visible(), "with the arrow beside the words")
    check(page.inner_text("#jump-live") == "1 new message" and page.get_attribute("#jump-live", "aria-live") == "polite", "which is announced politely")
    ctl.post("say?who=gina&text=" + urllib.parse.quote("The second thing."))
    ctl.post("say?who=gina&text=" + urllib.parse.quote("The third thing."))
    check(wait_for(page, f"{JUMP} === 'count: 3 new messages'", 5000), "three are \"3 new messages\"")
    check(page.evaluate("document.querySelector('#scroller').scrollTop") < 50, "the page did not drag the reader down")
    shots(page, out, "96-jump-count")

    print("what does not count")
    ctl.post("typing?who=gina&on=1")
    page.wait_for_timeout(500)
    check(page.evaluate(JUMP) == "count: 3 new messages", "TAi's typing dots never count")
    ctl.post("typing?who=gina&on=0")
    other = context.new_page()
    watch(other, problems)
    other.goto(base)
    wait_for(other, "document.querySelectorAll('.row[data-n]').length > 0")
    users = page.locator(".row.user").count()
    send(other, "thanks, from my other tab")
    check(wait_for(page, f"document.querySelectorAll('.row.user').length === {users + 1}", 8000), "the student's own message, sent in another tab, arrives")
    check(page.evaluate(JUMP) == "count: 3 new messages", "and is not counted")
    check(wait_for(page, f"{LAST_USER_BADGE} === '👍'", 8000), "TAi answers it with an emoji only")
    page.wait_for_timeout(300)
    check(page.evaluate(JUMP) == "count: 3 new messages", "which is not counted either")
    other.close()

    print("seen")
    page.evaluate("""(() => {
        const rows = [...document.querySelectorAll('.row.assistant[data-n]')].slice(-3);
        const sc = document.querySelector('#scroller');
        sc.scrollTop += rows[0].getBoundingClientRect().bottom - sc.getBoundingClientRect().bottom + 4;
    })()""")
    check(wait_for(page, f"{JUMP} === 'count: 2 new messages'", 3000), "a message is seen once its bottom edge has been in view: scrolling down to the first, 2 are left")
    check(page.inner_text("#jump-live") == "2 new messages", "(and said so)")
    page.evaluate("document.querySelector('#scroller').scrollTo({top: 1e9})")
    check(wait_for(page, f"{JUMP} === 'hidden'", 3000) and page.inner_text("#jump-live") == "", "scrolling to the bottom by hand clears the count, and the pill")
    page.evaluate("document.querySelector('#scroller').scrollTo({top: 0})")
    check(wait_for(page, f"{JUMP} === 'arrow'", 3000), "(and looking back up, they stay seen: an arrow, not a count)")
    for away, wanted in ((60, "hidden"), (100, "arrow")):
        page.evaluate("(d) => { const sc = document.querySelector('#scroller'); sc.scrollTop = sc.scrollHeight - sc.clientHeight - d; }", away)
        check(wait_for(page, f"{JUMP} === '{wanted}'", 3000), f"{away} px above the bottom: {'nothing yet' if wanted == 'hidden' else 'the arrow'}")

    print("the arrow, and the count, take the reader down")
    page.evaluate("document.querySelector('#scroller').scrollTo({top: 0})")
    wait_for(page, f"{JUMP} === 'arrow'", 3000)
    start = page.evaluate("document.querySelector('#scroller').scrollTop")
    page.click("#jump")
    states, tops = [], []
    for _ in range(14):
        states.append(page.evaluate(JUMP))
        tops.append(page.evaluate("document.querySelector('#scroller').scrollTop"))
        page.wait_for_timeout(45)
    check(all(s == "hidden" for s in states), "the arrow is gone as soon as it is pressed (it does not flicker back while the page glides)", str(states))
    check(any(start + 5 < t < max(tops) - 5 for t in tops), "and the page glides down: it does not jump", str(tops))
    check(wait_for(page, f"{FROM_BOTTOM} < 3", 4000), "to the latest message")
    page.evaluate("document.querySelector('#scroller').scrollTo({top: 0})")
    wait_for(page, f"{JUMP} === 'arrow'", 3000)
    ctl.post("say?who=gina&text=" + urllib.parse.quote("Another one."))
    ctl.post("say?who=gina&text=" + urllib.parse.quote("And another."))
    check(wait_for(page, f"{JUMP} === 'count: 2 new messages'", 5000), "two more arrive")
    page.click("#jump")
    check(wait_for(page, f"{JUMP} === 'hidden' && {FROM_BOTTOM} < 3", 4000) and page.inner_text("#jump-live") == "", "the count takes the reader to the bottom, and goes")
    ctl.post("say?who=gina&text=" + urllib.parse.quote("One while I am reading the latest."))
    page.wait_for_timeout(900)
    check(page.evaluate(JUMP) == "hidden" and wait_for(page, f"{FROM_BOTTOM} < 3", 3000), "a message that comes while the reader is at the bottom shows nothing, and the page follows it")
    page.evaluate("document.querySelector('#scroller').scrollTo({top: 0})")
    ctl.post("say?who=gina&text=" + urllib.parse.quote("Unseen at the time of the reload."))
    wait_for(page, f"{JUMP} === 'count: 1 new message'", 5000)
    page.reload()
    wait_for(page, "document.querySelectorAll('.row[data-n]').length > 0")
    page.wait_for_timeout(500)
    check(page.evaluate(JUMP) == "hidden", "after a reload (at the bottom again) there is no count")
    clean(page, problems, "the pill")
    context.close()


def call_state(page) -> str:
    return page.evaluate("document.querySelector('#call').dataset.state")


def voice_call(browser, base, off, ctl, out):
    print("a voice call")
    context, page, problems = student(browser, base, "dev:bob@example.com")
    sockets: list[str] = []
    page.on("websocket", lambda ws: sockets.append(ws.url))
    ctl.post("voice/reset")
    check(page.locator("#call-btn").is_visible() and page.evaluate("(() => { const b = document.querySelector('#call-btn'); const g = b.parentElement; return g.id === 'call-group' && g.parentElement.classList.contains('topbar-right') && g.nextElementSibling.id === 'account'; })()"), "a round call button sits at the top right, just before the account pill (with its small chevron)")
    check(page.locator("#composer #call-btn").count() == 0 and page.get_attribute("#call-btn", "aria-label") == "Start a voice call with TAi" and page.get_attribute("#call-btn", "title") == "Voice call", "no longer beside send, with the same name and tooltip")
    shots(page, out, "58-call-button-top")
    page.click("#call-btn")
    check(page.locator("#call").is_visible(), "it opens the call panel")
    check(page.evaluate("document.querySelector('#call').closest('dialog') === null") and not page.is_disabled("#input"), "a panel above the message box, not a dialog: the chat stays usable")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'listening'", 8000), "the call connects and listens")
    check(page.get_attribute("#call-state", "aria-live") == "polite" and page.inner_text("#call-state") == "Listening", "its state is spoken to screen readers (aria-live)")
    check(page.locator("#call-btn").is_hidden(), "the call button steps aside while the call is on")
    check(sockets and sockets[0].endswith("/api/voice"), "the socket is the page's own /api/voice", str(sockets))
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'speaking'", 4000), "TAi speaks: the panel follows the server's status")
    check(wait_for(page, "[...document.querySelectorAll('.row.speech.tai')].some((r) => r.textContent.includes('Hi Bob'))", 3000), "its words appear in the conversation, as a spoken line of its own")
    check(wait_for(page, "parseFloat(getComputedStyle(document.querySelector('#call')).getPropertyValue('--out')) > 0.05", 3000), "the orb follows how loud TAi is while it speaks")
    check(wait_for(page, "parseInt(document.querySelector('#call').dataset.queued, 10) > 0", 3000), "its voice is queued for playback")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'listening' && document.querySelector('#call').dataset.queued === '0'", 6000), "it is played out, and the call listens again")

    print("the call in the page")
    place_of = page.evaluate("""(() => {
      const box = (s) => document.querySelector(s).getBoundingClientRect();
      const call = box('#call'), orb = box('#call .orb'), composer = box('#composer'), dock = box('.dock-inner'), thread = box('.thread');
      return { aboveBox: call.bottom <= composer.top + 1, orbWide: document.querySelector('#call .orb').offsetWidth, centred: Math.abs((orb.left + orb.right) / 2 - (dock.left + dock.right) / 2) < 3,
               nearBox: composer.top - call.bottom < 30, threadEnds: thread.bottom <= call.top + 1 };
    })()""")
    check(place_of["aboveBox"] and place_of["nearBox"] and place_of["centred"], "an orb sits at the bottom, centred, just above the message box", str(place_of))
    check(place_of["orbWide"] == 140 and place_of["threadEnds"], "140 px across, and the conversation ends above it: it never covers the last line", str(place_of))
    check(page.locator("#composer #call-mute").is_visible() and page.locator("#composer #call-end").is_visible(), "the call's two buttons are in the message box, at its right")
    check(page.locator("#mic").is_hidden() and page.locator("#send").is_hidden() and page.locator("#plus").is_visible() and page.get_attribute("#input", "placeholder") == "Type", "in the place of the microphone and the arrow; the plus stays, and the box says Type")
    check(page.locator("#call-timer").is_visible() and re.fullmatch(r"\d+:\d\d · \d+:\d\d left", page.inner_text("#call-timer")) is not None, "under the orb: its state, and the time used and left", page.inner_text("#call-timer"))
    check(page.locator("#call-badge").is_hidden() and page.locator("#captions").count() == 0, "no badge for a plain call, and no captions: the conversation is where the words are")
    start_mark = page.locator(".row.call-mark[data-event='start']")
    check(start_mark.count() == 1 and re.fullmatch(r"Voice call · .+", start_mark.inner_text()) is not None, "the start of the call is a small divider in the conversation, with the time", start_mark.inner_text() if start_mark.count() else "")
    tai_line = page.locator(".row.speech.tai").first
    check(tai_line.locator(".say-glyph").get_attribute("aria-label") == "Spoken" and page.locator(".row.user .say-glyph").count() == 0, "a spoken line carries a small waveform that typed ones do not")
    check(tai_line.get_attribute("aria-live") == "off", "and is not read out again by a screen reader (the call said it aloud)")
    check(tai_line.locator(".act[data-act='react']").count() == 0 and tai_line.locator(".act[data-act='quote']").count() == 0 and tai_line.locator(".act[data-act='copy']").count() == 1, "no smiley on it, no quote: it can be copied")

    ctl.post("voice/reset")
    page.wait_for_timeout(3200)
    st = ctl.get("voice")
    check(st["frames"] >= 60 and set(st["sizes"]) == {"1280"}, "the browser streams the microphone in frames of 1280 bytes", f"{st['frames']} frames, sizes {st['sizes']}")
    check(22 <= st["fps"] <= 28, "25 of them a second: 40 ms of 16 kHz audio each", f"{st['fps']:.1f}/s")
    check(st["rms"] > 0.02, "carrying the sound, not silence", f"rms {st['rms']:.3f}")
    check(400 <= st["pitch"] <= 480, "resampled to 16 kHz at the right ratio: the 440 Hz test tone arrives at 440 Hz", f"{st['pitch']:.0f} Hz")
    check(float(page.evaluate("getComputedStyle(document.querySelector('#call')).getPropertyValue('--mic')") or 0) > 0, "the orb follows the student's voice")
    shots(page, out, "60-call-listening")

    users = page.locator(".row.user").count()
    send(page, "my leader keeps changing")
    check(settle(page, lambda: "my leader keeps changing" in ctl.get("voice")["injected"], 5000), "what the student types during the call joins it (the server hands it to the call, not to the text agent)")
    check(page.locator(".row.user").count() == users + 1 and page.locator(".row.speech.you").count() == 0, "it shows in the chat as a typed message, not as a line of speech")
    page.wait_for_timeout(1200)
    check(page.locator(".row.typing").count() == 0, "and no dots wait for a written reply: the answer comes by voice")
    check(wait_for(page, "[...document.querySelectorAll('.row.speech.tai')].some((r) => r.textContent.includes('You wrote')) && document.querySelector('#call').dataset.state === 'listening'", 6000), "TAi answers it by voice, and its words are in the conversation")
    ctl.post("voice/status?who=bob&state=speaking")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'speaking'", 3000), "(TAi speaking)")
    shots(page, out, "61-call-speaking")
    ctl.post("voice/status?who=bob&state=working")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'working' && document.querySelector('#call-state').textContent === 'Looking that up…'", 3000), "a slow tool call shows as Looking that up")
    ctl.post("voice/status?who=bob&state=thinking")
    check(wait_for(page, "document.querySelector('#call-state').textContent === 'Thinking…'", 3000), "and thinking as Thinking")
    pictures = page.locator(".pic").count()
    ctl.post("image?who=bob")
    check(wait_for(page, f"document.querySelectorAll('.pic').length === {pictures + 1}", 5000), "a diagram TAi draws during the call arrives in the chat")
    ctl.post("voice/status?who=bob&state=listening")

    print("talking over TAi")
    ctl.post("voice/interrupt?who=bob&after=900")
    check(wait_for(page, "parseInt(document.querySelector('#call').dataset.queued, 10) > 1500", 3000), "TAi talks at length: seconds of speech are queued")
    peak = time.time()
    emptied = wait_for(page, "document.querySelector('#call').dataset.queued === '0'", 3000)
    check(emptied and time.time() - peak < 1.6, "agent_interrupted empties the queue at once (not after the four seconds of speech)", f"{time.time() - peak:.2f} s")

    print("the interviewer")
    orb_chat = page.evaluate("getComputedStyle(document.querySelector('.orb-core')).backgroundImage")
    ctl.post("voice/interviewer?who=bob")
    check(wait_for(page, "document.querySelector('#call').dataset.mode === 'interviewer' && !document.querySelector('#call-badge').hidden", 3000), "the switch to the interviewer shows a Mock interview badge")
    check(page.evaluate("getComputedStyle(document.querySelector('.orb-core')).backgroundImage") != orb_chat, "and changes the orb's colour")
    check(wait_for(page, "/interview \\d+:\\d\\d left/.test(document.querySelector('#call-timer').textContent)", 3000), "the timer shows the interview's time left", page.inner_text("#call-timer"))
    check(wait_for(page, "[...document.querySelectorAll('.row.call-mark[data-event=\"mode\"]')].some((r) => r.textContent === 'Switched to Mock interview')", 4000), "and the conversation says so in a small divider: Switched to Mock interview")
    wait_for(page, "document.querySelector('#call').dataset.state === 'listening'", 4000)
    shots(page, out, "62-call-interviewer")

    print("mute")
    page.click("#call-mute")
    check(page.get_attribute("#call-mute", "aria-pressed") == "true" and page.inner_text("#call-state") == "You are muted", "mute shows, on the button and in the state")
    page.wait_for_timeout(300)
    f1 = ctl.get("voice")["frames"]
    page.wait_for_timeout(1000)
    f2 = ctl.get("voice")["frames"]
    check(f2 - f1 <= 1, "and while muted no sound leaves the browser", f"{f2 - f1} frames in a second")
    check(ctl.get("voice")["mutes"][-1:] == [True], "the server is told")
    muted_look = page.evaluate("(() => [getComputedStyle(document.querySelector('#call-mute')).backgroundColor, getComputedStyle(document.querySelector('#call .orb-slash')).opacity, getComputedStyle(document.querySelector('#call .orb-core')).filter])()")
    check(muted_look[0] == "rgb(229, 72, 77)" and muted_look[1] == "1" and "grayscale" in muted_look[2], "the mute button is red, and the orb goes grey with a slash across it", str(muted_look))
    shots(page, out, "63-call-muted", wait_ms=150)
    page.click("#call-mute")
    page.wait_for_timeout(1200)
    check(ctl.get("voice")["frames"] - f2 >= 20, "unmuting streams again")

    print("the message box in a call")
    check(page.locator("#mic").is_hidden() and page.locator("#recbar").is_hidden(), "no microphone for voice notes while the call is on: the call's own buttons are in its place")
    page.fill("#input", "one more thing")
    check(page.locator("#send").is_visible() and page.locator("#send").is_enabled() and page.locator("#call-mute").is_visible() and page.locator("#call-end").is_visible(), "with something typed the arrow comes back, beside the call's buttons")
    page.fill("#input", "")
    check(page.locator("#send").is_hidden() and page.locator("#mic").is_hidden(), "and goes again when the box is empty")
    wait_for(page, "document.querySelector('#call').dataset.state === 'listening'", 8000)

    print("a dropped connection")
    ctl.post("voice/resume-delay?ms=4000")
    ctl.post("voice/drop?who=bob")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'reconnecting' && document.querySelector('#call-state').textContent === 'Reconnecting…'", 3000), "a dropped connection says it is reconnecting")
    shots(page, out, "64-call-reconnecting", wait_ms=120)
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'listening'", 15000), "and the call is taken up again")
    starts = ctl.get("voice")["starts"]
    check(starts[-1]["resume"] is True and starts[-1]["mode"] == "chat", "with {type: start, resume: true}", str(starts[-1]))
    ctl.post("voice/notice?who=bob&text=" + urllib.parse.quote("Dropped image: I cannot see images"))
    check(wait_for(page, "document.querySelector('#toast').textContent === 'Dropped image: I cannot see images'", 3000), "a notice from the call is shown")

    print("hanging up")
    page.click("#call-end")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'ended' && document.querySelector('#call-state').textContent.startsWith('Call ended.')", 5000), "End call ends it", page.inner_text("#call-state"))
    check(page.locator("#call .orb").is_hidden() and page.locator("#call-actions").is_hidden() and page.locator("#mic").is_visible() and page.get_attribute("#input", "placeholder") == "Message", "the orb's room collapses and the message box is its own again")
    check(wait_for(page, "!!document.querySelector('.row.call-mark[data-event=\"end\"]')", 5000) and re.fullmatch(r"Call ended · \d+ (s|min)", page.locator(".row.call-mark[data-event='end']").inner_text()) is not None, "the end of the call is a divider in the conversation, with how long it was", page.locator(".row.call-mark[data-event='end']").inner_text())
    check(ctl.get("voice")["ends"] >= 1 and not ctl.get("voice")["live"], "the server is told and the call is gone there")
    check(page.evaluate("window.__streams.length > 0 && window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))"), "the microphone is let go")
    check(wait_for(page, "window.__contexts.length > 0 && window.__contexts.every((c) => c.state === 'closed')", 3000), "and so is the audio context")
    check(wait_for(page, "!!document.querySelector('.row.activity[data-type=\"interview\"]')", 6000), "the call's account arrives in the chat as a compact card, at its place")
    card = page.locator(".row.activity[data-type='interview']")
    check(card.count() == 1 and page.locator(".voice-tag").count() == 0 and page.locator(".row.assistant:has(.acard)").count() == 0, "one card: no headset bubble, and it is not one of TAi's replies")
    check(card.get_attribute("data-type") == "interview" and card.locator(".acard-title").inner_text().startswith("Mock interview · ") and card.locator(".acard-text").inner_text().startswith("Mock interview on Raft"), "titled for what the call ended as (the interviewer had taken it over), with one line of what it was about", card.inner_text())
    check(card.locator(".act[data-act='react']").count() == 0 and card.locator(".act[data-act='copy']").count() == 0 and card.locator(".act[data-act='quote']").count() == 0, "it cannot be reacted to, copied or quoted: it is a record of the call, not something TAi said")
    check(card.locator(".acard-head").get_attribute("aria-expanded") == "false" and card.locator(".acard-detail").is_hidden(), "it is closed: the longer account is one click away")
    card.locator(".acard-head").click()
    check(card.locator(".acard-head").get_attribute("aria-expanded") == "true" and "Next time: log replication." in card.locator(".acard-detail").inner_text(), "opening it shows the longer account")
    check(card.locator(".act").count() == 0 and card.locator(".actions").count() == 0, "with no buttons of any kind in it: no thumbs, no emoji, no copy")
    check(page.locator("#call-btn").is_visible(), "the call button is back")
    shots(page, out, "65-call-ended")
    check(wait_for(page, "document.querySelector('#call').hidden", 9000), "the panel goes away by itself after a moment")

    print("calls that cannot happen")
    for code, words, name in (("budget", "today's voice time", "a student out of voice time is told so"), ("busy", "already have a call", "a second call is refused: busy"), ("not-configured", "not set up", "voice that is not set up says so")):
        before = ctl.get("voice")["connections"]
        ctl.post(f"voice/next-error?code={code}")
        page.click("#call-btn")
        check(wait_for(page, f"document.querySelector('#call').dataset.state === 'ended' && document.querySelector('#call-state').textContent.includes({json.dumps(words)})", 5000), name, page.inner_text("#call-state"))
        page.wait_for_timeout(1200)
        check(ctl.get("voice")["connections"] == before + 1, f"({code}: and nothing retries)")
        if code == "budget":
            shots(page, out, "66-call-budget", wait_ms=150)
        page.click("#call-close")
        check(page.locator("#call").is_hidden(), f"({code}: the panel closes)")

    print("a microphone that is refused")
    refused = context.new_page()
    watch(refused, problems)
    refused.add_init_script("navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));")
    refused.goto(base)
    wait_for(refused, "document.querySelector('#chat').dataset.mode === 'chat'")
    before = ctl.get("voice")["connections"]
    refused.click("#call-btn")
    check(wait_for(refused, "document.querySelector('#call').dataset.state === 'ended' && document.querySelector('#call-state').textContent.includes('microphone is blocked')", 5000), "a refused microphone is explained, with how to allow it", refused.inner_text("#call-state"))
    check(ctl.get("voice")["connections"] == before, "and no call is opened")
    refused.click("#call-close")
    refused.click("#mic")
    check(wait_for(refused, "document.querySelector('#toast').textContent.includes('microphone is blocked')", 4000) and refused.locator("#recbar").is_hidden() and refused.locator("#composer").is_visible(), "a voice note says the same, and the message box stays")
    refused.close()

    clean(page, problems, "voice call")       # (before the page is left: the worklet and the socket are where a refusal would show)
    print("leaving the page during a call")
    ctl.post("voice/reset")
    page.click("#call-btn")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'listening'", 8000), "another call starts")
    page.goto("about:blank")
    deadline = time.time() + 5
    while time.time() < deadline and ctl.get("voice")["live"]:
        time.sleep(0.2)
    check(not ctl.get("voice")["live"], "leaving the page ends it (the server is told, nothing is left open)")
    check(not problems, "voice call: nothing went wrong while leaving either", "; ".join(problems[:3]))
    context.close()


def interview_link(browser, base, off, ctl, out):
    print("the mock interview link (with reduced motion)")
    context = browser.new_context(viewport={"width": 1280, "height": 800}, color_scheme="dark", permissions=["microphone"], reduced_motion="reduce")
    context.route("https://accounts.google.com/**", lambda route: route.abort())
    context.add_init_script(FAKE_GOOGLE)
    context.add_init_script(PAGE_PROBE)
    page = context.new_page()
    problems: list[str] = []
    watch(page, problems)
    sockets: list[str] = []
    page.on("websocket", lambda ws: sockets.append(ws.url))
    page.goto(base + "interview/good-token-123")
    page.wait_for_selector("#fake-google")
    check(page.evaluate("location.pathname") == "/" and "good-token" not in page.evaluate("location.href"), "the token is taken out of the address at once, before sign-in", page.evaluate("location.href"))
    sign_in(page, "dev:carol@example.com")
    check(wait_for(page, "document.querySelector('#interview').open", 6000), "after sign-in, one screen offers the mock interview")
    check(page.evaluate("document.activeElement.id") == "interview-start", "its start button has the focus")
    shots(page, out, "70-interview-start")
    ctl.post("voice/reset")
    page.click("#interview-start")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'listening' && document.querySelector('#call').dataset.mode === 'interviewer' && !document.querySelector('#call-badge').hidden", 8000), "a click starts the call as a mock interview")
    starts = ctl.get("voice")["starts"]
    check(starts and starts[-1] == {"mode": "interview", "resume": False, "token": "good-token-123"}, "the token travels in the start message", str(starts[-1:]))
    check(sockets and all("token" not in url for url in sockets), "and never in the socket's address")
    check(wait_for(page, "[...document.querySelectorAll('.row.speech.tai')].some((r) => r.textContent.includes('Tell me about'))", 4000), "the interviewer's first question is in the conversation, as a spoken line")
    check(page.evaluate("getComputedStyle(document.querySelector('.orb-core')).animationName") == "none" and page.evaluate("getComputedStyle(document.querySelector('.orb-halo')).transform") == "none" and page.evaluate("getComputedStyle(document.querySelector('#call .orb')).animationName") == "none", "with reduced motion asked for, the orb keeps still: its state is its colour and its label")
    page.click("#call-end")
    wait_for(page, "document.querySelector('#call').dataset.state === 'ended'", 5000)

    page.goto(base + "interview/expired-token-9")
    check(wait_for(page, "document.querySelector('#interview').open", 6000), "a second link, signed in: the same screen")
    page.click("#interview-start")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'ended' && document.querySelector('#call-state').textContent === 'This link has expired. Ask TAi for a new one.'", 6000), "an expired link says so, and what to do", page.inner_text("#call-state"))
    shots(page, out, "71-interview-expired")
    page.click("#call-close")

    page.goto(base + "interview/good-token-456")
    wait_for(page, "document.querySelector('#interview').open", 6000)
    before = len(ctl.get("voice")["starts"])
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)
    check(not page.evaluate("document.querySelector('#interview').open") and len(ctl.get("voice")["starts"]) == before and page.locator("#call").is_hidden(), "Escape (not now) leaves it without a call")

    print("signing out in the middle of a call")
    page.click("#call-btn")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'listening'", 8000), "a call is on")
    page.click("#avatar")
    page.click("#signout")
    check(wait_for(page, "document.querySelector('#chat').dataset.mode === 'gate'", 5000) and page.locator("#call").is_hidden(), "signing out ends it and takes the panel away")
    deadline = time.time() + 5
    while time.time() < deadline and ctl.get("voice")["live"]:
        time.sleep(0.2)
    check(not ctl.get("voice")["live"] and page.evaluate("window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))"), "nothing of it is left open: not at the server, not the microphone")
    clean(page, problems, "the interview link")
    context.close()


def talk_mode(browser, base, off, ctl, out):
    print("talking it through")
    context, page, problems = student(browser, base, "dev:lena@example.com")
    ctl.post("voice/reset")
    check(page.locator("#call-group").is_visible() and page.locator("#call-more").is_visible(), "a small chevron sits beside the call button")
    check(page.get_attribute("#call-more", "aria-haspopup") == "menu" and page.get_attribute("#call-more", "aria-expanded") == "false" and page.get_attribute("#call-more", "aria-label") == "More ways to talk with TAi", "named for a screen reader, and closed")
    check(page.evaluate("(() => { const a = document.querySelector('#call-btn').getBoundingClientRect(), b = document.querySelector('#call-more').getBoundingClientRect(); return b.left >= a.right - 8 && b.right - a.left < 80 && Math.abs((a.top + a.bottom) - (b.top + b.bottom)) < 2; })()"), "fused to it, and no taller")
    shots(page, out, "105-call-button-chevron")
    page.click("#call-more")
    menu = page.locator("#call-menu")
    check(menu.is_visible() and menu.get_attribute("role") == "menu" and page.get_attribute("#call-more", "aria-expanded") == "true", "the chevron opens a small menu")
    check([i.locator("strong").inner_text() for i in menu.locator(".menu-item").all()] == ["Voice call", "Talk it through"], "of the two ways to talk")
    check("explain" in menu.locator(".menu-item").nth(1).inner_text().lower() and "listens" in menu.locator(".menu-item").nth(1).inner_text().lower(), "the second says what it is")
    check(page.evaluate("document.activeElement.dataset.call") == "chat", "the focus is on the first")
    page.keyboard.press("ArrowDown")
    check(page.evaluate("document.activeElement.dataset.call") == "talk", "the arrow keys move along it")
    shots(page, out, "106-call-menu")
    page.keyboard.press("Escape")
    check(menu.is_hidden() and page.evaluate("document.activeElement.id") == "call-more", "Escape closes it, and the focus goes back to the chevron")
    page.click("#call-more")
    page.mouse.click(1050, 300)
    check(menu.is_hidden(), "a click elsewhere closes it too")
    check(len(ctl.get("voice")["starts"]) == 0, "(and no call was started by any of that)")

    page.click("#call-more")
    page.locator("#call-menu .menu-item[data-call='talk']").click()
    check(menu.is_hidden(), "choosing one closes the menu")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'listening' && document.querySelector('#call').dataset.mode === 'listener' && !document.querySelector('#call-badge').hidden", 8000), "'Talk it through' starts a call that the server runs as a listener")
    check(page.inner_text("#call-badge") == "Talk it through", "with a badge that says so")
    starts = ctl.get("voice")["starts"]
    check(starts and starts[-1] == {"mode": "talk", "resume": False}, "the start message says mode talk, and nothing else", str(starts[-1:]))
    check(wait_for(page, "[...document.querySelectorAll('.row.speech.tai')].some((r) => r.textContent.includes('I will listen'))", 4000), "TAi answers by voice, and says it is listening")
    check(re.fullmatch(r"Talk it through · .+", page.locator(".row.call-mark[data-event='start']").inner_text()) is not None, "and the conversation marks the start of the call as one of those")
    check(page.locator("#call-group").is_hidden(), "the call button and its chevron step aside while the call is on")
    orb = page.evaluate("getComputedStyle(document.querySelector('.orb-core')).backgroundImage")
    check("rgb(20, 184, 166)" in orb and "rgb(59, 130, 246)" in orb, "the orb is calm, teal into blue", orb[:100])
    badge = page.evaluate("(() => { const s = getComputedStyle(document.querySelector('#call-badge')); return [s.backgroundImage, s.color]; })()")
    check("rgb(15, 118, 110)" in badge[0] and badge[1] == "rgb(255, 255, 255)", "the badge in white on its own deep teal, readable", str(badge))
    shots(page, out, "107-call-talk")
    check(wait_for(page, "/\\d+:\\d\\d left/.test(document.querySelector('#call-timer').textContent)", 3000) and "interview" not in page.inner_text("#call-timer"), "the timer shows the time left of the call, not an interview's")

    print("a call that changes into one, and back")
    ctl.post("voice/interviewer?who=lena")
    check(wait_for(page, "document.querySelector('#call').dataset.mode === 'interviewer' && document.querySelector('#call-badge').textContent === 'Mock interview'", 3000), "TAi switching to the interviewer shows the interview's badge")
    ctl.post("voice/listener?who=lena")
    check(wait_for(page, "document.querySelector('#call').dataset.mode === 'listener' && document.querySelector('#call-badge').textContent === 'Talk it through' && !document.querySelector('#call-badge').hidden", 3000), "and TAi switching to listening, in the middle of a call, shows this one")
    ctl.post("voice/interrupt?who=lena&after=300")
    wait_for(page, "document.querySelector('#call').dataset.state === 'listening'", 6000)

    print("a dropped connection")
    ctl.post("voice/drop?who=lena")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'listening' && ('' + document.querySelector('#call-state').textContent) === 'Listening'", 15000), "the call is taken up again")
    starts = ctl.get("voice")["starts"]
    check(starts[-1] == {"mode": "talk", "resume": True}, "with a start message that says mode talk and resume, and no topic", str(starts[-1]))
    check(page.evaluate("document.querySelector('#call').dataset.mode") == "listener" and not page.evaluate("document.querySelector('#call-badge').hidden"), "still as a listener")

    print("hanging up")
    page.click("#call-end")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'ended'", 5000), "End call ends it")
    check(wait_for(page, "!!document.querySelector('.row.activity[data-type=\"talk\"]')", 6000), "the call's account arrives in the chat, as a card")
    card = page.locator(".row.activity[data-type='talk']")
    check(card.locator(".acard-title").inner_text().startswith("Talk it through · ") and card.locator(".acard-text").inner_text().startswith("You talked Raft"), "titled Talk it through (the call ended as one), with a line of what it was about", card.inner_text())
    card.locator(".acard-head").click()
    check("Next time: log replication." in card.locator(".acard-detail").inner_text() and card.locator(".act").count() == 0, "it opens to the longer account, and has no thumbs to give")
    check(page.locator("#call-group").is_visible(), "the call button is back")
    clean(page, problems, "talking it through")
    context.close()

    print("from the first card")
    context, page, problems = student(browser, base, "dev:mike@example.com")
    ctl.post("voice/reset")
    check(page.locator(".starter .card-row").count() == 5, "a new student's card has a fifth place to start")
    last = page.locator(".starter .card-row").last
    check(last.inner_text().startswith("Talk it through out loud") and "voice" in last.inner_text().lower(), "'Talk it through out loud'")
    check(last.get_attribute("data-call") == "talk" and not last.get_attribute("data-send") and not last.get_attribute("data-fill"), "which starts a call, and sends nothing")
    shots(page, out, "108-starter-talk")
    last.click()
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'listening' && document.querySelector('#call').dataset.mode === 'listener' && !document.querySelector('#call-badge').hidden", 8000), "a click starts the call as a listener")
    check(ctl.get("voice")["starts"][-1:] == [{"mode": "talk", "resume": False}], "with the same start message")
    check(page.locator(".row.user").count() == 0 and not ctl.get("seen?who=mike"), "and no message went to the text TAi")
    page.click("#call-end")
    wait_for(page, "document.querySelector('#call').dataset.state === 'ended'", 5000)
    clean(page, problems, "the talk-it-through card")
    context.close()

    print("a phone")
    context, page, problems = student(browser, base, "dev:nina@example.com", viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2)
    page.locator("#call-more").tap()
    fits = page.evaluate("(() => { const r = document.querySelector('#call-menu').getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight; })()")
    check(page.locator("#call-menu").is_visible() and fits, "the menu opens on a phone and fits it")
    page.screenshot(path=str(out / "109-call-menu-dark-phone.png"))
    page.locator("#call-menu .menu-item[data-call='talk']").tap()
    check(wait_for(page, "document.querySelector('#call').dataset.mode === 'listener'", 8000), "and a tap starts the call")
    page.wait_for_timeout(1700)
    page.screenshot(path=str(out / "110-call-talk-dark-phone.png"))
    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "nothing sticks out sideways")
    page.tap("#call-end")
    wait_for(page, "document.querySelector('#call').dataset.state === 'ended'", 5000)
    clean(page, problems, "talking it through on a phone")
    context.close()


# ---------------------------------------------------------------- what is said in a call, in the conversation

SILENT_MIC = r"""
(() => {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const real = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => { const s = await real(c); s.getAudioTracks().forEach((t) => { t.enabled = false; }); return s; };
})();
"""
SPOKEN_ROWS = ".row.speech:not(.pending)"


def user_says(ctl, who: str, text: str, after: int = 300, reply: bool = False) -> None:
    """The student speaks in the call: the server hears them begin, and `after` ms later their words are final (a line in the history)."""
    ctl.post(f"voice/user-says?who={who}&text={urllib.parse.quote(text)}&after={after}" + ("&reply=1" if reply else ""))


def say_line(ctl, who: str, role: str, text: str) -> None:
    """One line of speech put in the student's history, with no call needed (what a call that was made before left)."""
    ctl.post(f"voice/line?who={who}&role={role}&text={urllib.parse.quote(text)}")


def call_thread(browser, base, off, ctl, out):
    print("what is said in a call is in the conversation")
    context, page, problems = student(browser, base, "dev:yara@example.com")
    ctl.post("voice/reset")
    send(page, "hello, a question about Raft")
    check(wait_reply(page, 1), "TAi answers a typed message first")
    page.click("#call-btn")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'listening'", 8000), "a call starts")
    check(wait_for(page, "document.querySelectorAll('.row.speech.tai').length === 1", 5000), "TAi's greeting is a spoken line, in the same conversation as the typed words")
    check(page.locator(REPLIES).count() == 1, "(and not one of its replies: it is no message)")
    wait_for(page, "document.querySelector('#call').dataset.state === 'listening' && document.querySelector('#call').dataset.queued === '0'", 6000)

    print("the student begins to speak")
    ctl.post("voice/user-speaking?who=yara")
    check(wait_for(page, "document.querySelectorAll('.row.speech.pending').length === 1", 3000), "a grey ... bubble comes up on the right")
    pending = page.locator(".row.speech.pending")
    check(pending.get_attribute("aria-hidden") == "true" and pending.locator(".dots i").count() == 3 and pending.evaluate("(r) => r === document.querySelector('#messages').lastElementChild"), "for the eye only, and the last thing in the conversation")
    right_gap = page.evaluate("(() => { const r = document.querySelector('.row.speech.pending .bubble').getBoundingClientRect(), t = document.querySelector('.thread').getBoundingClientRect(); return t.right - 30 - r.right; })()")
    check(abs(right_gap) < 4, "on the right, where the student's own bubbles are", str(right_gap))
    counts = []
    for _ in range(30):
        counts.append(page.locator(".row.speech.pending").count())
        page.wait_for_timeout(100)
    check(all(c == 1 for c in counts), "while the student goes on talking (their microphone is audible) it stays, without a flicker", str(counts))
    page.wait_for_timeout(2400)
    check(page.locator(".row.speech.pending").count() == 1, "past the four seconds it would otherwise hold for")
    page.click("#call-mute")
    check(wait_for(page, "document.querySelectorAll('.row.speech.pending').length === 0", 2000), "muting takes it away: nothing is heard from here")
    page.click("#call-mute")

    print("their words arrive")
    user_says(ctl, "yara", "Why does a candidate vote for itself first?", after=900, reply=True)
    check(wait_for(page, "document.querySelectorAll('.row.speech.pending').length === 1", 3000), "the ... is up again while they speak")
    check(wait_for(page, "document.querySelectorAll('.row.speech.you').length === 1 && document.querySelectorAll('.row.speech.pending').length === 0", 4000), "and when the line arrives it is replaced by the words, at the same place")
    you = page.locator(".row.speech.you")
    check(you.inner_text().strip() == "Why does a candidate vote for itself first?" and you.locator(".say-glyph").get_attribute("aria-label") == "Spoken", "a right-aligned blue bubble with the words, and the small waveform of spoken lines")
    bubble_colour = you.locator(".bubble").evaluate("(b) => getComputedStyle(b).backgroundColor")
    typed_colour = page.locator(".row.user:not(.speech) .bubble").first.evaluate("(b) => getComputedStyle(b).backgroundColor")
    check(bubble_colour == typed_colour, "the blue of the typed ones", f"{bubble_colour} / {typed_colour}")
    check(wait_for(page, "document.querySelectorAll('.row.speech.tai').length === 2", 6000), "TAi answers by voice: its words are a line on the left")
    edges = page.evaluate("(() => { const t = document.querySelector('.thread').getBoundingClientRect(), y = document.querySelector('.row.speech.you .bubble').getBoundingClientRect(), a = document.querySelector('.row.speech.tai .bubble').getBoundingClientRect(); return [Math.round(t.right - y.right), Math.round(a.left - t.left)]; })()")
    check(edges[0] < 40 and edges[1] < 40, "the student's against the right edge of the conversation, TAi's against the left", str(edges))
    check(page.locator(".row.speech.you .act, .row.speech.you .actions").count() == 0 and page.locator(".row.speech .act[data-act='react']").count() == 0, "no smiley on any spoken line: they are not messages")
    tai = page.locator(".row.speech.tai").nth(1)
    tai.hover()
    tai.locator(".act[data-act='copy']").click()
    check(wait_for(page, "document.querySelector('#toast').textContent === 'Copied'", 3000) and page.evaluate("navigator.clipboard.readText()").startswith("I heard you say"), "TAi's words can be copied")
    check(page.locator(REPLIES).count() == 1 and page.locator(".row.user:not(.speech)").count() == 1, "still one reply and one typed message: the words of the call are neither")

    print("typed words in the call")
    send(page, "typed while we talk")
    check(settle(page, lambda: "typed while we talk" in ctl.get("voice")["injected"], 5000), "what is typed joins the call")
    check(page.locator(".row.user:not(.speech)").count() == 2 and page.locator(".row.speech.you").count() == 1, "as a typed message: no waveform, and not a line of speech")
    check(wait_for(page, "[...document.querySelectorAll('.row.speech.tai')].some((r) => r.textContent.includes('You wrote'))", 6000), "TAi's answer to it comes by voice, as a line")
    wait_for(page, "document.querySelector('#call').dataset.state === 'listening'", 6000)
    shots(page, out, "140-call-thread")

    print("not messages")
    ctl.post("voice/lines?who=yara&count=24")
    check(wait_for(page, f"document.querySelectorAll('{SPOKEN_ROWS}').length >= 28", 6000), "a longer call fills the conversation")
    page.evaluate("document.querySelector('#scroller').scrollTo({top: 0})")
    wait_for(page, f"{JUMP} === 'arrow'", 3000)
    say_line(ctl, "yara", "assistant", "Said while the reader is looking back.")
    page.wait_for_timeout(800)
    check(not page.evaluate(JUMP).startswith("count") and page.inner_text("#jump-live") == "", "a spoken line that comes while the reader is looking back is not an unread message: no count on the pill")
    page.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })")        # the tab is behind another one
    ctl.post("say?who=yara&text=" + urllib.parse.quote("A typed answer, while the tab is behind another."))
    check(wait_for(page, "document.title === '(1) TAi'", 4000), "(an answer that is typed and comes while the tab is behind another is counted in its title)")
    say_line(ctl, "yara", "assistant", "Said aloud, while the tab is behind another.")
    check(wait_for(page, "[...document.querySelectorAll('.row.speech')].some((r) => r.textContent.includes('while the tab is behind'))", 4000) and page.title() == "(1) TAi", "a spoken line that comes then is not: the title still says one")
    page.evaluate("delete document.hidden")
    page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    check(wait_for(page, "document.title === 'TAi'", 2000), "(and the count goes when the tab is in front again)")
    fresh = page.evaluate("fetch('api/history?limit=10').then(r => r.json()).then(d => d.entries.filter((e) => e.kind === 'speech' && !e.event).pop().n)")
    answer = page.evaluate("fetch('api/react', {method: 'POST', headers: {'content-type': 'application/json', 'x-tai': '1'}, body: JSON.stringify({to: %d, emoji: '👍'})}).then(r => r.status)" % fresh)
    check(answer == 404, "and the server takes no emoji on one", str(answer))

    print("a long bubble")
    say_line(ctl, "yara", "assistant", "A long thought. " + "Consensus is about agreeing on one value even when machines fail and messages are late. " * 9)
    check(wait_for(page, "!!document.querySelector('.row.speech .say-text.is-folded')", 4000), "a spoken bubble of over 600 characters is folded")
    long_n = page.locator(".row.speech", has=page.locator(".say-text.is-folded")).get_attribute("data-n")
    folded = page.locator(f".row.speech[data-n='{long_n}']")
    more = folded.locator(".say-more")
    check(more.inner_text() == "…more" and more.get_attribute("aria-expanded") == "false" and folded.locator(".say-text").evaluate("(t) => t.scrollHeight > t.clientHeight"), "with ...more under it")
    more.click()
    check(more.get_attribute("aria-expanded") == "true" and folded.locator(".say-text").evaluate("(t) => !t.classList.contains('is-folded') && t.scrollHeight <= t.clientHeight + 1") and more.inner_text() == "less", "which opens it, and says less")
    folded.hover()
    folded.locator(".act[data-act='copy']").click()
    check(wait_for(page, "document.querySelector('#toast').textContent === 'Copied'", 3000) and len(page.evaluate("navigator.clipboard.readText()")) > 600, "and copying gives all of it")

    print("the end")
    page.click("#call-end")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'ended'", 5000), "the call ends")
    check(wait_for(page, "!!document.querySelector('.row.call-mark[data-event=\"end\"]') && !!document.querySelector('.row.activity')", 6000), "its end is a divider, and its card of the activity list follows it")
    order = page.evaluate("(() => { const rows = [...document.querySelectorAll('#messages > .row')]; return [rows.indexOf(document.querySelector('.row.call-mark[data-event=\"end\"]')), rows.indexOf(document.querySelector('.row.activity'))]; })()")
    check(0 < order[0] < order[1], "in that order", str(order))

    print("the drawer counts them apart")
    page.click("#chats-btn")
    expected = page.evaluate("(() => ({ messages: document.querySelectorAll('.row.user:not(.speech), .row.assistant[data-n]').length, spoken: document.querySelectorAll('.row.speech:not(.pending)').length, acts: document.querySelectorAll('.row.activity').length }))()")
    count_text = page.locator(".day-count").first.inner_text()
    check(f"{expected['messages']} messages" in count_text and f"{expected['spoken']} spoken lines" in count_text and "1 activity" in count_text, "a day says its messages, its spoken lines and its activities, each by itself", f"{count_text} / {expected}")
    check(expected["spoken"] >= 29 and expected["messages"] == 4, "(the spoken lines are not among the messages: two typed, two of TAi's)", str(expected))
    page.fill("#search-input", "candidate vote")
    check(page.locator(".hit", has_text="TAi (spoken)").count() == 1, "the search finds what TAi said aloud too, and says so")
    hit = page.locator(".hit", has_text="You (spoken)")
    check(hit.count() == 1 and "candidate" in hit.inner_text(), "and what the student said, and says so")
    hit.click()
    check(wait_for(page, "document.querySelector('#drawer').hidden && !!document.querySelector('.row.speech.you.flash')", 3000), "and takes the reader to it")
    page.screenshot(path=str(out / "141-call-search-dark-desktop.png"))

    print("a reload")
    before = page.evaluate(f"[document.querySelectorAll('{SPOKEN_ROWS}').length, document.querySelectorAll('.row.call-mark').length]")
    page.reload()
    wait_for(page, "document.querySelector('#chat').dataset.mode === 'chat' && document.querySelectorAll('.row[data-n]').length > 0")
    after = page.evaluate(f"[document.querySelectorAll('{SPOKEN_ROWS}').length, document.querySelectorAll('.row.call-mark').length]")
    check(after == before and page.locator(".row.speech.pending").count() == 0, "the lines and the dividers are all there after a reload", f"{before} / {after}")
    check(page.locator("#call").is_hidden() and page.locator("#mic").is_visible() and page.locator("#call-actions").is_hidden(), "and there is no call: the message box is as it always is")

    print("they close no question")
    ask_options(ctl, "yara", text="Which of these is true of a Raft term?", quiz=True, key=1)
    row = options_row(page, 1)
    say_line(ctl, "yara", "user", "Let me think out loud for a moment.")
    say_line(ctl, "yara", "assistant", "Take your time.")
    check(wait_for(page, "[...document.querySelectorAll('.row.speech')].some((r) => r.textContent.includes('Take your time'))", 4000) and row.evaluate(CHOICE_STATES) == ["open", "open", "open"] and row.evaluate(CHOICES_ON), "words said aloud do not close the options of a quick check")

    print("a long call does not push the chat out")
    ctl.post("voice/lines?who=yara&count=260")
    page.reload()
    wait_for(page, "document.querySelector('#chat').dataset.mode === 'chat' && document.querySelectorAll('.row[data-n]').length > 0")
    check(page.evaluate(f"document.querySelectorAll('{SPOKEN_ROWS}').length") > 280 and page.evaluate("[...document.querySelectorAll('.row.user')].some((r) => r.textContent.includes('hello, a question about Raft'))"), "after 260 more lines the first screen still holds the chat from before the call", str(page.evaluate(f"document.querySelectorAll('{SPOKEN_ROWS}').length")))
    check(page.evaluate("document.querySelector('#scroller').scrollHeight - document.querySelector('#scroller').scrollTop - document.querySelector('#scroller').clientHeight") < 5, "(and it opens at the latest line)")
    print("a reload in the middle of a call")
    ctl.post("voice/reset")
    ends = page.locator(".row.call-mark[data-event='end']").count()
    page.click("#call-btn")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'listening'", 8000), "another call is on")
    user_says(ctl, "yara", "Something said just before the reload.", after=200)
    check(wait_for(page, "[...document.querySelectorAll('.row.speech.you')].some((r) => r.textContent.includes('before the reload'))", 4000), "a line of it is in the conversation")
    page.reload()
    wait_for(page, "document.querySelector('#chat').dataset.mode === 'chat' && document.querySelectorAll('.row[data-n]').length > 0")
    check(page.locator("#call").is_hidden() and page.locator("#call-actions").is_hidden() and page.locator("#mic").is_visible(), "a reload ends the call: no orb, and the message box is its own again")
    check(page.evaluate("[...document.querySelectorAll('.row.speech.you')].some((r) => r.textContent.includes('before the reload'))"), "and the lines stay")
    check(wait_for(page, f"document.querySelectorAll('.row.call-mark[data-event=\"end\"]').length === {ends + 1}", 6000), "and the end of the call is a divider in the conversation, as for any other end")
    clean(page, problems, "a call in the conversation")

    print("the student's ... goes by itself")
    silent = browser.new_context(viewport={"width": 1280, "height": 800}, color_scheme="dark", permissions=["clipboard-read", "clipboard-write", "microphone"])
    silent.route("https://accounts.google.com/**", lambda route: route.abort())
    silent.add_init_script(FAKE_GOOGLE)
    silent.add_init_script(PAGE_PROBE)
    silent.add_init_script(SILENT_MIC)
    quiet = silent.new_page()
    watch(quiet, problems)
    quiet.goto(base)
    quiet.wait_for_selector("#fake-google")
    sign_in(quiet, "dev:zane@example.com")
    wait_for(quiet, "document.querySelector('#chat').dataset.mode === 'chat'")
    quiet.click("#call-btn")
    check(wait_for(quiet, "document.querySelector('#call').dataset.state === 'listening'", 8000), "a call with a quiet microphone")
    wait_for(quiet, "document.querySelector('#call').dataset.queued === '0' && document.querySelectorAll('.row.speech.tai').length === 1", 6000)
    ctl.post("voice/user-speaking?who=zane")
    check(wait_for(quiet, "document.querySelectorAll('.row.speech.pending').length === 1", 3000), "the ... comes up when the server hears them begin")
    quiet.wait_for_timeout(3000)
    check(quiet.locator(".row.speech.pending").count() == 1, "and holds for a few seconds")
    check(wait_for(quiet, "document.querySelectorAll('.row.speech.pending').length === 0", 3000), "and goes by itself, about four seconds after the last sign of speech, when no line comes")
    ctl.post("voice/user-speaking?who=zane")
    wait_for(quiet, "document.querySelectorAll('.row.speech.pending').length === 1", 3000)
    quiet.click("#call-end")
    check(wait_for(quiet, "document.querySelector('#call').dataset.state === 'ended' && document.querySelectorAll('.row.speech.pending').length === 0", 5000), "it goes with the end of the call")
    silent.close()
    context.close()


def call_orb(browser, base, off, ctl, out):
    print("the orb")
    context, page, problems = student(browser, base, "dev:abel@example.com")
    ctl.post("voice/reset")
    page.click("#call-btn")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'listening'", 8000), "a call starts")
    wait_for(page, "document.querySelector('#call').dataset.queued === '0' && document.querySelector('#call').dataset.state === 'listening'", 8000)
    LOOK = "(() => { const orb = document.querySelector('#call .orb'), core = document.querySelector('#call .orb-core'); return { orb: getComputedStyle(orb).animationName, ring: getComputedStyle(orb, '::before').animationName, dash: getComputedStyle(orb, '::after').animationName, swirl: getComputedStyle(core, '::after').opacity + ' ' + getComputedStyle(core, '::after').animationName, filter: getComputedStyle(core).filter, size: orb.offsetWidth, label: document.querySelector('#call-state').textContent }; })()"
    listening = page.evaluate(LOOK)
    check(listening["orb"] == "orb-breathe" and listening["swirl"].startswith("0 ") and listening["size"] == 140, "listening: the orb breathes slowly", str(listening))
    shots(page, out, "142-call-orb-listening")
    ctl.post("voice/status?who=abel&state=thinking")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'thinking'", 3000), "thinking")
    thinking = page.evaluate(LOOK)
    check(thinking["orb"] == "none" and thinking["swirl"] == "1 spin" and thinking["label"] == "Thinking…", "thinking: the breathing stops and a swirl runs over it", str(thinking))
    ctl.post("voice/status?who=abel&state=working")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'working'", 3000), "looking something up")
    working = page.evaluate(LOOK)
    check(working["swirl"] == "1 spin" and working["dash"] == "spin" and working["label"] == "Looking that up…", "looking something up: the thinking look, a ring around it, and its label", str(working))
    shots(page, out, "143-call-orb-working")
    ctl.post("voice/status?who=abel&state=speaking")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'speaking'", 3000), "TAi speaking")
    speaking = page.evaluate(LOOK)
    check(speaking["ring"] == "orb-ripple" and speaking["orb"] == "none" and speaking["label"] == "TAi is speaking", "speaking: rings go out from it", str(speaking))
    ctl.post("voice/status?who=abel&state=listening")

    print("it follows the voices")
    ctl.post("voice/speak?who=abel&text=" + urllib.parse.quote("Here is a longer thought about terms and votes.") + "&ms=3000&paced=0")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'speaking'", 3000), "TAi speaks for a few seconds")
    levels = []
    for _ in range(12):
        levels.append(float(page.evaluate("getComputedStyle(document.querySelector('#call')).getPropertyValue('--out') || '0'")))
        page.wait_for_timeout(120)
    check(max(levels) > 0.1, "the orb swells with TAi's voice as it is played", str(levels))
    swell = page.evaluate("getComputedStyle(document.querySelector('#call .orb-core')).transform")
    check(swell not in ("none", "matrix(1, 0, 0, 1, 0, 0)"), "(the sphere is scaled by it)", swell)
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'listening' && parseFloat(getComputedStyle(document.querySelector('#call')).getPropertyValue('--out')) < 0.05", 8000), "and falls still when it is over")
    mic_levels = []
    for _ in range(20):                              # (the browser's echo cancelling holds the microphone down for a moment after TAi has spoken)
        mic_levels.append(float(page.evaluate("getComputedStyle(document.querySelector('#call')).getPropertyValue('--mic') || '0'")))
        if max(mic_levels) > 0.1:
            break
        page.wait_for_timeout(150)
    check(max(mic_levels) > 0.1, "while it listens it follows the student's voice instead", str(mic_levels))

    print("it is dim while it connects, and when the connection drops")
    ctl.post("voice/resume-delay?ms=4000")
    ctl.post("voice/drop?who=abel")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'reconnecting'", 3000), "a dropped connection")
    page.wait_for_timeout(500)                     # (the sphere fades to its dim look)
    lost = page.evaluate(LOOK)
    check(lost["orb"] == "orb-dim" and "saturate(0.3)" in lost["filter"] and lost["label"] == "Reconnecting…", "reconnecting: dim, slowly pulsing, and its label", str(lost))
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'listening'", 15000), "and the call is taken up again")

    print("the three kinds of call have their own colours")
    chat_colour = page.evaluate("getComputedStyle(document.querySelector('#call .orb-core')).backgroundImage")
    ctl.post("voice/interviewer?who=abel")
    check(wait_for(page, "document.querySelector('#call').dataset.mode === 'interviewer'", 3000), "the interviewer")
    interview_colour = page.evaluate("getComputedStyle(document.querySelector('#call .orb-core')).backgroundImage")
    ctl.post("voice/listener?who=abel")
    check(wait_for(page, "document.querySelector('#call').dataset.mode === 'listener'", 3000), "the listener")
    listener_colour = page.evaluate("getComputedStyle(document.querySelector('#call .orb-core')).backgroundImage")
    check("rgb(61, 155, 255)" in chat_colour and "rgb(249, 115, 22)" in interview_colour and "rgb(20, 184, 166)" in listener_colour and len({chat_colour, interview_colour, listener_colour}) == 3, "blue sky for a call, warm for the interviewer, teal into blue for talking it through", f"{chat_colour[:60]} / {interview_colour[:60]} / {listener_colour[:60]}")
    check(page.evaluate("getComputedStyle(document.querySelector('#call-badge')).backgroundImage").find("rgb(15, 118, 110)") >= 0, "and the badge has the colour of its kind")
    page.click("#call-end")
    wait_for(page, "document.querySelector('#call').dataset.state === 'ended'", 5000)
    clean(page, problems, "the orb")
    context.close()

    print("with reduced motion")
    context, page, problems = student(browser, base, "dev:bella@example.com", reduced_motion="reduce")
    ctl.post("voice/reset")
    page.click("#call-btn")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'speaking'", 8000), "TAi speaks")
    still = page.evaluate("(() => { const orb = document.querySelector('#call .orb'); const g = (e, p) => getComputedStyle(e, p).animationName; return [g(orb), g(orb, '::before'), getComputedStyle(document.querySelector('#call .orb-core')).transform, getComputedStyle(document.querySelector('#call .orb-halo')).transform, getComputedStyle(document.querySelector('#call .orb-core')).transitionDuration]; })()")
    check(still == ["none", "none", "none", "none", "0s"], "the orb does not move at all: no breathing, no rings, no swell", str(still))
    check(page.inner_text("#call-state") == "TAi is speaking" and page.get_attribute("#call", "data-state") == "speaking", "the state is in its label (and its colour)")
    ctl.post("voice/status?who=bella&state=thinking")
    check(wait_for(page, "document.querySelector('#call-state').textContent === 'Thinking…'", 3000) and page.evaluate("getComputedStyle(document.querySelector('#call .orb-core'), '::after').animationName") == "none", "thinking says so too, with no swirl")
    page.click("#call-end")
    wait_for(page, "document.querySelector('#call').dataset.state === 'ended'", 5000)
    clean(page, problems, "the orb with reduced motion")
    context.close()


def call_phone(browser, base, off, ctl, out):
    print("a call on a phone")
    context, page, problems = student(browser, base, "dev:cleo@example.com", viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2)
    ctl.post("voice/reset")
    page.tap("#call-btn")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'listening'", 8000), "a call starts with a tap")
    user_says(ctl, "cleo", "Why does a candidate vote for itself first?", after=300, reply=True)
    check(wait_for(page, "document.querySelectorAll('.row.speech.tai').length === 2 && document.querySelectorAll('.row.speech.you').length === 1", 8000), "the words are in the conversation")
    wait_for(page, "document.querySelector('#call').dataset.state === 'listening' && document.querySelector('#call').dataset.queued === '0'", 8000)
    size = page.evaluate("(() => { const b = (s) => document.querySelector(s).getBoundingClientRect(); const m = b('#call-mute'), e = b('#call-end'); return { orb: document.querySelector('#call .orb').offsetWidth, mute: [Math.round(m.width), Math.round(m.height)], end: [Math.round(e.width), Math.round(e.height)], wide: document.documentElement.scrollWidth <= window.innerWidth }; })()")
    check(size["orb"] == 110 and size["wide"], "the orb is smaller on a phone, and nothing sticks out sideways", str(size))
    check(min(size["mute"] + size["end"]) >= 44, "mute and end are at least 44 px across", str(size))
    clearance = page.evaluate("(() => { const last = [...document.querySelectorAll('#messages > .row')].pop().getBoundingClientRect(); return document.querySelector('#scroller').getBoundingClientRect().bottom - last.bottom; })()")
    check(clearance >= -1 and page.evaluate("(() => { const s = document.querySelector('#scroller'); return s.scrollHeight - s.scrollTop - s.clientHeight < 5; })()"), "the last line is above the orb, never under it", str(clearance))
    page.screenshot(path=str(out / "144-call-phone-dark-phone.png"))
    page.evaluate("document.documentElement.dataset.theme = 'light'")
    page.wait_for_timeout(300)
    page.screenshot(path=str(out / "145-call-phone-light-phone.png"))
    page.tap("#call-mute")
    check(page.get_attribute("#call-mute", "aria-pressed") == "true" and page.inner_text("#call-state") == "You are muted", "a tap on mute mutes")
    page.wait_for_timeout(450)                      # (the sphere fades to grey)
    page.screenshot(path=str(out / "146-call-phone-muted-light-phone.png"))
    page.tap("#call-mute")
    page.fill("#input", "typed on a phone")
    check(page.locator("#send").is_visible() and page.locator("#call-end").is_visible(), "typing brings the arrow back beside the call's buttons")
    arrow = page.evaluate("(() => { const e = (s) => document.querySelector(s); return [e('#send').offsetWidth, e('#send').offsetHeight, e('#plus').offsetWidth, e('#plus').offsetHeight]; })()")      # (offset sizes: the arrow pops in, scaled)
    check(min(arrow) >= 44, "and the arrow and the plus are 44 px as well while the call is on", str(arrow))
    page.tap("#send")
    check(wait_for(page, "[...document.querySelectorAll('.row.user')].some((r) => r.textContent.includes('typed on a phone'))", 4000), "and a tap on it sends the words into the call")
    page.tap("#call-end")
    check(wait_for(page, "document.querySelector('#call').dataset.state === 'ended' && !!document.querySelector('.row.call-mark[data-event=\"end\"]')", 6000), "a tap on end ends it, and the conversation says so")
    close = page.evaluate("(() => { const b = document.querySelector('#call-close'); return [b.offsetWidth, b.offsetHeight]; })()")
    check(min(close) >= 44, "the close button of the note it leaves is 44 px too", str(close))
    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "(nothing sticks out)")
    clean(page, problems, "a call on a phone")
    context.close()



def react_to(page, row, emoji: str) -> None:
    """The student's emoji on one of TAi's replies, through the page's own button and its six (picking the one that is there takes it back)."""
    row.hover()
    row.locator(".act[data-act='react']").click()
    page.locator(f".picker .pick[data-emoji='{emoji}']").click()


def reaction_replies(browser, base, off, ctl, out):
    print("TAi answers a student's emoji")
    ctl.post("react-reply?ms=1000")             # the dev server answers none by default, so the other flows see only what they always saw
    try:
        context, page, problems = student(browser, base, "dev:rosa@example.com")
        ctl.post("voice/reset")
        send(page, "hello there")
        check(wait_reply(page, 1), "TAi answers a first message")
        replies = page.locator(REPLIES)
        n1 = int(replies.nth(0).get_attribute("data-n"))

        print("an emoji is answered")
        react_to(page, replies.nth(0), "😂")
        check(wait_for(page, f"({MY_BADGE})({n1}) === '😂'"), "an emoji goes on TAi's reply")
        check(wait_reply(page, 2, 12000), "and a moment later TAi answers it, though the student wrote nothing")
        heard = ctl.get("seen?who=rosa")
        check(len(heard) == 2 and heard[1].startswith('[The student reacted 😂 to your earlier message: "Good place to dig') and heard[1].endswith(']\n'), "(TAi was told the emoji and the start of the message it was on)", str(heard[1:]))
        check(replies.nth(1).inner_text() == "Glad that one landed. Shall we keep going?", "(its answer is a message like any other)")

        print("an emoji on that answer too")
        n2 = int(replies.nth(1).get_attribute("data-n"))
        react_to(page, replies.nth(1), "👍")
        check(wait_for(page, f"({MY_BADGE})({n2}) === '👍'"), "an emoji on the answer")
        check(wait_reply(page, 3, 12000), "is answered too (it used to get nothing)")
        heard = ctl.get("seen?who=rosa")
        check(len(heard) == 3 and heard[2].startswith('[The student reacted 👍 to your earlier message: "Glad that one landed.'), "with the note of that one", str(heard[2:]))

        print("an emoji, then the student's own words")
        ctl.post("react-reply?ms=3000")          # a wide window: the student types within it
        n3 = int(replies.nth(2).get_attribute("data-n"))
        react_to(page, replies.nth(2), "😮")
        send(page, "tell me more about it")
        check(wait_reply(page, 4, 12000), "an emoji, and the student's words before TAi has answered it: one answer")
        heard = ctl.get("seen?who=rosa")
        check(len(heard) == 4 and heard[3].startswith('[The student reacted 😮 to your earlier message: "Glad that one landed.') and heard[3].endswith("\ntell me more about it"), "the emoji rode with the words, as one message", str(heard[3:]))
        page.wait_for_timeout(3600)
        check(len(ctl.get("seen?who=rosa")) == 4 and reply_count(page) == 4, "and when the wait is over TAi has nothing more to say about it")

        print("an emoji taken back")
        n4 = int(replies.nth(3).get_attribute("data-n"))
        react_to(page, replies.nth(3), "🙏")
        check(wait_for(page, f"({MY_BADGE})({n4}) === '🙏'"), "an emoji")
        react_to(page, replies.nth(3), "🙏")
        check(wait_for(page, f"({MY_BADGE})({n4}) === ''"), "taken back before TAi answered it")
        page.wait_for_timeout(3600)
        check(len(ctl.get("seen?who=rosa")) == 4 and reply_count(page) == 4, "TAi says nothing: there is nothing left to answer")

        print("two emoji, one answer")
        react_to(page, replies.nth(0), "👍")
        react_to(page, replies.nth(1), "❤️")
        check(wait_reply(page, 5, 14000), "two emoji on two messages, a moment apart: one answer")
        heard = ctl.get("seen?who=rosa")
        check(len(heard) == 5 and heard[4].count("[The student reacted") == 2 and "👍" in heard[4] and "❤️" in heard[4], "that carries both", str(heard[4:]))
        page.wait_for_timeout(3600)
        check(len(ctl.get("seen?who=rosa")) == 5 and reply_count(page) == 5, "and only one")

        print("not during a call")
        page.click("#call-btn")
        check(wait_for(page, "document.querySelector('#call').dataset.state === 'listening'", 8000), "a call starts")
        react_to(page, replies.nth(0), "🙏")
        check(wait_for(page, f"({MY_BADGE})({n1}) === '🙏'"), "an emoji during the call")
        page.wait_for_timeout(3600)
        check(len(ctl.get("seen?who=rosa")) == 5 and reply_count(page) == 5, "is not sent to the text TAi (the call has the student's attention): nothing comes back")
        page.click("#call-end")
        check(wait_for(page, "document.querySelector('#call').dataset.state === 'ended'", 5000), "the call ends")
        check(wait_for(page, "!!document.querySelector('.row.activity[data-type=\"voice\"]')", 6000) and reply_count(page) == 5, "(its card arrives, and is no answer)")
        clean(page, problems, "the answers to emoji")
        context.close()
    finally:
        ctl.post("react-reply?ms=0")


# ---------------------------------------------------------------- the activity list

VOICE_DETAIL = ("We talked through Raft leader election and what happens when two candidates split the vote.\n"
                "In the chat: 1 diagram.\n"
                "Progress: Raft leader election, just started → getting there.\n"
                "Next time: log replication.")
NEWS_DETAIL = "HW3 is now due Wed Nov 11 at 11:59 PM PST (it was Mon Nov 9).\nNo late penalty before then."
OLD_NEWS_DETAIL = "Office hours move to Thursday, 4 pm.\nSame room as before."
LONG_REMINDER = "Start HW7 tomorrow at 9 am, then write up the Docker deployment notes, and send the group your questions on Raft log replication"
LEGACY_SUMMARY = ("Voice session, 4 min: we talked through Raft elections and split votes in some detail, and what each node does when its timer runs out before a heartbeat arrives, and how the term number settles it.\n"
                  "COMPETENCY.md: Raft 0.4 → 0.55")
# the kind of each card in the conversation, and the paths of its icon (every kind has a glyph of its own)
CARD_ICONS = "[...document.querySelectorAll('.row.activity')].map((row) => [row.dataset.type, [...row.querySelectorAll('.acard-tile svg path')].map((p) => p.getAttribute('d')).join('|')])"
SHEET_HEADINGS = "[...document.querySelectorAll('#activity-body .act-day h3')].map((h) => h.textContent)"
SHEET_TITLES = "[...document.querySelectorAll('#activity-body .act-item .acard-title')].map((t) => t.textContent)"
SHEET_OPEN = "document.querySelector('#activity').open"


def add_activity(ctl, who: str, kind: str, title: str, text: str, detail: str = "", age_min: int = 0, count: int = 1, legacy: bool = False) -> int:
    """A line of the student's activity list, as the orchestrator writes one (the dev server's control port appends it to their history): its number.
    `count` of them are titled "title #1", "title #2"...; `age_min` minutes old; `legacy`: the long call summary of the older kind instead."""
    query = f"activity/add?who={who}&type={kind}&title={urllib.parse.quote(title)}&text={urllib.parse.quote(text)}&ageMin={age_min}&count={count}" + ("&legacy=1" if legacy else "")
    return ctl.post(query, detail)["n"]


def minutes_since_noon(days_ago: int) -> int:
    """How long ago it was noon `days_ago` days ago, by this machine's clock (the page's own): a line that old is on that day, whatever time it is now."""
    now = datetime.now()
    return now.hour * 60 + now.minute + 12 * 60 + (days_ago - 1) * 24 * 60


def date_heading(page, days_ago: int) -> str:
    """What the sheet calls a day that long ago: "Wed, Oct 28" in an English browser (with the year when it is not this one). The words are the
    browser's own locale's, so they are asked of the browser: the machine this runs on may not read English."""
    when = (datetime.now() - timedelta(days=days_ago)).timestamp() * 1000
    return page.evaluate("(ms) => { const d = new Date(ms); const options = { weekday: 'short', month: 'short', day: 'numeric' }; "
                         "if (d.getFullYear() !== new Date().getFullYear()) options.year = 'numeric'; return d.toLocaleDateString([], options); }", when)


def card_row(page, n: int):
    return page.locator(f".row.activity[data-n='{n}']")


def sheet_row(page, n: int):
    return page.locator(f"#activity-body .act-item[data-n='{n}']")


def card_in_view(page, n: int) -> str:
    """Whether the card of line `n` is wholly inside the conversation's window and open."""
    return (f"(() => {{ const row = document.querySelector('.row.activity[data-n=\"{n}\"]'); if (!row) return false; const b = row.getBoundingClientRect(), s = document.querySelector('#scroller').getBoundingClientRect(); "
            f"return b.top >= s.top - 1 && b.bottom <= s.bottom + 1 && row.querySelector('.acard-head').getAttribute('aria-expanded') === 'true'; }})()")


def activity_list(browser, base, off, ctl, out):
    print("the activity list")
    context, page, problems = student(browser, base, "dev:olga@example.com")
    check(page.evaluate("fetch('api/me').then(r => r.json()).then(d => d.features.activity)") is True, "the server says there is an activity list")
    rail = page.locator("#rail-activity")
    check(rail.is_visible() and rail.get_attribute("aria-label") == "Activity" and rail.get_attribute("title") == "Activity" and rail.get_attribute("aria-expanded") == "false", "the rail has an Activity button, named for a screen reader and for the pointer, and the sheet it opens is closed")
    check([b.get_attribute("id") for b in page.locator("#rail-main > .rail-btn").all()] == ["rail-chat", "rail-search", "rail-activity", "rail-classroom"], "it sits after Search and before the classroom link")
    check(page.locator("#rail-activity svg path").count() >= 2 and page.locator("#rail-activity").evaluate("(b) => b.tagName") == "BUTTON", "a button with an icon of its own")
    page.click("#avatar")
    # (only the items that are drawn: the owner-only "Teaching view" is in the menu's markup too, hidden for a student)
    check([i.get_attribute("id") for i in page.locator("#menu .menu-item").all() if i.is_visible()] == ["menu-theme", "signout"] and page.locator("#menu .menu-who").is_visible(), "the account menu is who, the theme and sign out: no Activity, no notes, no other chat")
    page.keyboard.press("Escape")
    idle = rail.evaluate("(b) => getComputedStyle(b).backgroundColor")
    shots(page, out, "120-activity-rail")
    rail.focus()
    page.keyboard.press("Enter")
    check(wait_for(page, SHEET_OPEN), "it is a button: the keyboard opens the sheet")
    check(rail.get_attribute("aria-expanded") == "true" and wait_for(page, f"getComputedStyle(document.querySelector('#rail-activity')).backgroundColor !== {json.dumps(idle)}"), "and the button looks pressed while the sheet is open")
    check(page.get_attribute("#activity", "aria-labelledby") == "activity-title" and page.inner_text("#activity-title") == "Activity", "the sheet has its name")
    check(page.evaluate("document.activeElement.id") == "activity-close", "the focus is on its close button")
    check(wait_for(page, "document.querySelector('#activity-body').textContent.includes('Nothing yet')"), "it loads")
    check("Nothing yet. Calls, notes TAi keeps and reminders show up here." in page.inner_text("#activity-body"), "a student with nothing yet is told so, kindly")
    shots(page, out, "121-activity-empty")
    page.keyboard.press("Escape")
    check(wait_for(page, f"!{SHEET_OPEN} && document.activeElement.id === 'rail-activity'", 3000), "Escape closes it, and the focus goes back to the rail's button")
    check(wait_for(page, f"document.querySelector('#rail-activity').getAttribute('aria-expanded') === 'false' && getComputedStyle(document.querySelector('#rail-activity')).backgroundColor === {json.dumps(idle)}", 3000), "which looks as it did before (not pressed any more)")
    rail.click()
    check(wait_for(page, SHEET_OPEN), "a click opens it too")
    page.mouse.click(5, 5)
    check(wait_for(page, f"!{SHEET_OPEN} && document.activeElement.id === 'rail-activity'", 3000), "a click on the dark around it closes it, and the focus goes back to the rail's button")

    print("what happened on earlier days")
    add_activity(ctl, "olga", "progress", "Progress updated", "Docker concepts: just started → getting there", age_min=minutes_since_noon(5))
    n_old_news = add_activity(ctl, "olga", "course", "New announcement", "Office hours move to Thursday", OLD_NEWS_DETAIL, age_min=minutes_since_noon(1))
    add_activity(ctl, "olga", "reminder", "Reminder", "Review the Raft paper before the quiz", age_min=minutes_since_noon(1) - 5)
    check(wait_for(page, "document.querySelectorAll('.row.activity').length === 3", 8000), "lines from earlier days arrive as cards in the conversation")
    send(page, "hello there")
    check(wait_reply(page, 1), "TAi answers a message")
    send(page, "a long answer")
    check(wait_reply(page, 2), "and a long answer arrives, so the conversation can be scrolled")

    print("a card is not a message")
    page.evaluate("document.querySelector('#scroller').scrollTo({top: 0})")
    check(wait_for(page, f"{JUMP} === 'arrow'", 3000), "(the reader is looking back up the conversation)")
    page.evaluate("() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); }")
    n_reminder = add_activity(ctl, "olga", "reminder", "Reminder", LONG_REMINDER)
    check(wait_for(page, f"!!document.querySelector('.row.activity[data-n=\"{n_reminder}\"]')", 8000), "a card arrives with this tab behind another and the reader looking back")
    page.wait_for_timeout(500)
    check(page.title() == "TAi", "it is no message: the tab's title gets no (1)", page.title())
    check(page.evaluate(JUMP) == "arrow", "and the pill counts nothing: it stays the plain arrow", page.evaluate(JUMP))
    page.evaluate("() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); }")
    page.evaluate("document.querySelector('#scroller').scrollTo({top: 1e9})")
    check(wait_for(page, f"{JUMP} === 'hidden'", 3000), "(and at the bottom there is no pill)")

    n_voice = add_activity(ctl, "olga", "voice", "Voice call · 4 min", "Talked through Raft leader election and split votes", VOICE_DETAIL)
    n_memory = add_activity(ctl, "olga", "memory", "Remembered", "Prefers problem-first explanations")
    n_progress = add_activity(ctl, "olga", "progress", "Progress updated", "Raft leader election: just started → getting there")
    n_due = add_activity(ctl, "olga", "course", "Due soon", "Midterm Mastery Part 2 · due Mon Nov 9, 9:00 AM PST")
    n_news = add_activity(ctl, "olga", "course", "Due date moved", "HW3 · now due Wed Nov 11, 11:59 PM PST", NEWS_DETAIL)
    n_talk = add_activity(ctl, "olga", "talk", "Talk it through · 6 min", "You talked Paxos through, out loud", "You explained single-decree Paxos in your own words.\nStrong: the two phases. Next: what a proposer does after a rejected prepare.")
    n_interview = add_activity(ctl, "olga", "interview", "Mock interview · 12 min", "Mock interview on HW3: clear on the design, thin on failure cases", "Questions: 5.\nClear: the design.\nThin: what happens when the leader crashes mid-commit.")
    n_sync = add_activity(ctl, "olga", "sync", "Synced with Canvas", "3 new grades")
    n_legacy = add_activity(ctl, "olga", "voice", "", LEGACY_SUMMARY, legacy=True)
    check(wait_for(page, "document.querySelectorAll('.row.activity').length === 13", 10000), "every line is a card in the conversation, at its place")
    check(reply_count(page) == 2 and page.locator(".row.assistant:has(.acard)").count() == 0 and page.locator(".voice-tag").count() == 0, "none of them is one of TAi's replies (they are still two), and nothing is a headset bubble")

    print("an old thumb is ignored")
    n_first = int(page.locator(REPLIES).first.get_attribute("data-n"))
    rows_before, stamps_before = page.locator(".row[data-n]").count(), page.locator(".stamp").count()
    posted = page.evaluate("(n) => fetch('api/feedback', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tai': '1' }, body: JSON.stringify({ to: n, rating: 'up' }) }).then((r) => r.status)", n_first)
    check(posted == 200, "(the server still takes a thumb from whatever sends one: it is the page that has none to give)", str(posted))
    page.wait_for_timeout(1500)                 # the poll brings the line
    check(page.locator(".row[data-n]").count() == rows_before and page.locator(".stamp").count() == stamps_before and page.locator(".row.typing").count() == 0 and page.evaluate(JUMP) in ("hidden", "arrow") and page.title() == "TAi", "a line of a thumb, such as older histories hold, is ignored silently: no bubble, no time stamp, no dots, no count")
    check(page.locator(".act[data-act='up'], .act[data-act='down']").count() == 0 and page.locator(f".row.assistant[data-n='{n_first}'] .act").count() == 3, "and shows nowhere: the reply still has its smiley, copy and quote and nothing else")

    print("a call's card")
    voice = card_row(page, n_voice)
    head = voice.locator(".acard-head")
    check(head.locator(".acard-title").inner_text() == "Voice call · 4 min" and head.locator(".acard-text").inner_text() == "Talked through Raft leader election and split votes", "a call's card has its title and one line about it")
    clock = head.locator("time.acard-time").inner_text()
    check(re.fullmatch(r"\d{1,2}:\d\d( [ap]m)?", clock) is not None, "and the time of day", clock)
    check(head.evaluate("(h) => h.tagName") == "BUTTON" and head.get_attribute("aria-expanded") == "false" and head.get_attribute("aria-controls") == voice.locator(".acard-detail").get_attribute("id") and voice.locator(".acard-detail").is_hidden(), "the whole card is a button that opens its detail: closed to begin with, and it names what it opens")
    line_style = head.locator(".acard-text").evaluate("(t) => { const s = getComputedStyle(t); return [s.whiteSpace, s.textOverflow, s.overflow]; }")
    cut = card_row(page, n_reminder).locator(".acard-text")
    check(line_style == ["nowrap", "ellipsis", "hidden"] and cut.evaluate("(t) => t.scrollWidth > t.clientWidth && t.getBoundingClientRect().height < 24"), "its line stays one line, cut with an ellipsis when it is longer than the card", str(line_style))
    head.click()
    check(head.get_attribute("aria-expanded") == "true" and voice.locator(".acard-detail").is_visible(), "a click opens it, right there in the conversation")
    detail = voice.locator(".acard-detail-text")
    check(detail.inner_text() == VOICE_DETAIL and detail.evaluate("(t) => getComputedStyle(t).whiteSpace") == "pre-wrap", "with the whole account, its line breaks kept", detail.inner_text())
    check(all(voice.locator(f".act[data-act='{act}']").count() == 0 for act in ("react", "copy", "quote", "up", "down")) and voice.locator(".acard-detail button").count() == 0, "and nothing to press in it: no emoji, copy, quote or thumbs (it is a record, not something TAi said)")
    check(page.locator(".act[data-act='up'], .act[data-act='down'], .fbmenu").count() == 0, "(no thumb anywhere in the conversation)")
    head.click()
    check(head.get_attribute("aria-expanded") == "false" and voice.locator(".acard-detail").is_hidden(), "a second click closes it")
    head.focus()
    page.keyboard.press("Enter")
    check(head.get_attribute("aria-expanded") == "true", "so does the keyboard: Enter opens it")
    page.keyboard.press("Space")
    check(head.get_attribute("aria-expanded") == "false", "and Space closes it")
    check(page.title() == "TAi" and page.locator(".row.typing").count() == 0, "(no dots, no count: a card is nothing TAi is working on)")

    print("a note, a reminder, progress, news")
    for n, what in ((n_memory, "a note TAi kept"), (n_reminder, "a reminder"), (n_progress, "a step of progress"), (n_due, "a course date without a detail"), (n_sync, "a kind of line the page does not know")):
        row = card_row(page, n)
        light = row.locator(".acard-head")
        check(light.evaluate("(h) => h.tagName") == "DIV" and light.get_attribute("aria-expanded") is None and row.locator(".acard-chev").count() == 0, f"{what} has nothing to open: a plain card, with no chevron and no button")
        light.click()
        check(row.locator(".acard-detail").is_hidden() and row.locator(".act, .acard-detail button").count() == 0, "(a click changes nothing, and there is nothing to press in it)")
    check(card_row(page, n_memory).get_attribute("data-type") == "memory" and card_row(page, n_memory).locator(".acard-title").inner_text() == "Remembered", "(the note's card is still titled Remembered)")
    news = card_row(page, n_news)
    news.locator(".acard-head").click()
    check(news.locator(".acard-detail-text").inner_text() == NEWS_DETAIL and news.locator(".act, .acard-detail button").count() == 0, "a course card with a detail opens to it, and has nothing to press in it")
    news.locator(".acard-head").click()
    talk = card_row(page, n_talk)
    interview = card_row(page, n_interview)
    check(talk.get_attribute("data-type") == "talk" and interview.get_attribute("data-type") == "interview", "a talk-it-through and a mock interview are cards like a call's")
    talk.locator(".acard-head").click()
    check("single-decree Paxos" in talk.locator(".acard-detail").inner_text() and talk.locator(".act, .acard-detail button").count() == 0, "which open to their account, with nothing to press in it")
    talk.locator(".acard-head").click()
    sync = card_row(page, n_sync)
    check(sync.get_attribute("data-type") == "note" and sync.locator(".acard-title").inner_text() == "Synced with Canvas", "a kind the page does not know is still a card, with the title it came with")
    icons = dict(page.evaluate(CARD_ICONS))
    check(set(icons) == {"voice", "talk", "interview", "memory", "reminder", "progress", "course", "note"} and len(set(icons.values())) == 8 and all(icons.values()), "each kind has an icon of its own, and an unknown one a plain icon", str(sorted(icons)))
    legacy = card_row(page, n_legacy)
    one_line = legacy.locator(".acard-text").inner_text()
    check(legacy.locator(".acard-title").inner_text() == "Voice call" and legacy.get_attribute("data-type") == "voice", "a long summary of the older kind is a card titled Voice call")
    check(one_line.startswith("We talked through Raft elections and split votes in some detail") and one_line.endswith("…") and len(one_line) <= 110, "with its first sentence as the line, cut to one", one_line)
    legacy.locator(".acard-head").click()
    check(legacy.locator(".acard-detail-text").inner_text() == LEGACY_SUMMARY and legacy.locator(".act, .acard-detail button").count() == 0, "and the whole summary as its detail, with nothing to press in it")
    legacy.locator(".acard-head").click()
    shots(page, out, "122-activity-cards", focus=f"document.querySelector('.row.activity[data-n=\"{n_reminder}\"]').scrollIntoView({{ block: 'start' }})")
    voice.locator(".acard-head").click()
    shots(page, out, "123-activity-call-open", focus=f"document.querySelector('.row.activity[data-n=\"{n_voice}\"]').scrollIntoView({{ block: 'center' }})")
    voice.locator(".acard-head").click()

    print("the Chats drawer")
    page.click("#chats-btn")
    check(page.locator("#drawer-activity").is_visible() and "Activity" in page.inner_text("#drawer-activity"), "the Chats drawer has a way in too")
    check([c.inner_text() for c in page.locator(".day-count").all()] == ["4 messages, 10 activities", "2 activities", "1 activity"], "and counts each day's calls and notes apart from its messages", str([c.inner_text() for c in page.locator(".day-count").all()]))
    page.fill("#search-input", "Paxos")
    check(wait_for(page, "document.querySelectorAll('.hit').length === 1", 3000) and page.locator(".hit .hit-who").first.inner_text().startswith("Activity · "), "its search finds a call by what it was about, labelled Activity")
    page.fill("#search-input", "mock interview")
    check(wait_for(page, "document.querySelectorAll('.hit').length === 1", 3000), "and by its title")
    page.locator(".hit").first.click()
    check(page.locator("#drawer").is_hidden() and wait_for(page, f"!!document.querySelector('.row.activity.flash[data-n=\"{n_interview}\"]')", 2500), "choosing the hit takes the reader to the card, lit")
    page.click("#chats-btn")
    page.click("#drawer-activity")
    check(page.locator("#drawer").is_hidden() and wait_for(page, SHEET_OPEN), "the drawer's button closes it and opens the sheet")

    print("the sheet, day by day")
    check(wait_for(page, f"{SHEET_TITLES}.length === 13"), "the sheet lists every line")
    headings = page.evaluate(SHEET_HEADINGS)
    check(headings == ["Today", "Yesterday", date_heading(page, 5)], "grouped by day: Today, Yesterday, then the date", str(headings))
    titles = page.evaluate(SHEET_TITLES)
    want = ["Voice call", "Synced with Canvas", "Mock interview · 12 min", "Talk it through · 6 min", "Due date moved", "Due soon", "Progress updated", "Remembered", "Voice call · 4 min", "Reminder",
            "Reminder", "New announcement", "Progress updated"]
    check(titles == want, "newest first within a day", str(titles))
    check(page.locator("#activity-body .act-item .acard-tile svg").count() == 13 and page.locator("#activity-body .act-item time.acard-time").count() == 13, "each row has its icon and its time of day")
    row = sheet_row(page, n_voice)
    check(row.locator(".acard-head").get_attribute("aria-expanded") == "false" and row.locator(".acard-detail").is_hidden(), "rows are closed")
    row.locator(".acard-head").click()
    check(row.locator(".acard-head").get_attribute("aria-expanded") == "true" and row.locator(".acard-detail-text").inner_text() == VOICE_DETAIL, "a click opens a row right there, with the account")
    check(row.locator(".acard-show").inner_text() == "Show in the conversation", "and offers to show it in the conversation")
    row.locator(".acard-head").click()
    mem = sheet_row(page, n_memory)
    mem.locator(".acard-head").click()
    check(mem.locator(".acard-show").inner_text() == "Show in the conversation" and mem.locator(".acard-detail button").count() == 1, "a note's row opens to that one button, and no other: the page has no notes to show")
    mem.locator(".acard-head").click()
    old = sheet_row(page, n_old_news)
    old.locator(".acard-head").click()
    check(old.locator(".acard-detail-text").inner_text() == OLD_NEWS_DETAIL, "an older course row opens to its detail too")
    old.locator(".acard-head").click()
    shots(page, out, "124-activity-sheet")
    check(page.evaluate(SHEET_OPEN), "(the sheet is still open)")

    print("a line that arrives while it is open")
    n_live = add_activity(ctl, "olga", "progress", "Progress updated", "Paxos: just started → getting there")
    check(wait_for(page, f"{SHEET_TITLES}.length === 14 && {SHEET_TITLES}[0] === 'Progress updated' && document.querySelector('#activity-body .act-item').dataset.n === '{n_live}'", 8000), "a new line joins the top of the sheet, with nothing to refresh")
    check(wait_for(page, "document.querySelector('#activity-live').textContent === 'New: Progress updated'", 2000), "and a screen reader is told")
    check(page.evaluate(SHEET_HEADINGS) == ["Today", "Yesterday", date_heading(page, 5)], "(the days are as they were)")

    print("from a card to the sheet and back")
    row = sheet_row(page, n_voice)
    row.locator(".acard-head").click()
    row.locator(".acard-show").click()
    check(not page.evaluate(SHEET_OPEN), "Show in the conversation closes the sheet")
    check(wait_for(page, card_in_view(page, n_voice), 5000), "and takes the reader to the call's card, open")
    check(page.evaluate("!document.querySelector('#activity').contains(document.activeElement)"), "(the focus is not left on a sheet that is gone)")

    print("more of them")
    add_activity(ctl, "olga", "reminder", "Reminder", "A reminder, one of many", count=33)
    check(wait_for(page, "document.querySelectorAll('.row.activity').length === 47", 10000), "thirty-three more lines arrive")
    requests: list[str] = []
    page.on("request", lambda r: "api/activity" in r.url and requests.append(r.url))
    page.click("#rail-activity")
    check(wait_for(page, f"{SHEET_TITLES}.length === 30"), "the sheet shows thirty at a time")
    check(page.locator("#activity-body .act-more").inner_text() == "Show more", "with a button for the rest")
    oldest = min(int(i.get_attribute("data-n")) for i in page.locator("#activity-body .act-item").all())
    shots(page, out, "125-activity-more")
    page.click("#activity-body .act-more")
    check(wait_for(page, f"{SHEET_TITLES}.length === 47"), "which adds the older ones")
    check(requests[-1].endswith(f"api/activity?limit=30&before={oldest}"), "asking the server for the lines before the oldest it showed", str(requests[-2:]))
    check(page.locator("#activity-body .act-more").count() == 0, "and the button goes when there are no more")
    check(page.evaluate(SHEET_HEADINGS) == ["Today", "Yesterday", date_heading(page, 5)], "with each day still named once")
    check(page.evaluate("document.activeElement.classList.contains('acard-head') && document.querySelector('#activity-body').contains(document.activeElement)"), "the focus is on the first of the new rows, so a keyboard reader goes on from there")
    page.keyboard.press("Escape")

    print("when the server cannot be reached")
    page.route("**/api/activity**", lambda route: route.abort())
    page.click("#rail-activity")
    check(wait_for(page, "document.querySelector('#activity-body').textContent.includes('cannot be reached')"), "a sheet that cannot load says so, in plain words")
    check(page.locator("#activity-body .btn-plain").inner_text() == "Try again", "with a way to try again")
    page.unroute("**/api/activity**")
    page.click("#activity-body .btn-plain")
    check(wait_for(page, f"{SHEET_TITLES}.length === 30"), "which loads it")
    page.keyboard.press("Escape")
    check(wait_for(page, "document.activeElement.id === 'rail-activity'", 3000), "(the focus goes back to where it came from)")

    print("a reload")
    page.reload()
    check(wait_for(page, "document.querySelectorAll('.row.activity').length === 47", 10000), "after a reload every card is still there")
    check(page.locator(".row.activity .acard-head[aria-expanded='true']").count() == 0 and page.locator(".row.assistant:has(.acard)").count() == 0, "closed again, and still none of them a reply of TAi's")
    check(page.evaluate("document.querySelectorAll('.row[data-n]').length") == 47 + 4, "(and the messages are there as before)")
    check(page.title() == "TAi" and page.evaluate(JUMP) in ("hidden", "arrow"), "with no count anywhere")

    print("a session that ended")
    page.evaluate("fetch('auth/logout', { method: 'POST', headers: { 'x-tai': '1', 'content-type': 'application/json' }, body: '{}' })")
    page.wait_for_timeout(300)
    page.click("#rail-activity")
    check(wait_for(page, "document.querySelector('#chat').dataset.mode === 'gate'", 5000) and not page.evaluate(SHEET_OPEN), "a sheet opened after the session ended closes itself and shows the sign-in")
    check(page.locator("#rail-activity").is_hidden(), "and the rail's Activity button goes with the rest of the signed-in page")
    clean(page, problems, "the activity list")
    context.close()


def activity_phone(browser, base, off, ctl, out):
    print("the activity list on a phone")
    context, page, problems = student(browser, base, "dev:quinn@example.com", viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2)
    n_call = add_activity(ctl, "quinn", "voice", "Voice call · 12 min", "Talked through Raft leader election, split votes, and what a candidate does when its term is stale", VOICE_DETAIL)
    n_course = add_activity(ctl, "quinn", "course", "New announcement about the midterm and the review session", "Midterm Mastery Part 2 · due Mon Nov 9, 9:00 AM PST, and the review session moves to Thursday")
    n_memory = add_activity(ctl, "quinn", "memory", "Remembered", "Prefers problem-first explanations")
    check(wait_for(page, "document.querySelectorAll('.row.activity').length === 3", 8000), "cards arrive on a phone too")
    check(page.evaluate("[...document.querySelectorAll('.row.activity .acard')].every((c) => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; })") and page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "they fit the screen, and nothing sticks out sideways")
    check(card_row(page, n_course).locator(".acard-title").evaluate("(t) => t.scrollWidth > t.clientWidth && t.getBoundingClientRect().height < 24"), "a long title is cut with an ellipsis, not wrapped")
    page.screenshot(path=str(out / "126-activity-cards-dark-phone.png"))
    call = card_row(page, n_call)
    call.locator(".acard-head").tap()
    check(call.locator(".acard-head").get_attribute("aria-expanded") == "true" and "Next time: log replication." in call.locator(".acard-detail").inner_text() and call.locator(".act, .acard-detail button").count() == 0, "a tap opens a call's card to its account, and there is nothing to press in it")
    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "(and nothing sticks out sideways)")
    page.screenshot(path=str(out / "127-activity-call-open-dark-phone.png"))
    page.evaluate("document.documentElement.dataset.theme = 'light'")
    page.wait_for_timeout(300)
    page.screenshot(path=str(out / "128-activity-call-open-light-phone.png"))
    page.evaluate("document.documentElement.dataset.theme = 'dark'")
    call.locator(".acard-head").tap()
    check(card_row(page, n_memory).locator(".acard-chev").count() == 0 and card_row(page, n_memory).locator(".acard-title").inner_text() == "Remembered", "a note's card is a plain one, with nothing to open")

    print("a long press on a card")
    cdp = context.new_cdp_session(page)

    def finger(kind: str, x: float, y: float) -> None:
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [] if kind == "touchEnd" else [{"x": x, "y": y}]})

    tile = card_row(page, n_course).locator(".acard-tile").bounding_box()
    x, y = tile["x"] + tile["width"] / 2, tile["y"] + tile["height"] / 2
    finger("touchStart", x, y)
    page.wait_for_timeout(800)
    finger("touchEnd", x, y)
    page.wait_for_timeout(300)
    check(not page.evaluate(PICKER_OPEN), "it opens no emoji: a card is not something TAi said")

    print("the sheet on a phone")
    add_activity(ctl, "quinn", "reminder", "Reminder", "A reminder, one of a dozen", count=12)
    check(wait_for(page, "document.querySelectorAll('.row.activity').length === 15", 8000), "a dozen more lines arrive")
    check(page.locator("#rail-activity").is_hidden() and page.locator(".rail").is_hidden(), "a phone has no rail, so no rail button")
    page.locator("#chats-btn").tap()
    page.wait_for_timeout(450)                          # the drawer slides in
    check(page.locator("#drawer-activity").is_visible() and "Activity" in page.inner_text("#drawer-activity"), "the Chats drawer is the left panel there, and it has the Activity entry")
    page.screenshot(path=str(out / "131-activity-drawer-dark-phone.png"))
    page.locator("#drawer-activity").tap()
    check(page.locator("#drawer").is_hidden() and wait_for(page, SHEET_OPEN) and wait_for(page, f"{SHEET_TITLES}.length === 15"), "its entry opens the sheet, and the drawer goes")
    fits = page.evaluate("(() => { const r = document.querySelector('#activity').getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight; })()")
    check(fits and page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "it fits the phone, and nothing sticks out sideways")
    check(page.evaluate("(() => { const b = document.querySelector('#activity-body'); return b.scrollHeight > b.clientHeight && getComputedStyle(b).overflowY === 'auto'; })()"), "and scrolls inside itself when it is longer than the screen")
    check(page.evaluate("[...document.querySelectorAll('#activity-body .acard-title, #activity-body .acard-text')].every((t) => { const r = t.getBoundingClientRect(), s = document.querySelector('#activity').getBoundingClientRect(); return r.right <= s.right; })"), "no row's words run past its edge")
    page.screenshot(path=str(out / "129-activity-sheet-dark-phone.png"))
    row = sheet_row(page, n_call)
    row.locator(".acard-head").tap()
    check(row.locator(".acard-detail-text").is_visible() and row.locator(".acard-show").is_visible(), "a tap opens a row, with the way to the conversation")
    row.locator(".acard-show").tap()
    check(not page.evaluate(SHEET_OPEN) and wait_for(page, card_in_view(page, n_call), 5000), "which takes the reader to the card, open")
    page.locator("#chats-btn").tap()
    page.wait_for_timeout(450)                          # the drawer slides in
    page.locator("#drawer-activity").tap()
    check(page.locator("#drawer").is_hidden() and wait_for(page, SHEET_OPEN), "(and again from the drawer)")
    page.evaluate("document.documentElement.dataset.theme = 'light'")
    page.wait_for_timeout(300)
    page.screenshot(path=str(out / "130-activity-sheet-light-phone.png"))
    page.keyboard.press("Escape")
    check(wait_for(page, f"!{SHEET_OPEN} && document.activeElement.id === 'chats-btn'", 3000), "Escape closes it and the focus goes back to Chats")
    clean(page, problems, "the activity list on a phone")
    context.close()


# ---------------------------------------------------------------- options to tap: a quick check, or ways to answer a question

RAFT_OPTIONS = ["Every heartbeat starts a new term", "A term has at most one leader", "The term number can go down after a failure"]
RAFT_WHY = "Each term starts with an election and has at most one winner; terms only go up."
CHOICE_STATES = "(r) => [...r.querySelectorAll('.choice')].map((b) => b.dataset.state)"
CHOICES_OFF = "(r) => [...r.querySelectorAll('.choice')].every((b) => b.disabled || b.getAttribute('aria-disabled') === 'true')"
CHOICES_ON = "(r) => [...r.querySelectorAll('.choice')].every((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true')"


def ask_options(ctl, who: str, text: str = "Which of these is true of a Raft term?", options=None, quiz: bool = False, key=None, why: str = "", doubt: bool = False) -> None:
    """TAi asks with options to tap (the dev server's control port makes it send the line; `key`, the index of the right option, stays the server's secret;
    `doubt`: the host dropped a key it doubted, so a quick check whose taps have no right or wrong)."""
    body: dict = {"text": text, "options": options or RAFT_OPTIONS, "quiz": quiz}
    if key is not None:
        body["key"] = key
        body["why"] = why or RAFT_WHY
    elif doubt:
        body["doubt"] = True
        body["why"] = why or RAFT_WHY
    ctl.post(f"choices?who={who}", json.dumps(body))


def options_row(page, count: int):
    """The `count`-th line with options on the page (waited for): its row."""
    wait_for(page, f"document.querySelectorAll('.row.assistant.has-choices').length === {count}", 8000)
    return page.locator(".row.assistant.has-choices").nth(count - 1)


def wait_states(page, row, expected: list, timeout_ms: int = 8000) -> bool:
    """Waits until the options of that row look like `expected` (the state of each button)."""
    n = int(row.get_attribute("data-n"))
    want = json.dumps(json.dumps(expected, separators=(",", ":")))
    return wait_for(page, f"JSON.stringify([...document.querySelectorAll('.row.has-choices[data-n=\"{n}\"] .choice')].map((b) => b.dataset.state)) === {want}", timeout_ms)


def watch_taps(page) -> list:
    """The bodies of the taps the page sends (POST api/choose)."""
    taps: list = []
    page.on("request", lambda r: r.method == "POST" and "api/choose" in r.url and taps.append(json.loads(r.post_data or "{}")))
    return taps


def choices_quiz(browser, base, off, ctl, out):
    print("a quick check")
    context, page, problems = student(browser, base, "dev:sam@example.com")
    check(page.evaluate("fetch('api/me').then(r => r.json()).then(d => d.features.choices)") is True, "the server says options can be tapped")
    taps = watch_taps(page)
    ask_options(ctl, "sam", quiz=True, key=1)
    row = options_row(page, 1)
    n = int(row.get_attribute("data-n"))
    check(row.locator(".md").inner_text() == "Which of these is true of a Raft term?", "TAi asks its question as words, in its bubble")
    check(row.locator(".choices-label").text_content() == "Quick check", "a small label above the options says it is a quick check")
    group = row.locator(".choices-list")
    check(group.get_attribute("role") == "group" and group.get_attribute("aria-label") == "Options", "the options are a group named Options")
    buttons = row.locator(".choice")
    check(buttons.count() == 3 and all(b.evaluate("(x) => x.tagName") == "BUTTON" for b in buttons.all()), "of three real buttons")
    check([b.locator(".choice-chip").inner_text() for b in buttons.all()] == ["A", "B", "C"] and [b.locator(".choice-text").inner_text() for b in buttons.all()] == RAFT_OPTIONS, "each with its letter and its words")
    check(row.evaluate(CHOICES_ON) and row.evaluate(CHOICE_STATES) == ["open", "open", "open"], "all of them on, none marked")
    history = page.evaluate("fetch('api/history').then(r => r.text())")
    check("secret" not in history and '"key"' not in history and "terms only go up" not in history and "terms only go up" not in page.content(), "the answer TAi marked is nowhere the page can see: not in the history it was sent, not on the page")
    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth") and row.locator(".bubble").evaluate("(b) => [...b.querySelectorAll('.choice')].every((c) => c.getBoundingClientRect().right <= b.getBoundingClientRect().right + 1)"), "the options fit the bubble, and nothing sticks out sideways")
    shots(page, out, "130-choices-open", focus=f"document.querySelector('.row.has-choices[data-n=\"{n}\"]').scrollIntoView({{ block: 'center' }})")

    print("the right answer")
    held: list = []
    page.route("**/api/choose", lambda route: held.append(route))             # the answer is held back for a moment, to see the page in between
    users = page.locator(".row.user").count()
    buttons.nth(1).click()
    check(wait_for(page, f"document.querySelectorAll('.row.user').length === {users + 1}", 3000) and page.locator(".row.user").last.inner_text() == "B. A term has at most one leader", "a tap puts the student's own message on the page at once: the letter and the option")
    check(row.evaluate(CHOICES_OFF) and row.evaluate(CHOICE_STATES) == ["dim", "pending", "dim"], "and turns all the options off at once, the one tapped marked")
    check(settle(page, lambda: len(held) == 1, 3000), "while the page asks the server")
    held[0].continue_()
    page.unroute("**/api/choose")
    check(wait_states(page, row, ["dim", "right", "dim"]), "the server says it was right: a tick on it, the others dimmed")
    check(row.locator(".choice[data-state='right'] .choice-mark svg").count() == 1 and row.locator(".choice[data-state='right']").get_attribute("aria-current") == "true", "(the tick is an icon on the button, and the button says it is the one chosen)")
    check(row.locator(".choices > .sr-only").text_content() == "Correct" and row.locator(".choices > .sr-only").get_attribute("aria-live") == "polite", "and the verdict is said politely: Correct")
    check(row.evaluate(CHOICES_OFF) and taps == [{"to": n, "index": 1}], "all off, and the page sent one tap", str(taps))
    heard = ctl.get("seen?who=sam")
    check(len(heard) == 1 and heard[0].startswith('[The student answered your multiple-choice question "Which of these is true of a Raft term?"') and "That is the answer you marked." in heard[0] and heard[0].endswith("]\nB. A term has at most one leader"), "TAi was handed the tap with its verdict, for TAi only", str(heard))
    check(wait_reply(page, 2) and page.locator(REPLIES).last.inner_text() == "Thanks for answering. Shall we go on?", "TAi answers it like a message")
    check(wait_states(page, row, ["dim", "right", "dim"], 1000), "and the answered question stays answered")
    shots(page, out, "131-choices-right", focus=f"document.querySelector('.row.has-choices[data-n=\"{n}\"]').scrollIntoView({{ block: 'center' }})")

    print("a reload")
    page.reload()
    row = options_row(page, 1)
    check(wait_states(page, row, ["dim", "right", "dim"]) and row.evaluate(CHOICES_OFF), "after a reload the question is answered as it was, from the lines of the history")
    check(row.locator(".choices > .sr-only").text_content() == "", "(a verdict that is only read back is not said again)")
    check(row.locator(".choice[data-state='right'] .choice-mark .sr-only").text_content() == "Correct", "but the option chosen says in its own words that it was right, for a reader who comes to it after a reload")
    check(page.locator(".row.user").filter(has_text="B. A term has at most one leader").count() == 1, "and the student's message is there once")

    print("a wrong answer")
    ask_options(ctl, "sam", text="Which of these is true of a Raft heartbeat?", options=["It carries the log", "It stops an election", "It is only sent by followers"], quiz=True, key=0)
    row2 = options_row(page, 2)
    n2 = int(row2.get_attribute("data-n"))
    row2.locator(".choice").nth(1).click()
    check(wait_states(page, row2, ["dim", "wrong", "dim"]), "a wrong pick shows a cross on it, and only dims the others")
    check(row2.locator(".choice[data-state='wrong'] .choice-mark svg").count() == 1 and row2.locator(".choices > .sr-only").text_content() == "Not quite", "(the verdict said is Not quite)")
    check(row2.locator(".choice[data-state='wrong'] .choice-mark .sr-only").text_content() == "Not quite", "(and the cross has its words for a screen reader)")
    check(row2.locator("[data-state='right']").count() == 0 and "data-state=\"right\"" not in row2.inner_html(), "it does not give away which one was right")
    page.wait_for_timeout(500)                  # (the dimming is a short transition)
    check(row2.evaluate("(r) => { const [a, , c] = r.querySelectorAll('.choice'); const look = (b) => { const k = getComputedStyle(b); return [k.opacity, k.backgroundColor, k.borderColor].join('|'); }; return look(a) === look(c); }"), "(the right option looks exactly like the other one that was not picked)")
    check(taps[-1] == {"to": n2, "index": 1}, "the tap named the line and the option", str(taps[-1]))
    shots(page, out, "132-choices-wrong", focus=f"document.querySelector('.row.has-choices[data-n=\"{n2}\"]').scrollIntoView({{ block: 'center' }})")

    print("the bubble is still a bubble")
    row2.hover()
    check(row2.locator(".act").count() == 3 and row2.locator(".act[data-act='react']").is_visible(), "its smiley, copy and quote are beside it as before")
    row2.locator(".act[data-act='copy']").click()
    check(wait_for(page, "document.querySelector('#toast').textContent === 'Copied'", 3000), "(copy says it copied)")
    copied = page.evaluate("navigator.clipboard.readText()").replace("\r\n", "\n")        # (the system clipboard of Windows writes its line ends as CR LF)
    check(copied == "Which of these is true of a Raft heartbeat?\n\nA. It carries the log\nB. It stops an election\nC. It is only sent by followers", "copying gives the question and then the options as lines", repr(copied))
    page.click("#chats-btn")
    page.fill("#search-input", "Raft heartbeat")
    check(wait_for(page, "document.querySelectorAll('.hit').length === 1", 3000), "the drawer's search finds the question")
    page.keyboard.press("Escape")
    check(page.locator(".row.user").count() == 2, "(and a tap is one message of the student's, not two)")
    clean(page, problems, "the quick check")
    context.close()


def choices_replies(browser, base, off, ctl, out):
    print("ways to answer a question")
    context, page, problems = student(browser, base, "dev:tara@example.com")
    taps = watch_taps(page)
    asked = 0

    def ask(**kw):
        nonlocal asked
        ask_options(ctl, "tara", **kw)
        asked += 1
        return options_row(page, asked)

    row = ask(text="Which part is confusing?", options=["The election timeout", "Log replication <b>not bold</b>", "Safety & the commit rule"])
    n = int(row.get_attribute("data-n"))
    check(row.locator(".choices-label").count() == 0, "a question with no answer to give is not called a quick check")
    check(row.locator(".choice").nth(1).locator(".choice-text").inner_text() == "Log replication <b>not bold</b>" and row.locator(".choice b").count() == 0, "an option's words go on the page as words: markup in them is shown, not drawn")
    row.locator(".choice").nth(2).click()
    check(wait_states(page, row, ["dim", "dim", "chosen"]), "a tap marks the one chosen, with no tick and no cross: it is a pick, not an answer")
    check(row.locator(".choice-mark svg").count() == 0 and row.locator(".choices > .sr-only").text_content() == "", "and says nothing of right or wrong")
    check(page.locator(".row.user").last.inner_text() == "C. Safety & the commit rule" and taps == [{"to": n, "index": 2}], "the student's message is the letter and the option")
    heard = ctl.get("seen?who=tara")
    check(len(heard) == 1 and heard[0].startswith('[The student picked an option on your question "Which part is confusing?"') and "marked" not in heard[0], "TAi was handed it as a pick, with no word of marking", str(heard))
    check(wait_reply(page, 2), "TAi answers it")

    print("options closed by typing instead")
    row = ask(text="Shall we start with the election?", options=["Yes", "No, with the log"])
    typed = page.locator(".row.user").count()
    send(page, "I would rather say it myself")
    check(wait_states(page, row, ["closed", "closed"]) and row.evaluate(CHOICES_OFF), "words typed instead close the options at once: off and dimmed, nothing highlighted")
    before = len(taps)
    row.locator(".choice").first.click(force=True)
    page.wait_for_timeout(300)
    check(len(taps) == before and page.locator(".row.user").count() == typed + 1, "a tap on a closed option does nothing")
    check(wait_reply(page, 4), "(TAi answers the words)")
    check(row.evaluate(CHOICE_STATES) == ["closed", "closed"], "and they stay closed")

    print("options closed by TAi saying more")
    row = ask(text="Which one is the follower?", options=["A", "B", "C"])
    row.locator(".choice").nth(1).focus()
    ctl.post("say?who=tara&text=" + urllib.parse.quote("Actually, one more thing first."))
    check(wait_states(page, row, ["closed", "closed", "closed"]) and row.evaluate(CHOICES_OFF), "TAi saying more closes the options before it")
    check(page.evaluate("document.activeElement.classList.contains('choice') && document.activeElement.dataset.index === '1'"), "(the focus stays on the button it was on: a poll that redraws does not move it)")

    print("an emoji is not something said")
    row = ask(text="Is this clear so far?", options=["Yes", "Not yet"])
    react_to(page, row, "👍")
    check(wait_for(page, f"({MY_BADGE})({int(row.get_attribute('data-n'))}) === '👍'") and row.evaluate(CHOICE_STATES) == ["open", "open"] and row.evaluate(CHOICES_ON), "an emoji on the question leaves the options open")
    add_activity(ctl, "tara", "reminder", "Reminder", "Review the Raft paper")
    check(wait_for(page, "document.querySelectorAll('.row.activity').length === 1", 8000) and row.evaluate(CHOICES_ON), "and so does a card of the activity list")

    print("the keyboard")
    row = ask(text="Which of these do you want first?", options=["The election", "The log", "Safety"])
    n = int(row.get_attribute("data-n"))
    row.locator(".choice").nth(0).focus()
    page.keyboard.press("Tab")
    check(page.evaluate("document.activeElement.classList.contains('choice') && document.activeElement.dataset.index === '1'"), "Tab moves along the options")
    page.keyboard.press("Enter")
    check(wait_states(page, row, ["dim", "chosen", "dim"]) and taps[-1] == {"to": n, "index": 1}, "Enter takes the one the focus is on")
    check(page.evaluate("document.activeElement.classList.contains('choice') && document.activeElement.dataset.index === '1'"), "and the focus stays on it (it is off now, but not lost)")
    check(wait_reply(page, 9) and page.evaluate("document.activeElement.dataset.index") == "1", "a reply that arrives and redraws the conversation leaves it there")
    row = ask(text="And then?", options=["The log", "Safety"])
    n = int(row.get_attribute("data-n"))
    row.locator(".choice").nth(1).focus()
    page.keyboard.press("Space")
    check(wait_states(page, row, ["dim", "chosen"]) and taps[-1] == {"to": n, "index": 1}, "Space does too")

    print("a quick check whose answer TAi dropped")
    check(wait_reply(page, 11), "(TAi answers the last tap)")
    row = ask(text="Which of these is true of a Raft term?", quiz=True, doubt=True)
    n = int(row.get_attribute("data-n"))
    check(row.locator(".choices-label").text_content() == "Quick check", "it is still a quick check to the student")
    row.locator(".choice").nth(1).click()
    check(wait_states(page, row, ["dim", "chosen", "dim"]) and row.locator(".choice-mark svg").count() == 0 and row.locator(".choices > .sr-only").text_content() == "", "a tap is only marked as chosen: no tick, no cross and no word of right or wrong")
    chosen = page.evaluate("fetch('api/history').then(r => r.json()).then(d => d.entries.filter((e) => e.choice).pop().choice)")
    check(chosen == {"to": n, "index": 1}, "the line of the tap says which one it was, and not whether it was right", str(chosen))
    heard = ctl.get("seen?who=tara")[-1]
    check(heard.startswith('[The student answered your multiple-choice question "Which of these is true of a Raft term?"') and "did not hold up" in heard, "and TAi is told its key did not hold up", heard[:200])
    clean(page, problems, "the options")
    context.close()


def choices_failures(browser, base, off, ctl, out):
    print("when a tap does not go through")
    context, page, problems = student(browser, base, "dev:uma@example.com")
    taps = watch_taps(page)
    ask_options(ctl, "uma", quiz=True, key=1)
    row = options_row(page, 1)
    n = int(row.get_attribute("data-n"))
    users = page.locator(".row.user").count()
    ctl.post("unreachable?who=uma&on=1")
    row.locator(".choice").nth(1).click()
    check(wait_for(page, "document.querySelector('#toast').textContent.includes('TAi could not be reached')", 5000), "when TAi cannot be reached the page says so plainly")
    check(wait_states(page, row, ["open", "open", "open"]) and row.evaluate(CHOICES_ON), "and the options are on again: nothing was recorded")
    check(page.locator(".row.user").count() == users and not ctl.get("seen?who=uma"), "the message it had shown goes again, and TAi was told nothing")
    ctl.post("unreachable?who=uma&on=0")
    row.locator(".choice").nth(1).click()
    check(wait_states(page, row, ["dim", "right", "dim"]) and taps == [{"to": n, "index": 1}, {"to": n, "index": 1}], "tapped again, it goes through", str(taps))
    check(wait_reply(page, 2), "(and TAi answers it)")

    print("too many taps")
    ask_options(ctl, "uma", text="Another one?", options=["Yes", "No"])
    row = options_row(page, 2)
    page.route("**/api/choose", lambda route: route.fulfill(status=429, content_type="application/json", body='{"error":"rate-limited"}'))
    row.locator(".choice").first.click()
    check(wait_for(page, "document.querySelector('#toast').textContent.includes('choosing quickly')", 5000) and wait_states(page, row, ["open", "open"]), "a server that says too fast is answered in plain words, and the options come back")
    page.unroute("**/api/choose")

    print("something was said that the page has not heard of yet")
    held: list = []
    page.route("**/api/poll**", lambda route: held.append(route))                    # from the next poll on, the page hears nothing
    add_activity(ctl, "uma", "reminder", "Reminder", "wake the poll that is waiting")
    check(wait_for(page, "document.querySelectorAll('.row.activity').length === 1", 8000) and settle(page, lambda: len(held) >= 1, 5000), "(the page is deaf from here)")
    ctl.post("say?who=uma&text=" + urllib.parse.quote("Wait, let me add something."))
    users = page.locator(".row.user").count()
    row.locator(".choice").first.click()
    check(wait_states(page, row, ["closed", "closed"]) and row.evaluate(CHOICES_OFF), "a tap the server finds closed settles to that: off and dimmed")
    check(wait_for(page, "document.querySelector('#toast').textContent.includes('closed')", 3000) and page.locator(".row.user").count() == users, "with a word of why, and the message it had shown taken away")
    for route in held:
        route.continue_()
    page.unroute("**/api/poll**")
    check(wait_for(page, f"document.querySelectorAll('.row.assistant[data-n]').length === 4", 8000) and row.evaluate(CHOICE_STATES) == ["closed", "closed"], "and when the page hears what was said, it agrees")

    print("answered in another tab")
    ask_options(ctl, "uma", text="One more, for two tabs?", options=["Yes", "No"])
    row = options_row(page, 3)
    second = context.new_page()
    watch(second, problems)
    second.goto(base)
    row_second = options_row(second, 3)
    held = []
    page.route("**/api/poll**", lambda route: held.append(route))
    add_activity(ctl, "uma", "reminder", "Reminder", "wake it once more")
    check(wait_for(page, "document.querySelectorAll('.row.activity').length === 2", 8000) and settle(page, lambda: len(held) >= 1, 5000), "(the first tab is deaf)")
    row_second.locator(".choice").nth(1).click()
    check(wait_states(second, row_second, ["dim", "chosen"]), "the other tab answers")
    row.locator(".choice").first.click()
    check(wait_states(page, row, ["closed", "closed"]) and wait_for(page, "document.querySelector('#toast').textContent.includes('answered')", 3000), "the first tab is told it was answered already, and settles")
    for route in held:
        route.continue_()
    page.unroute("**/api/poll**")
    check(wait_states(page, row, ["dim", "chosen"]), "and, hearing the history, shows the answer that was given")
    second.close()

    print("a voice note that does not go")
    wait_reply(page, 6)                                                              # (TAi's answer to the other tab's tap is in, so nothing closes the next options)
    ctl.post("transcript", "Yes, go on.")
    ctl.post("transcript-fail?on=0")
    ask_options(ctl, "uma", text="Last one, for a voice note?", options=["Yes", "No"])
    row = options_row(page, 4)
    page.route("**/api/voicenote*", lambda route: route.abort())
    record_note(page, 1.1)
    check(wait_for(page, f"{NOTE_ROWS}.length === 1 && document.querySelectorAll('.note-row')[0].querySelector('.bubble').dataset.state === 'failed'", 8000), "a voice note that does not go says so on its bubble")
    check(wait_states(page, row, ["open", "open"]) and row.evaluate(CHOICES_ON), "and has said nothing: the options are on, not closed by it")
    page.unroute("**/api/voicenote*")
    on_the_way: list = []
    page.route("**/api/voicenote*", lambda route: on_the_way.append(route))
    page.locator(".note-row").nth(0).locator(".note-retry").click()
    check(settle(page, lambda: len(on_the_way) >= 1, 5000) and wait_states(page, row, ["closed", "closed"]) and row.evaluate(CHOICES_OFF), "tried again, it is on its way: the options close while it goes")
    on_the_way[0].continue_()
    page.unroute("**/api/voicenote*")
    check(wait_for(page, "document.querySelectorAll('.note-row')[0].querySelector('.bubble').dataset.state === 'ready'", 8000) and row.evaluate(CHOICE_STATES) == ["closed", "closed"], "and once it is there they stay closed with nothing chosen: a voice note is something said")
    check(wait_reply(page, 8), "(and TAi answers it)")
    clean(page, problems, "the taps that do not go through")
    context.close()


def choices_phone(browser, base, off, ctl, out):
    print("options on a phone")
    context, page, problems = student(browser, base, "dev:vera@example.com", viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2)
    long_one = "It depends on how many nodes are reachable, which is why a leader that cannot reach a majority must step down and why a follower waits"
    ask_options(ctl, "vera", text="Which of these describes what a leader does when it cannot reach a majority of the cluster?", options=["It keeps accepting writes", long_one, "It deletes its log"], quiz=True, key=1)
    row = options_row(page, 1)
    n = int(row.get_attribute("data-n"))
    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth") and row.locator(".bubble").evaluate("(b) => b.getBoundingClientRect().right <= window.innerWidth"), "the question fits a phone, with nothing sticking out sideways")
    check(row.locator(".choice").nth(1).evaluate("(b) => b.getBoundingClientRect().height > 60 && b.scrollWidth <= b.clientWidth + 1"), "a long option wraps instead of running off the side")
    page.evaluate(f"document.querySelector('.row.has-choices[data-n=\"{n}\"]').scrollIntoView({{ block: 'center' }})")
    page.wait_for_timeout(500)
    page.screenshot(path=str(out / "133-choices-open-dark-phone.png"))
    row.locator(".choice").nth(1).tap()
    check(wait_states(page, row, ["dim", "right", "dim"]) and wait_reply(page, 2), "a tap on a phone answers it")
    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "(and still nothing sticks out)")
    page.screenshot(path=str(out / "134-choices-right-dark-phone.png"))
    page.evaluate("document.documentElement.dataset.theme = 'light'")
    page.wait_for_timeout(300)
    row.scroll_into_view_if_needed()
    page.screenshot(path=str(out / "135-choices-right-light-phone.png"))
    ask_options(ctl, "vera", text="Which of these is a follower?", options=["Node A", "Node B"], quiz=True, key=0)
    row2 = options_row(page, 2)
    row2.locator(".choice").nth(1).tap()
    check(wait_states(page, row2, ["dim", "wrong"]), "a wrong answer on a phone shows its cross, and gives nothing away")
    page.screenshot(path=str(out / "136-choices-wrong-light-phone.png"))
    clean(page, problems, "the options on a phone")
    context.close()


def choices_motion(browser, base, off, ctl, out):
    print("options with reduced motion")
    context, page, problems = student(browser, base, "dev:wade@example.com", reduced_motion="reduce")
    taps = watch_taps(page)
    ask_options(ctl, "wade", quiz=True, key=1)
    row = options_row(page, 1)
    n = int(row.get_attribute("data-n"))
    held: list = []
    page.route("**/api/choose", lambda route: held.append(route))
    row.locator(".choice").nth(1).click()
    check(wait_states(page, row, ["dim", "pending", "dim"]) and settle(page, lambda: len(held) == 1, 3000), "a tap is on its way, the one tapped marked")
    check(row.locator(".choice-mark").nth(1).evaluate("(m) => getComputedStyle(m, '::after').animationName") == "none", "with reduced motion asked for, the ring on it keeps still")
    check(row.locator(".choice").first.evaluate("(b) => getComputedStyle(b).transitionDuration") == "0s", "and the buttons change without fading")
    held[0].continue_()
    page.unroute("**/api/choose")
    check(wait_states(page, row, ["dim", "right", "dim"]) and taps == [{"to": n, "index": 1}], "the answer comes as it does without it")
    clean(page, problems, "the options with reduced motion")
    context.close()


FLOWS = [features_off, pictures_and_reactions, student_reactions, reaction_replies, touch_reactions, attachments, upload_release, voice_notes, jump_pill, voice_call, talk_mode, interview_link, call_thread, call_orb, call_phone, activity_list, activity_phone, choices_quiz, choices_replies, choices_failures, choices_phone, choices_motion]


def run_gate_only(args) -> int:
    """Against the real deployment (no fake Google, no sign-in): the page as a stranger gets it through DNS, TLS and traefik, with Google's
    real script loading. Whatever the deployment's state, it must load without errors, refuse the API, and say what it is."""
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    base = args.base if args.base.endswith("/") else args.base + "/"
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=not args.headed)
        context = browser.new_context(viewport={"width": 1280, "height": 800}, color_scheme="dark")
        page = context.new_page()
        problems: list[str] = []
        page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
        # Google's own library reports a wrong origin, a consent screen still in "Testing" or a policy problem as [GSI_LOGGER] lines at any level
        page.on("console", lambda m: ("GSI_LOGGER" in m.text or (m.type == "error" and "401" not in m.text and "403" not in m.text and "Failed to load resource" not in m.text)) and problems.append(f"console {m.type}: {m.text[:200]}"))
        responses: dict[str, int] = {}
        page.on("response", lambda r: responses.__setitem__(r.url.split("?")[0], r.status))

        reply = page.goto(base)
        check(reply is not None and reply.status == 200, "the page loads", str(reply.status if reply else None))
        headers = reply.headers if reply else {}
        csp = headers.get("content-security-policy", "")
        check("default-src 'none'" in csp and "script-src 'self' https://accounts.google.com/gsi/client" in csp, "it carries a content policy that allows only itself and Google's script")
        check(headers.get("x-frame-options") == "DENY" and headers.get("x-content-type-options") == "nosniff", "it cannot be framed or sniffed")
        check(headers.get("cross-origin-opener-policy") == "same-origin-allow-popups", "it lets Google's sign-in popup keep its link to the page")
        page.wait_for_timeout(2500)
        check(all(responses.get(base + name) == 200 for name in ("app.js", "markdown.js", "notes.js", "activity.js", "choices.js", "speech.js", "voice.js", "style.css", "mark.svg")), "its own files all load", str({k: v for k, v in responses.items() if base in k}))
        check(page.evaluate("document.querySelector('#chat').dataset.mode") == "gate" and page.locator(".row[data-n]").count() == 0, "a stranger sees the sign-in conversation and none of a real one")
        check(page.evaluate("fetch('api/history').then(r => r.status)") == 401, "the conversation's API refuses a stranger")
        check(page.evaluate("fetch('api/send', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{\"text\":\"hi\"}'}).then(r => r.status)") in (401, 403), "a message from a stranger is refused")
        config = page.evaluate("fetch('auth/config').then(r => r.json())")
        print("       auth/config says:", {"enabled": config.get("enabled"), "has_client_id": bool(config.get("clientId"))})
        if config.get("enabled"):
            check(page.locator(".gsi-slot iframe, .gsi-slot div").count() > 0, "Google's button is drawn")
            check(len(page.evaluate("fetch('auth/nonce').then(r => r.json())").get("nonce", "")) >= 24, "a nonce is issued")
        else:
            check("not set up" in page.inner_text("#messages"), "closed: the page says sign-in is not set up")
        page.screenshot(path=str(out / "live-gate.png"))
        bare = base.rstrip("/")
        page.goto(bare)
        page.wait_for_timeout(1500)
        check(page.evaluate("document.querySelector('#chat').dataset.mode") == "gate" and responses.get(base + "app.js") in (200, 304), "opened without the trailing slash it still finds its files")   # 304: the browser had them
        check(not problems, "the page logged no errors", "; ".join(problems[:3]))
        browser.close()
    failed = [what for ok, what in results if not ok]
    print(f"\n{len(results) - len(failed)} of {len(results)} checks held" + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else 0


def start_dev_server():
    """A fresh dev server on free ports (every run needs new conversations); its last line says where its three listeners are."""
    node = shutil.which("node") or "node"
    build = tempfile.mkdtemp(prefix="tai-portal-e2e-build-")
    proc = subprocess.Popen([node, str(ROOT / "portal" / "qa" / "dev_server.mjs"), "--port=0", f"--out={build}"], cwd=str(ROOT),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    lines: queue.Queue = queue.Queue()

    def pump():
        for line in proc.stdout:
            lines.put(line)
        lines.put(None)

    threading.Thread(target=pump, daemon=True).start()
    deadline = time.time() + 180
    while time.time() < deadline:
        try:
            line = lines.get(timeout=1)
        except queue.Empty:
            continue
        if line is None:
            raise RuntimeError("the dev server stopped before it was ready")
        if line.startswith("READY "):
            return proc, json.loads(line[len("READY "):]), build
    proc.terminate()
    raise RuntimeError("the dev server did not say it was ready")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):                      # the report names emoji: a console that is not UTF-8 (Windows') must not stop the run over one
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=None, help="a dev server already running (default: start a fresh one)")
    ap.add_argument("--control", default=None, help="its control port (default: the port after --base's)")
    ap.add_argument("--off", default=None, help="its page with every feature off (default: two ports after --base's)")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "out"))
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--only", default="", help="comma-separated names of the flows to run (main_flow is the signed-out-to-signed-out walk; default: all)")
    ap.add_argument("--gate-only", action="store_true", help="against a real deployment: only what a stranger can see (no fake Google, no sign-in)")
    args = ap.parse_args()
    proc = None
    build = None
    try:
        if args.gate_only:
            if not args.base:
                print("--gate-only needs --base")
                return 2
            return run_gate_only(args)
        if args.base:
            base = args.base if args.base.endswith("/") else args.base + "/"
            parsed = urllib.parse.urlparse(base)
            control = args.control or f"{parsed.scheme}://{parsed.hostname}:{parsed.port + 1}/"
            off = args.off or f"{parsed.scheme}://{parsed.hostname}:{parsed.port + 2}/"
        else:
            proc, ready, build = start_dev_server()
            base, control, off = ready["base"], ready["control"], ready["off"]
            print(f"dev server: {base} (control {control}, plain {off})")
        return run(args, base, control, off)
    except Exception as err:       # the run itself failed, not a check
        print("the run failed:", type(err).__name__, str(err)[:400])
        return 2
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        if build:
            shutil.rmtree(build, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
