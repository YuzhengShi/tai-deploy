#!/opt/leanrag/bin/python3
"""Piazza API helper — reads JSON request from stdin, returns JSON to stdout.

Uses the unofficial piazza-api library. Requires PIAZZA_EMAIL and PIAZZA_PASSWORD
environment variables, plus PIAZZA_NETWORK_ID for the course network.

Piazza answers "Sorry, too fast -- please wait a second and try again." to requests that come too close together. piazza_throttle.py keeps the
requests apart, waits that answer out and sends the request again, and gives a lookup 24 seconds at most: one that has fetched some posts by
then returns those, with "stopped_early", instead of failing as a whole.
"""
import html as html_lib
import json
import sys
import os
import re
import unicodedata
from datetime import datetime

try:
    from piazza_api import Piazza
except ImportError:
    print(json.dumps({"error": "piazza-api library not installed. Run: pip install piazza-api"}))
    sys.exit(1)

from piazza_throttle import OutOfTime, Throttle, install, is_too_fast

EMAIL = os.environ.get('PIAZZA_EMAIL', '')
PASSWORD = os.environ.get('PIAZZA_PASSWORD', '')
NETWORK_ID = os.environ.get('PIAZZA_NETWORK_ID', '')
MAX_POSTS = 50

SLOW_DOWN = ("Piazza is asking us to slow down and the retries ran out. Do not ask Piazza for this again for a minute: "
             "tell the student Piazza is busy right now and offer to look again in a moment.")
STOPPED_SLOW = ("Stopped early: Piazza asked us to slow down, so only the posts above were read. They are real; "
                "tell the student, and ask again in a minute for the rest.")
STOPPED_LONG = ("Stopped early: the time for this lookup ran out, so only the posts above were read. They are real; "
                "tell the student, and ask again for the rest (a narrower question reads fewer posts).")


def budget_seconds():
    """How long a lookup may take: 24 s (the tool gives up on a script at 30), less when PIAZZA_BUDGET_SECONDS says so. The MCP server says 10 for a voice
    call: it runs scripts one at a time, so a lookup that waits out Piazza holds up every other lookup of the call behind it."""
    try:
        return max(2.0, min(24.0, float(os.environ.get('PIAZZA_BUDGET_SECONDS', '24'))))
    except ValueError:
        return 24.0


def new_throttle():
    return Throttle(budget=budget_seconds())


def strip_html(html):
    text = re.sub(r'<[^>]+>', ' ', html or '')
    text = re.sub(r'&nbsp;', ' ', text)
    text = re.sub(r'&amp;', '&', text)
    text = re.sub(r'&lt;', '<', text)
    text = re.sub(r'&gt;', '>', text)
    text = re.sub(r'&quot;', '"', text)
    text = re.sub(r'&#39;', "'", text)
    return re.sub(r'\s+', ' ', text).strip()


def is_private(thing):
    """A PRIVATE post (a student's question to the teaching staff only: status 'private' on Piazza's feed items and on the posts themselves, measured on the live
    forum 2026-11-06). The account this tool uses is a TA, so Piazza shows it those posts, and no answer of this tool may carry one: a student's container would
    otherwise read another student's private question (grades, personal circumstances). Nothing about one is returned, not its words, subject, tags or id."""
    return isinstance(thing, dict) and str(thing.get('status') or '').lower() == 'private'


def format_post_summary(post):
    """Format a post into a concise summary."""
    history = post.get('history', [{}])
    latest = history[0] if history else {}
    subject = latest.get('subject', post.get('subject', 'No subject'))
    content = strip_html(latest.get('content', ''))

    tags = post.get('tags', [])
    post_type = post.get('type', 'unknown')
    nr = post.get('nr', '?')
    created = post.get('created', '')
    num_answers = len(post.get('children', []))
    is_resolved = post.get('no_answer', 0) == 0 and post_type == 'question'

    # Truncate content
    if len(content) > 500:
        content = content[:500] + '...'

    return {
        'id': nr,
        'type': post_type,
        'subject': strip_html(subject),
        'content': content,
        'tags': tags,
        'created': created[:10] if created else '',
        'num_responses': num_answers,
        'resolved': is_resolved,
    }


def format_post_detail(post):
    """Format a post with full content and all answers."""
    history = post.get('history', [{}])
    latest = history[0] if history else {}
    subject = latest.get('subject', post.get('subject', 'No subject'))
    content = strip_html(latest.get('content', ''))

    children = post.get('children', [])
    answers = []
    for child in children:
        child_type = child.get('type', '')
        child_history = child.get('history', [{}])
        child_latest = child_history[0] if child_history else {}
        child_content = strip_html(child_latest.get('content', ''))
        if child_content:
            answers.append({
                'type': child_type,  # 'i_answer' (instructor) or 's_answer' (student)
                'content': child_content[:2000],
                'endorsements': child.get('tag_endorse', []),
                'created': child.get('created', '')[:10],
            })

    followups = []
    for child in children:
        if child.get('type') == 'followup':
            fu_content = strip_html(child.get('subject', ''))
            if fu_content:
                followups.append({
                    'content': fu_content[:500],
                    'replies': len(child.get('children', [])),
                })

    return {
        'id': post.get('nr', '?'),
        'type': post.get('type', 'unknown'),
        'subject': strip_html(subject),
        'content': content[:3000],
        'tags': post.get('tags', []),
        'created': post.get('created', '')[:10],
        'answers': answers,
        'followups': followups[:10],
        'num_views': post.get('unique_views', 0),
        'is_pinned': post.get('pin', False),
    }


# ── student_activity: what ONE student wrote in a window (the weekly interview brief, docs/WEEKLY_BRIEF.md) ───────────────────────────────────
#
# The TAi account is a TA's, so the feed shows who did what: every item has a `log` of {n: event, t: time, u: the uid of whoever did it}. One feed
# request and one get_users therefore find the student's events in the window (the e-mail address or, failing that, the exact name picks the
# account out of the users), and get_post is asked for at most `limit` of the posts they acted on, only to quote their own words. Posts that are
# anonymous to classmates still carry the uid for a TA; a post anonymous to everyone has none, and is not found.
#
# The answer is about the one matched student and about nobody else: no other name, e-mail address, uid or text (a reply to their post is, at most,
# part of nobody's count), and every word quoted is checked against its own author's uid, node by node: an answer other students edit is quoted
# from the newest version THIS student wrote, never from the newest one.

FEED_PAGE = 200
ACTIVITY_POSTS_MAX = 8
ACTIVITY_TEXT_MAX = 600
ACTIVITY_SUBJECT_MAX = 150
EVENT_KIND = {'create': 'posted', 'followup': 'followed up', 'feedback': 'followed up', 'i_answer': 'answered', 's_answer': 'answered'}
COUNT_KEY = {'posted': 'posted', 'followed up': 'followups', 'answered': 'answers'}        # edits of what was written before (update, *_update) are not counted
_UNSAFE = re.compile('[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\ufeff]')


def plain_text(value, limit):
    """Plain one-line text of a post's HTML, no control character, at most `limit` characters."""
    text = html_lib.unescape(re.sub(r'<[^>]+>', ' ', value if isinstance(value, str) else ''))
    text = re.sub(r'\s+', ' ', _UNSAFE.sub('', text)).strip()
    return text if len(text) <= limit else text[:max(limit - 1, 0)].rstrip() + '…'


def parse_ts(value):
    """A timestamp as naive UTC (the first 19 characters: Piazza's are 'YYYY-MM-DDTHH:MM:SSZ', the caller's may carry milliseconds); None when it is not one."""
    try:
        return datetime.strptime(str(value or '')[:19], '%Y-%m-%dT%H:%M:%S')
    except ValueError:
        return None


def norm_email(value):
    text = str(value or '').strip().lower()
    return text if '@' in text else ''


def norm_name(value):
    """A full name as it is compared: Unicode-normalised, case-folded, punctuation and spacing ignored ('Ada K. Lovelace' is 'ada k lovelace')."""
    return ' '.join(re.sub(r'[^\w\s]', ' ', unicodedata.normalize('NFKC', str(value or ''))).casefold().split())


def candidate_emails(params):
    """The e-mail addresses to look for: `email`, and `emails` (a list, or a string with commas or spaces), normalised, without duplicates, at most five."""
    extra = params.get('emails')
    values = [params.get('email')] + (extra if isinstance(extra, list) else re.split(r'[,\s]+', extra) if isinstance(extra, str) else [])
    found = []
    for value in values:
        email = norm_email(value)
        if email and email not in found:
            found.append(email)
    return found[:5]


def find_student(users, emails, name):
    """(uid, matched_by, reason): the one account that is the student. By e-mail address when one account has it, else by exact normalised full name;
    two accounts with the address or the name are no match at all (a wrong student's posts are worse than none). Records without an id are skipped:
    guessing which record is whose from their order could hand out somebody else's posts."""
    by_id = {}
    for record in users:
        if isinstance(record, dict):
            uid = record.get('id') or record.get('uid') or record.get('user_id')
            if uid not in (None, ''):
                by_id[str(uid)] = record
    if not by_id:
        return None, None, 'Piazza did not say which account is which'
    if emails:
        hits = [uid for uid, record in by_id.items() if norm_email(record.get('email')) in emails]
        if len(hits) == 1:
            return hits[0], 'email', None
        if len(hits) > 1:
            return None, None, 'several Piazza accounts have this e-mail address'
    wanted = norm_name(name)
    if wanted:
        hits = [uid for uid, record in by_id.items() if norm_name(record.get('name')) == wanted]
        if len(hits) == 1:
            return hits[0], 'name', None
        if len(hits) > 1:
            return None, None, 'several Piazza accounts have this name'
    return None, None, 'no Piazza account with this e-mail address or name has taken part in the forum lately'


def newest_by(entries, uid):
    """The newest entry (of a post's or an answer's history) that THIS uid wrote, or None. History lists the newest first; `created` decides when it is there."""
    ours = [e for e in entries if isinstance(e, dict) and str(e.get('uid')) == uid]
    ours.sort(key=lambda e: str(e.get('created') or ''), reverse=True)
    return ours[0] if ours else None


def followup_nodes(children, depth=0):
    """The follow-up discussions of a post and the replies inside them, each as the node Piazza gives (it has its own uid and its text in `subject`)."""
    for child in children or []:
        if isinstance(child, dict):
            if child.get('type') in ('followup', 'feedback'):
                yield child
            if depth < 4:
                for inner in followup_nodes(child.get('children'), depth + 1):
                    yield inner


def own_words(post, uid, role):
    """(subject, text) of what this uid wrote on the post, in the part the role names: the post itself (the newest version they wrote), the answers
    (likewise), or the follow-ups and replies they wrote. Nothing any other uid wrote: when no node is theirs both are empty and the counts stand alone."""
    subject, parts = '', []
    if role == 'posted':
        mine = newest_by(post.get('history') or [], uid)
        if mine:
            subject = plain_text(mine.get('subject'), ACTIVITY_SUBJECT_MAX)
            parts.append(plain_text(mine.get('content'), ACTIVITY_TEXT_MAX))
    elif role == 'answered':
        for child in post.get('children') or []:
            if isinstance(child, dict) and child.get('type') in ('i_answer', 's_answer'):
                mine = newest_by(child.get('history') or [], uid)
                if mine:
                    parts.append(plain_text(mine.get('content'), ACTIVITY_TEXT_MAX))
    else:
        parts = [plain_text(node.get('subject'), ACTIVITY_TEXT_MAX) for node in followup_nodes(post.get('children')) if str(node.get('uid')) == uid]
    text = ' | '.join(part for part in parts if part)
    return subject, text if len(text) <= ACTIVITY_TEXT_MAX else text[:ACTIVITY_TEXT_MAX - 1].rstrip() + '…'


def check_activity_params(params):
    """An error for a request that cannot be answered (nothing has been sent to Piazza yet), else None."""
    if parse_ts(params.get('since')) is None or parse_ts(params.get('until')) is None:
        return {"error": "since and until must be ISO date-times like 2026-11-02T17:00:00Z"}
    if parse_ts(params['since']) > parse_ts(params['until']):
        return {"error": "since is after until"}
    return None


def student_activity(network, throttle, params):
    since, until = parse_ts(params.get('since')), parse_ts(params.get('until'))
    try:
        limit = max(1, min(ACTIVITY_POSTS_MAX, int(params.get('limit') or ACTIVITY_POSTS_MAX)))
    except (TypeError, ValueError):
        limit = ACTIVITY_POSTS_MAX
    emails, name = candidate_emails(params), str(params.get('name') or '')
    answer = {"matched": False, "matched_by": None, "counts": {"posted": 0, "followups": 0, "answers": 0}, "posts": [], "scanned": 0}
    if not emails and not norm_name(name):
        answer["reason"] = "no e-mail address or name to look for"
        return answer

    feed = network.get_feed(limit=FEED_PAGE, offset=0)                      # ONE request: a page of 200 threads covered the whole term when this was written
    items = [i for i in ((feed.get('feed') if isinstance(feed, dict) else None) or []) if isinstance(i, dict)]
    answer["scanned"] = len(items)
    uids = sorted({str(e.get('u')) for i in items for e in (i.get('log') or []) if isinstance(e, dict) and e.get('u')})
    users = network.get_users(uids) if uids else []                         # ONE request, for every uid on the page: a student who has not acted in the window is still found
    uid, how, reason = find_student(users if isinstance(users, list) else [], emails, name)
    if uid is None:
        answer["reason"] = reason
        return answer
    answer["matched"], answer["matched_by"] = True, how

    acted = []                                                             # (newest event, the feed item, what they did there)
    for item in items:
        if is_private(item):
            continue                                                       # a private question to the staff is no part of what is discussed in an interview, and not this tool's to repeat
        times, kinds = [], set()
        for event in item.get('log') or []:
            if not isinstance(event, dict) or str(event.get('u')) != uid:
                continue
            when, kind = parse_ts(event.get('t')), EVENT_KIND.get(event.get('n'))
            if kind is None or when is None or not (since <= when <= until):
                continue
            answer["counts"][COUNT_KEY[kind]] += 1
            kinds.add(kind)
            times.append(when)
        if kinds:
            acted.append((max(times), item, kinds))
    acted.sort(key=lambda found: found[0], reverse=True)

    unread, stopped = 0, False
    for when, item, kinds in acted[:limit]:
        role = 'posted' if 'posted' in kinds else 'answered' if 'answered' in kinds else 'followed up'
        entry = {"id": item.get('nr'), "role": role, "type": plain_text(item.get('type'), 20), "subject": "",
                 "tags": [plain_text(t, 40) for t in (item.get('tags') or [])[:6] if isinstance(t, str)], "date": when.strftime('%Y-%m-%dT%H:%M:%SZ'), "text": ""}
        if not stopped and throttle.out_of_time():
            stopped = True
        if not stopped:
            try:
                entry["subject"], entry["text"] = own_words(network.get_post(int(item['nr'])), uid, role)
            except OutOfTime:
                stopped = True
            except Exception:
                unread += 1
        if stopped:
            unread += 1
        answer["posts"].append(entry)

    notes = []
    if unread:
        notes.append("The words of %d of these posts could not be read%s; the counts are complete." % (unread, " in time" if stopped else ""))
    oldest = [t for t in (parse_ts(i.get('modified')) for i in items) if t is not None]
    if (len(items) >= FEED_PAGE or (isinstance(feed, dict) and feed.get('more'))) and (not oldest or min(oldest) >= since):
        notes.append("The forum's recent threads were all read and the oldest is still inside the window, so older activity may be missing.")
    if notes:
        answer["note"] = " ".join(notes)
    return answer


def collect(throttle, ids, fetch, limit):
    """Reads the posts one by one and summarizes them. A post that cannot be read is left out (and counted); when the time is used up
    the lookup stops with what it has. Returns the summaries, how many were left out, and whether it stopped early."""
    posts, skipped, stopped = [], 0, False
    for post_id in ids:
        if len(posts) >= limit:
            break
        if throttle.out_of_time():
            stopped = True
            break
        try:
            fetched = fetch(post_id)
            if is_private(fetched):
                continue                        # a private post is not read out: not listed, not counted
            posts.append(format_post_summary(fetched))
        except OutOfTime:
            stopped = True
            break
        except Exception:
            skipped += 1
    return posts, skipped, stopped


def listing(throttle, posts, skipped, stopped, **extra):
    out = {"posts": posts, "count": len(posts)}
    out.update(extra)
    if skipped:
        out["skipped"] = skipped
    if stopped:
        out["stopped_early"] = True
        out["note"] = STOPPED_SLOW if throttle.waited_out > 0 else STOPPED_LONG
    return out


def handle(req):
    action = req.get('action', '')
    params = req.get('params', {})

    if not EMAIL or not PASSWORD:
        return {"error": "PIAZZA_EMAIL and PIAZZA_PASSWORD not configured"}
    if not NETWORK_ID:
        return {"error": "PIAZZA_NETWORK_ID not configured"}
    if action == 'student_activity':
        bad = check_activity_params(params)                    # before the login: a request that cannot be answered costs Piazza nothing
        if bad:
            return bad

    # Connect (the login is a request too: it is paced, and a "too fast" to it is waited out like any other)
    throttle = new_throttle()
    p = Piazza()
    throttle.request(lambda: p.user_login(email=EMAIL, password=PASSWORD))
    network = p.network(NETWORK_ID)
    install(throttle, network)

    if action == 'recent_posts':
        limit = int(params.get('limit', '20'))
        limit = min(limit, MAX_POSTS)
        posts, stopped = [], False
        try:
            for post in network.iter_all_posts(limit=limit):
                if is_private(post):
                    continue
                posts.append(format_post_summary(post))
                if throttle.out_of_time():
                    stopped = True
                    break
        except OutOfTime:
            stopped = True
        except Exception:
            if not posts:
                raise
            stopped = True            # some posts were read before Piazza refused: those are returned, and the note says it stopped
        return listing(throttle, posts, 0, stopped)

    elif action == 'get_post':
        post_id = params.get('post_id', '')
        if not post_id:
            return {"error": "post_id parameter required"}
        try:
            post = network.get_post(int(post_id))
            if is_private(post):
                return {"error": "That post is private (a question to the teaching staff only), so it is not shown."}
            return format_post_detail(post)
        except OutOfTime:
            return {"error": SLOW_DOWN}
        except Exception as e:
            if is_too_fast(e):
                return {"error": SLOW_DOWN}
            return {"error": f"Failed to get post {post_id}: {str(e)}"}

    elif action == 'search':
        query = params.get('query', '')
        if not query:
            return {"error": "query parameter required"}
        results = network.search_feed(query)
        feed_items = results if isinstance(results, list) else results.get('feed', [])
        ids = [item.get('nr') or item.get('id') for item in feed_items if not is_private(item)][:20]
        posts, skipped, stopped = collect(throttle, [i for i in ids if i], lambda i: network.get_post(int(i)), 20)
        return listing(throttle, posts, skipped, stopped, query=query)

    elif action == 'get_pinned':
        # Get pinned/instructor posts
        feed = network.get_feed(limit=100, offset=0)
        ids = [item['nr'] for item in feed.get('feed', []) if item.get('pin') and not is_private(item)]
        posts, skipped, stopped = collect(throttle, ids, network.get_post, len(ids) or 1)
        return listing(throttle, posts, skipped, stopped)

    elif action == 'get_by_tag':
        tag = params.get('tag', '')
        if not tag:
            return {"error": "tag parameter required. Use action 'list_tags' first to see available tags."}
        # Search by tag via feed filtering
        feed = network.get_feed(limit=200, offset=0)
        ids = [item['nr'] for item in feed.get('feed', []) if tag.lower() in [t.lower() for t in item.get('tags', [])] and not is_private(item)]
        posts, skipped, stopped = collect(throttle, ids, network.get_post, MAX_POSTS)
        return listing(throttle, posts, skipped, stopped, tag=tag)

    elif action == 'list_tags':
        # Discover all tags in use across the forum
        all_tags = {}
        for offset in [0, 200, 400]:
            feed = network.get_feed(limit=200, offset=offset)
            items = feed.get('feed', [])
            if not items:
                break
            for item in items:
                if is_private(item):
                    continue                    # a tag that only a private post carries is not named
                for tag in item.get('tags', []):
                    all_tags[tag] = all_tags.get(tag, 0) + 1
        sorted_tags = sorted(all_tags.items(), key=lambda x: -x[1])
        return {"tags": [{"name": t, "count": c} for t, c in sorted_tags]}

    elif action == 'student_activity':
        return student_activity(network, throttle, params)

    elif action == 'stats':
        stats = network.get_statistics()
        return {
            "total_posts": stats.get('total', {}).get('questions', 0) + stats.get('total', {}).get('notes', 0),
            "total_questions": stats.get('total', {}).get('questions', 0),
            "total_notes": stats.get('total', {}).get('notes', 0),
            "total_students": stats.get('total', {}).get('students', 0),
        }

    else:
        return {"error": f"Unknown action: {action}. Valid: recent_posts, get_post, search, get_pinned, get_by_tag, list_tags, stats, student_activity"}


if __name__ == '__main__':
    try:
        req = json.loads(sys.stdin.read())
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON on stdin"}))
        sys.exit(1)

    try:
        result = handle(req)
        print(json.dumps(result, ensure_ascii=False, default=str))
    except OutOfTime:
        print(json.dumps({"error": SLOW_DOWN}))
        sys.exit(1)
    except Exception as e:
        if is_too_fast(e):
            print(json.dumps({"error": SLOW_DOWN}))
        else:
            print(json.dumps({"error": f"Piazza API error: {str(e)}"}))
        sys.exit(1)
