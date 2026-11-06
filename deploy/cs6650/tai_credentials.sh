#!/usr/bin/env bash
# Give TAi (the live deployment on the CS6650 host, ~/tai-live) the course credentials it reads on a student's behalf.
# Run this on the operator's PC (Git Bash), in a terminal of your own:
#   bash deploy/cs6650/tai_credentials.sh              # Canvas, GitHub, Piazza, Deepgram and DeepSeek, one after the other
#   bash deploy/cs6650/tai_credentials.sh canvas       # or only one of them: canvas | github | piazza | deepgram | deepseek | zai | smtp
#   bash deploy/cs6650/tai_credentials.sh zai          # the API key of z.ai (GLM), for the gateway's `glm` model and the reading of pictures (NOT in the run of all of them: optional)
#   bash deploy/cs6650/tai_credentials.sh smtp         # the password of the mail account TAi sends its notification e-mail from (NOT in the run of all of them: e-mail is optional)
#   bash deploy/cs6650/tai_credentials.sh --show       # which values are stored (names only, never the values) and what the last check found
#   bash deploy/cs6650/tai_credentials.sh --check      # check what is stored against the real services again (asks nothing, changes nothing but the facts)
# It sends itself to the world host and runs there in an ssh session (ssh -t). There it asks for each value with the echo OFF for the
# whole session (nothing you type or paste is shown: wait for the prompt first; values that are not secret are repeated back), CHECKS
# what you typed against the real service with read-only requests from a throwaway container of the agent image (TAi's own
# piazza-api library for Piazza), and only then stores it in ~/tai-live/credentials.env (mode 600, one KEY="value" per line; the
# file as it was is kept once as credentials.env.bak-first). A service whose check fails keeps what it had. A value is never printed,
# logged, put on a command line or shown to an agent (agent.md section 1): never paste one into a chat. A token that was ever pasted
# into a chat is exposed: make a new one and delete the old.
#   Canvas   a token from Canvas > Account > Settings > + New Access Token (set an expiry after the last class)
#   GitHub   a token for github.com (the tool only reads; a classic token with read access to the course's repositories is enough) and,
#            ONLY if the university runs its own GitHub server, one for that
#   Piazza   the login of the account that reads the class (an account that signs in with SSO has no password: use "forgot password")
#   Deepgram the API key of voice calls, the mock interview and voice notes (console.deepgram.com); Enter alone reuses the key Nora's
#            voice already has on this host (~/cs6650-world/.env): copied on the host, not typed and not shown
#   DeepSeek the API key of DeepSeek's own API (platform.deepseek.com), for the gateway's `deepseek` model. Checked with two read-only
#            requests (the account's balance, and that the model the gateway asks for is in its list: an empty balance is reported, not
#            refused, since the key itself is fine). Unlike the others it is NOT stored in credentials.env or in TAi's .env: only the
#            gateway uses it, so it goes to ~/tai-live/gateway.env (mode 600, as KEY=value with no quotes: docker's --env-file keeps
#            quotes as part of the value). The gateway reads it when it is created again (`tai_live.sh gateway`, or the next deploy that
#            changes the gateway), not before, and creating it again cuts calls that are running: the script says so and does not do it.
#   z.ai     the API key of z.ai (docs.z.ai), for the gateway's `glm` model (GLM-5.3-Flash through the OpenAI-compatible endpoint of the GLM Coding Plan,
#            https://api.z.ai/api/coding/paas/v4) and for reading a student's pictures. Checked with one tiny request (a one-word answer, thinking off: a
#            handful of tokens). Stored like DeepSeek's: ~/tai-live/gateway.env only (mode 600, unquoted), read when the gateway is created again
#            (`tai_live.sh gateway`). Run only by name: `zai`.
#   SMTP     the PASSWORD of the mail account behind TAI_SMTP_USER (docs/NOTIFICATIONS.md, "E-mail"): hidden, stored in credentials.env as SMTP_PASSWORD (so in
#            TAi's .env, which the orchestrator reads with readEnvFile; it is never given to a container and never logged). Run only by name: `smtp`. The mail
#            server's address and login are not secrets: `tai_live.sh set TAI_SMTP_HOST=... TAI_SMTP_USER=... TAI_NOTIFY_FROM=...` first (the check reads them from
#            orch.env). Checked without sending any mail: it connects (port 465 over TLS, any other port with STARTTLS, which it insists on: no login goes
#            over an unencrypted connection) and logs in, then quits.
# Enter keeps the stored value, "-" removes an optional one, and a service you leave empty is skipped. For Canvas and Piazza, when
# nothing is stored yet, Enter reuses what the weekly loop already has (~/.cs6650-loops/secrets.env): the value is copied on the host,
# not typed and not shown.
# "--upload" only sends the script and prints the one ssh command to run next (for a console in which Git Bash's ssh gets no tty:
# run that command with Windows' own ssh, from PowerShell).
# Env: TAI_LIVE_HOST (default ubuntu@tai.example.edu), SSH_OPTS; on the host TAI_LIVE_DIR (default ~/tai-live),
# TAI_AGENT_IMAGE (the image the checks run in: tai-agent:live, else tai-agent:clean). TAI_PROBE_CMD replaces the docker command that
# runs the checks (the tests use it).
set -euo pipefail

SERVICES=()
ON_HOST=0
SHOW=0
CHECK=0
UPLOAD=0
for a in "$@"; do
  case "$a" in
    canvas|github|piazza|deepgram|deepseek|zai|smtp) SERVICES+=("$a") ;;
    all) ;;
    --on-host) ON_HOST=1 ;;
    --show) SHOW=1 ;;
    --check) CHECK=1 ;;
    --upload) UPLOAD=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $a (try --help)" >&2; exit 2 ;;
  esac
done
[ ${#SERVICES[@]} -gt 0 ] || SERVICES=(canvas github piazza deepgram deepseek)

if [ "$ON_HOST" = 0 ]; then
  HOST="${TAI_LIVE_HOST:-ubuntu@tai.example.edu}"
  REMOTE_ARGS="--on-host ${SERVICES[*]}"
  [ "$SHOW" = 1 ] && REMOTE_ARGS="--on-host --show ${SERVICES[*]}"
  [ "$CHECK" = 1 ] && REMOTE_ARGS="--on-host --check ${SERVICES[*]}"
  # shellcheck disable=SC2086
  tr -d '\r' < "${BASH_SOURCE[0]}" | ssh ${SSH_OPTS:-} -o ConnectTimeout=20 "$HOST" 'cat > ~/.tai-credentials.sh && chmod 700 ~/.tai-credentials.sh'
  if [ "$UPLOAD" = 1 ]; then
    echo "uploaded. Now, in a terminal of your own, run:"
    echo "  ssh -t $HOST 'bash ~/.tai-credentials.sh $REMOTE_ARGS; rc=\$?; rm -f ~/.tai-credentials.sh; exit \$rc'"
    exit 0
  fi
  # shellcheck disable=SC2086
  exec ssh ${SSH_OPTS:-} -t -o ConnectTimeout=20 "$HOST" "bash ~/.tai-credentials.sh $REMOTE_ARGS; rc=\$?; rm -f ~/.tai-credentials.sh; exit \$rc"
fi

# ---- on the host ----
export LC_ALL=C      # byte-wise character classes: [!-~] is printable ASCII and nothing else
umask 077
L="${TAI_LIVE_DIR:-$HOME/tai-live}"
CRED="$L/credentials.env"
BASE="$L/base.env"
GWENV="$L/gateway.env"             # the gateway container's own env file (docker --env-file: KEY=value, no quotes)
FACTS="$L/owner-facts.json"
LOOPS="$HOME/.cs6650-loops/secrets.env"
WORLD="$HOME/cs6650-world/.env"      # the world's own settings (Nora's keys): a plain KEY=value file
mkdir -p "$L"
chmod 700 "$L"

ALL_KEYS=(CANVAS_BASE_URL CANVAS_COURSE_ID CANVAS_API_TOKEN GITHUB_BASE_URL GITHUB_TOKEN GITHUB_TOKEN_PUBLIC GITHUB_ALLOWED_ORGS PIAZZA_EMAIL PIAZZA_PASSWORD PIAZZA_NETWORK_ID DEEPGRAM_API_KEY SMTP_PASSWORD)
GW_KEYS=(DEEPSEEK_API_KEY ZAI_API_KEY)        # what only the gateway uses: kept in gateway.env, never in credentials.env or TAi's .env
service_keys() {
  case "$1" in
    canvas) echo CANVAS_BASE_URL CANVAS_COURSE_ID CANVAS_API_TOKEN ;;
    github) echo GITHUB_BASE_URL GITHUB_TOKEN GITHUB_TOKEN_PUBLIC GITHUB_ALLOWED_ORGS ;;
    piazza) echo PIAZZA_EMAIL PIAZZA_PASSWORD PIAZZA_NETWORK_ID ;;
    deepgram) echo DEEPGRAM_API_KEY ;;
    deepseek) echo DEEPSEEK_API_KEY ;;
    zai) echo ZAI_API_KEY ;;
    smtp) echo SMTP_PASSWORD ;;
  esac
}

stored_in() {   # stored_in FILE KEY: the value as TAi's .env reader sees it: one pair of double quotes removed, nothing else
  local v
  v=$(grep -m1 "^$2=" "$1" 2>/dev/null | cut -d= -f2-) || true
  v=${v#\"}
  v=${v%\"}
  printf '%s' "$v"
}
stored() { stored_in "$CRED" "$1"; }
stored_gw() { stored_in "$GWENV" "$1"; }

loops_value() {  # loops_value NAME: a value of the weekly loop's secrets file (bash-quoted there), or nothing
  [ -f "$LOOPS" ] || return 0
  ( . "$LOOPS" >/dev/null 2>&1 && printf '%s' "${!1:-}" ) 2>/dev/null || true
}

world_value() {  # world_value NAME: a value of the world's .env (KEY=value, no quotes), or nothing
  [ -f "$WORLD" ] || return 0
  grep -m1 "^$1=" "$WORLD" 2>/dev/null | cut -d= -f2- | tr -d '\r"' || true
}

if [ "$SHOW" = 1 ]; then
  for k in "${ALL_KEYS[@]}"; do printf '  %-22s %s\n' "$k" "$([ -n "$(stored "$k")" ] && echo set || echo -)"; done
  for k in "${GW_KEYS[@]}"; do printf '  %-22s %s   (the gateway'"'"'s env file)\n' "$k" "$([ -n "$(stored_gw "$k")" ] && echo set || echo -)"; done
  if [ -f "$FACTS" ]; then
    python3 - "$FACTS" <<'PY'
import json, sys
facts = json.load(open(sys.argv[1]))
for service, found in sorted(facts.items()):
    print('  last check, %s: %s' % (service, json.dumps(found, ensure_ascii=False)))
PY
  fi
  exit 0
fi

declare -A V OLD
for k in "${ALL_KEYS[@]}"; do
  V[$k]=$(stored "$k")
  OLD[$k]=${V[$k]}
done
for k in "${GW_KEYS[@]}"; do
  V[$k]=$(stored_gw "$k")
  OLD[$k]=${V[$k]}
done

cand=
probe_py=
stty_state=
cleanup() {
  rm -f "${cand:-}" "${probe_py:-}" "$L/.facts.new" 2>/dev/null || true
  if [ -n "$stty_state" ]; then stty "$stty_state" 2>/dev/null || true; fi
}
trap cleanup EXIT
if [ -t 0 ] && stty_state=$(stty -g 2>/dev/null); then
  stty -echo 2>/dev/null || true       # off for the whole session, not only at the secret prompts (set_credentials.sh learned this on 2026-10-29)
fi

NORMAL=
valid() {       # valid KEY VALUE: 0 when it can be that value; NORMAL is the value to keep
  local key=$1 v=$2
  NORMAL=$v
  case "$key" in
    CANVAS_BASE_URL)
      [[ "$v" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]] || return 1
      v=${v%/}
      case "$v" in */api/v1) ;; *) v="$v/api/v1" ;; esac
      NORMAL=$v ;;
    CANVAS_COURSE_ID) [[ "$v" =~ ^[0-9]{1,12}$ ]] ;;
    GITHUB_BASE_URL) [[ "$v" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]] && NORMAL=${v%/} ;;
    GITHUB_ALLOWED_ORGS) [[ "$v" =~ ^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$ ]] ;;
    PIAZZA_EMAIL) [[ "$v" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] ;;
    PIAZZA_NETWORK_ID)
      if [[ "$v" =~ /class/([A-Za-z0-9]+) ]]; then NORMAL=${BASH_REMATCH[1]}; return 0; fi
      [[ "$v" =~ ^[A-Za-z0-9]{6,32}$ ]] ;;
    PIAZZA_PASSWORD|SMTP_PASSWORD) [ ${#v} -ge 1 ] && [ ${#v} -le 200 ] && ! [[ "$v" =~ [[:cntrl:]] ]] ;;
    *) [[ "$v" =~ ^[!-~]+$ ]] && [ ${#v} -ge 10 ] && [ ${#v} -le 400 ] ;;     # a token: printable, no spaces (the length apart: Git Bash's regex caps a repeat at 255)
  esac
}

# ask KEY LABEL KIND [DEFAULT] [HINT] [LOOPS_NAME]: sets V[KEY]; LOOPS_NAME may be world:NAME (Nora's .env) instead. KIND: plain (shown back), secret (a token: all whitespace dropped),
# password (only the trailing CR dropped), optional-plain / optional-secret (also "-" to remove). Enter keeps the stored value.
ask() {
  local key=$1 label=$2 kind=$3 def=${4:-} hint=${5:-} loops_name=${6:-} cur typed keeps= secret=0 optional=0
  case "$kind" in secret|password|optional-secret) secret=1 ;; esac
  case "$kind" in optional-plain|optional-secret) optional=1 ;; esac
  cur=${V[$key]:-}
  if [ -z "$cur" ] && [ -n "$loops_name" ]; then
    case "$loops_name" in
      world:*) cur=$(world_value "${loops_name#world:}"); [ -z "$cur" ] || keeps=" [Enter reuses the one Nora's voice already has]" ;;
      *) cur=$(loops_value "$loops_name"); [ -z "$cur" ] || keeps=" [Enter reuses the weekly loop's stored value]" ;;
    esac
  fi
  if [ -z "$cur" ]; then cur=$def; fi
  if [ -z "$keeps" ] && [ -n "$cur" ]; then
    if [ "$secret" = 1 ]; then keeps=" [Enter keeps the stored one]"; else keeps=" [Enter keeps $cur]"; fi
  fi
  [ "$optional" = 0 ] || keeps="$keeps [- removes]"
  while true; do
    printf '%s%s%s: ' "$label" "${hint:+ ($hint)}" "$keeps" >&2
    typed=
    IFS= read -r -s typed || true          # IFS empty: read must not trim the spaces a password may start or end with
    echo >&2
    typed=${typed%$'\r'}
    case "$kind" in password) ;; *) typed=${typed//[[:space:]]/} ;; esac
    if [ "$optional" = 1 ] && [ "$typed" = - ]; then V[$key]=; return 0; fi
    [ -n "$typed" ] || typed=$cur
    if [ -z "$typed" ]; then V[$key]=; return 0; fi       # nothing typed and nothing stored: left empty (a service with nothing set is skipped)
    if [[ "$typed" =~ [[:cntrl:]] ]] || ! valid "$key" "$typed"; then
      echo "that does not look like a valid $label (it is not shown here): try again, or Ctrl+C to stop" >&2
      continue
    fi
    V[$key]=$NORMAL
    if [ "$secret" = 0 ]; then echo "  -> $NORMAL" >&2; fi
    return 0
  done
}

for svc in "${SERVICES[@]}"; do
  [ "$CHECK" = 0 ] || break         # --check asks nothing: it checks what is stored
  echo "== $svc ==" >&2
  case "$svc" in
    canvas)
      ask CANVAS_BASE_URL "Canvas API address" plain "https://northeastern.instructure.com/api/v1"
      ask CANVAS_COURSE_ID "Canvas course id" plain 260797 "the number in .../courses/<id>; this term's course"
      ask CANVAS_API_TOKEN "Canvas access token" secret "" "hidden" CANVAS_TOKEN ;;
    github)
      ask GITHUB_TOKEN_PUBLIC "GitHub token (github.com)" optional-secret "" "hidden; for the course's repositories on github.com; Enter alone skips"
      # GITHUB_TOKEN holds an enterprise token and only that: a stored one that is just the copy of the github.com token (below) is not one
      if [ -z "${V[GITHUB_BASE_URL]}" ] && [ "${V[GITHUB_TOKEN]}" = "${V[GITHUB_TOKEN_PUBLIC]}" ]; then V[GITHUB_TOKEN]=; fi
      ask GITHUB_TOKEN "GitHub Enterprise token" optional-secret "" "hidden; ONLY if your university runs its own GitHub server; Enter alone skips"
      if [ -n "${V[GITHUB_TOKEN]}" ]; then
        ask GITHUB_BASE_URL "GitHub Enterprise API address" plain "https://github.khoury.northeastern.edu/api/v3"
      else
        V[GITHUB_BASE_URL]=
        # TAi's github_query tool does not run at all unless GITHUB_TOKEN is set, and for github.com it then reads GITHUB_TOKEN_PUBLIC: a
        # course that is on github.com only keeps its one token under both names
        V[GITHUB_TOKEN]=${V[GITHUB_TOKEN_PUBLIC]}
      fi
      ask GITHUB_ALLOWED_ORGS "Organisations every student may read" optional-plain "" "comma separated, e.g. cs6650-course" ;;
    piazza)
      ask PIAZZA_EMAIL "Piazza e-mail" plain "" "" PIAZZA_EMAIL
      ask PIAZZA_PASSWORD "Piazza password" password "" "hidden" PIAZZA_PASSWORD
      ask PIAZZA_NETWORK_ID "Piazza class id or address" plain "" "the end of piazza.com/class/<id>" ;;
    deepgram)
      ask DEEPGRAM_API_KEY "Deepgram API key" secret "" "hidden; voice calls, the mock interview, voice notes" world:DEEPGRAM_API_KEY ;;
    deepseek)
      ask DEEPSEEK_API_KEY "DeepSeek API key" optional-secret "" "hidden; the gateway's deepseek model, platform.deepseek.com" ;;
    zai)
      ask ZAI_API_KEY "z.ai API key" optional-secret "" "hidden; the gateway's glm model and the reading of pictures, docs.z.ai" ;;
    smtp)
      ask SMTP_PASSWORD "SMTP password" password "" "hidden; the mail account behind TAI_SMTP_USER, for notification e-mail" ;;
  esac
done

write_env() {   # write_env FILE [gateway]: V as KEY="value" lines (the non-empty ones, in ALL_KEYS order); "gateway" adds the gateway's keys, for the check only
  {
    printf '# TAi live credentials, written by tai_credentials.sh. Mode 600. KEY="value": TAi reads one pair of double quotes off and nothing else.\n'
    for k in "${ALL_KEYS[@]}"; do
      [ -z "${V[$k]:-}" ] || printf '%s="%s"\n' "$k" "${V[$k]}"
    done
    if [ "${2:-}" = gateway ]; then
      for k in "${GW_KEYS[@]}"; do
        [ -z "${V[$k]:-}" ] || printf '%s="%s"\n' "$k" "${V[$k]}"
      done
    fi
  } > "$1"
}

smtp_extras() {   # the mail server's address, port and login (not secrets: orch.env's TAI_SMTP_*) for the check only: they are never stored in credentials.env
  local k v
  for k in TAI_SMTP_HOST TAI_SMTP_PORT TAI_SMTP_USER; do
    v=$(stored_in "$L/orch.env" "$k")
    [ -z "$v" ] || printf '%s="%s"\n' "$k" "$v"
  done
}

cand=$(mktemp "$L/.candidate-XXXXXX")
write_env "$cand" gateway
smtp_extras >> "$cand"
probe_py=$(mktemp "$L/.probe-XXXXXX")
cat > "$probe_py" <<'PY'
# Read-only checks of Canvas, GitHub and Piazza with the candidate credentials. Prints one line per service and "RESULT <service> ok|fail|skip",
# then "FACTS {json}" (ids and names, nothing secret). It never prints a value it was given, and never an exception's text.
import json, sys, urllib.error, urllib.parse, urllib.request

def read_env(path):
    out = {}
    for line in open(path, encoding='utf-8').read().split('\n'):
        t = line.strip()
        if not t or t.startswith('#') or '=' not in t:
            continue
        k, v = t.split('=', 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
            v = v[1:-1]
        if v:
            out[k.strip()] = v
    return out


class SameHost(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlparse(newurl).hostname != urllib.parse.urlparse(req.full_url).hostname:
            raise urllib.error.HTTPError(req.full_url, code, 'redirect to another host refused', headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(SameHost)


def fetch(url, headers):
    request = urllib.request.Request(url, headers=dict({'User-Agent': 'tai-credentials-check'}, **headers))
    try:
        with OPENER.open(request, timeout=25) as response:
            body = response.read(2000000)
            try:
                data = json.loads(body)
            except ValueError:
                data = None
            return response.status, data, response.headers
    except urllib.error.HTTPError as err:
        return err.code, None, err.headers
    except Exception:
        return 0, None, {}


def post_json(url, headers, body):
    """One POST of a JSON body (the z.ai check asks a model one tiny question: no service of the others has a read-only way to say the key works)."""
    request = urllib.request.Request(url, data=json.dumps(body).encode('utf-8'), method='POST',
                                     headers=dict({'User-Agent': 'tai-credentials-check', 'Content-Type': 'application/json'}, **headers))
    try:
        with OPENER.open(request, timeout=60) as response:
            raw = response.read(2000000)
            try:
                data = json.loads(raw)
            except ValueError:
                data = None
            return response.status, data, response.headers
    except urllib.error.HTTPError as err:
        return err.code, None, err.headers
    except Exception:
        return 0, None, {}


def check_canvas(env, facts):
    base, token, course = env.get('CANVAS_BASE_URL', '').rstrip('/'), env.get('CANVAS_API_TOKEN', ''), env.get('CANVAS_COURSE_ID', '')
    if not (base or token or course):
        return 'skip', 'nothing set'
    if not (base and token and course):
        return 'fail', 'incomplete: the address, the course id and the token are all needed'
    auth = {'Authorization': 'Bearer ' + token}
    status, me, _ = fetch(base + '/users/self', auth)
    if status in (401, 403):
        return 'fail', 'Canvas refused the token (HTTP %d)' % status
    if status != 200 or not isinstance(me, dict) or 'id' not in me:
        return 'fail', 'Canvas answered HTTP %d to /users/self (the address ends in /api/v1)' % status
    status, info, _ = fetch(base + '/courses/' + course, auth)
    if status != 200 or not isinstance(info, dict):
        return 'fail', 'the token works but course %s answered HTTP %d' % (course, status)
    role = 'unknown'
    status, mine, _ = fetch(base + '/users/self/courses?enrollment_state=active&per_page=100', auth)
    if status == 200 and isinstance(mine, list):
        for entry in mine:
            if isinstance(entry, dict) and str(entry.get('id')) == course:
                role = ', '.join(sorted(set(str(e.get('type')) for e in entry.get('enrollments') or [] if isinstance(e, dict)))) or 'unknown'
    facts['canvas'] = {'userId': me.get('id'), 'name': me.get('name'), 'course': info.get('name'), 'role': role}
    return 'ok', 'the token belongs to %s (user id %s); course "%s"; its role there: %s' % (me.get('name'), me.get('id'), info.get('name'), role)


def github_target(label, base, token, found):
    status, me, headers = fetch(base + '/user', {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json'})
    if status in (401, 403):
        return '%s refused the token (HTTP %d)' % (label, status)
    if status != 200 or not isinstance(me, dict) or 'login' not in me:
        return '%s answered HTTP %d to /user' % (label, status)
    scopes = headers.get('X-OAuth-Scopes') if headers else None
    found[label] = {'login': me.get('login'), 'scopes': scopes if scopes is not None else 'fine-grained or none'}
    return None


def check_github(env, facts):
    ent_token, ent_base, pub_token = env.get('GITHUB_TOKEN', ''), (env.get('GITHUB_BASE_URL') or '').rstrip('/'), env.get('GITHUB_TOKEN_PUBLIC', '')
    if not (ent_token or pub_token):
        return 'skip', 'nothing set'
    found, problems, notes = {}, [], []
    if ent_token and not ent_base and ent_token != pub_token:
        # a course on github.com only keeps its token under both names (see the prompts); anything else needs an address to go with it
        problems.append('GITHUB_TOKEN is set without an enterprise address (and is not the copy of the github.com token)')
    if ent_token and ent_base:
        base = ent_base
        host = urllib.parse.urlparse(base).hostname or ''
        if not host.startswith('github'):
            problems.append('the enterprise address %s does not start with "github": TAi\'s tool would send this token to api.github.com' % host)
        else:
            problem = github_target('enterprise', base, ent_token, found)
            if problem:
                problems.append(problem)
    if pub_token:
        problem = github_target('github.com', (env.get('GITHUB_BASE_URL_PUBLIC') or 'https://api.github.com').rstrip('/'), pub_token, found)
        if problem:
            problems.append(problem)
    if problems:
        return 'fail', '; '.join(problems)
    facts['github'] = found
    for label, info in sorted(found.items()):
        notes.append('%s: %s (scopes: %s)' % (label, info['login'], info['scopes']))
    return 'ok', '; '.join(notes)


def check_piazza(env, facts):
    email, password, nid = env.get('PIAZZA_EMAIL', ''), env.get('PIAZZA_PASSWORD', ''), env.get('PIAZZA_NETWORK_ID', '')
    if not (email or password or nid):
        return 'skip', 'nothing set'
    if not (email and password and nid):
        return 'fail', 'incomplete: the e-mail, the password and the class id are all needed'
    try:
        from piazza_api import Piazza
    except ImportError:
        return 'fail', 'the piazza-api library is not in this image'
    try:
        client = Piazza()
        client.user_login(email=email, password=password)
    except Exception as err:
        return 'fail', 'Piazza did not accept the login (%s); an account that signs in with SSO has no password: use "forgot password" to give it one' % type(err).__name__
    try:
        classes = client.get_user_classes()
    except Exception as err:
        return 'fail', 'the login worked but the class list failed (%s)' % type(err).__name__
    mine = [c for c in classes if isinstance(c, dict) and c.get('nid') == nid]
    if not mine:
        return 'fail', 'the login worked but that account is not in class %s (it is in %d class(es))' % (nid, len(classes))
    name = mine[0].get('num') or mine[0].get('name')
    facts['piazza'] = {'class': name}
    return 'ok', 'logged in; class %s is "%s"' % (nid, name)


def check_deepgram(env, facts):
    key = env.get('DEEPGRAM_API_KEY', '')
    if not key:
        return 'skip', 'nothing set'
    status, data, _ = fetch('https://api.deepgram.com/v1/auth/token', {'Authorization': 'Token ' + key})
    if status in (401, 403):
        return 'fail', 'Deepgram refused the key (HTTP %d)' % status
    if status != 200 or not isinstance(data, dict):
        return 'fail', 'Deepgram answered HTTP %d to the key check' % status
    scopes = [str(x) for x in data.get('scopes') or []]
    facts['deepgram'] = {'scopes': scopes}
    return 'ok', 'the key works with Deepgram (scopes: %s)' % (', '.join(scopes) or 'none listed')


def check_smtp(env, facts):
    password = env.get('SMTP_PASSWORD', '')
    if not password:
        return 'skip', 'nothing set'
    host, user = env.get('TAI_SMTP_HOST', ''), env.get('TAI_SMTP_USER', '')
    if not host or not user:
        return 'fail', 'the password is typed but TAI_SMTP_HOST and TAI_SMTP_USER are not set yet: tai_live.sh set TAI_SMTP_HOST=... TAI_SMTP_USER=... first'
    try:
        port = int(env.get('TAI_SMTP_PORT') or 587)
    except ValueError:
        return 'fail', 'TAI_SMTP_PORT is not a number'
    import smtplib
    import ssl
    context = ssl.create_default_context()
    try:
        if port == 465:
            server = smtplib.SMTP_SSL(host, port, timeout=20, context=context)
        else:
            server = smtplib.SMTP(host, port, timeout=20)
            server.ehlo()
            if not server.has_extn('starttls'):
                server.close()
                return 'fail', 'the mail server does not offer STARTTLS: TAi never logs in over an unencrypted connection'
            server.starttls(context=context)
            server.ehlo()
        try:
            server.login(user, password)
        finally:
            try:
                server.quit()
            except Exception:
                pass
    except smtplib.SMTPAuthenticationError:
        return 'fail', 'the mail server refused the login'
    except Exception as err:
        return 'fail', 'could not log in to the mail server (%s)' % type(err).__name__
    facts['smtp'] = {'login': 'ok', 'port': port}
    return 'ok', 'connected securely and the login works (no mail was sent)'


DEEPSEEK_API = 'https://api.deepseek.com'
DEEPSEEK_MODEL = 'deepseek-flash'     # the id eval/litellm/config.yaml asks for


def check_deepseek(env, facts):
    key = env.get('DEEPSEEK_API_KEY', '')
    if not key:
        return 'skip', 'nothing set'
    auth = {'Authorization': 'Bearer ' + key}
    status, balance, _ = fetch(DEEPSEEK_API + '/user/balance', auth)
    if status in (401, 403):
        return 'fail', 'DeepSeek refused the key (HTTP %d)' % status
    if status != 200 or not isinstance(balance, dict):
        return 'fail', 'DeepSeek answered HTTP %d to the balance check' % status
    # an empty balance is reported, not refused: the key itself is fine, and topping up is the account owner's step (every call answers 402 until then)
    available = balance.get('is_available') is True
    status, listing, _ = fetch(DEEPSEEK_API + '/models', auth)
    ids = []
    if status == 200 and isinstance(listing, dict):
        ids = [str(m.get('id')) for m in listing.get('data') or [] if isinstance(m, dict) and m.get('id')]
    facts['deepseek'] = {'balanceAvailable': available, 'models': ids[:10]}
    notes = ['the key works with DeepSeek', 'its balance is enough for calls' if available else 'its balance is EMPTY: every call is refused with HTTP 402 until it is topped up']
    if not ids:
        notes.append('its model list could not be read, so %s is not confirmed' % DEEPSEEK_MODEL)
    elif DEEPSEEK_MODEL not in ids:
        notes.append('%s is NOT in its model list (%s): the gateway alias in eval/litellm/config.yaml needs the new name' % (DEEPSEEK_MODEL, ', '.join(ids[:5])))
    return 'ok', '; '.join(notes)


ZAI_API = 'https://api.z.ai/api/coding/paas/v4'  # the OpenAI chat completions endpoint of the GLM Coding Plan: what eval/litellm/config.yaml calls (the key also works on
                                                 # https://api.z.ai/api/anthropic, and NOT on the general pay-per-token API, which answers 429 code 1113 for a Coding Plan key)
ZAI_MODEL = 'glm-5.3-flash'                      # the id eval/litellm/config.yaml asks for


def check_zai(env, facts):
    key = env.get('ZAI_API_KEY', '')
    if not key:
        return 'skip', 'nothing set'
    headers = {'Authorization': 'Bearer ' + key}
    # thinking off, as the gateway sends it: the check costs a handful of tokens, not the hundred a thinking answer to one word can
    body = {'model': ZAI_MODEL, 'max_tokens': 16, 'thinking': {'type': 'disabled'}, 'messages': [{'role': 'user', 'content': 'Reply with the single word: ok'}]}
    status, answer, _ = post_json(ZAI_API + '/chat/completions', headers, body)
    if status in (401, 403):
        return 'fail', 'z.ai refused the key (HTTP %d)' % status
    if status == 429:
        # the key is fine: the plan's quota or the rate limit is what answered, and that is the account owner's to read
        facts['zai'] = {'model': ZAI_MODEL, 'rateLimited': True}
        return 'ok', 'the key is accepted, but z.ai answered HTTP 429 (a rate limit or the plan\'s quota is used up): calls fail until it clears'
    if status != 200 or not isinstance(answer, dict):
        return 'fail', 'z.ai answered HTTP %d to a one-word request through %s (is %s still the model id?)' % (status, ZAI_API, ZAI_MODEL)
    usage = answer.get('usage') if isinstance(answer.get('usage'), dict) else {}
    facts['zai'] = {'model': ZAI_MODEL, 'endpoint': ZAI_API, 'inputTokens': usage.get('prompt_tokens'), 'outputTokens': usage.get('completion_tokens')}
    return 'ok', 'the key works with z.ai (%s through %s; the one-word check used %s input and %s output tokens)' % (ZAI_MODEL, ZAI_API, usage.get('prompt_tokens', '?'), usage.get('completion_tokens', '?'))


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
    env = read_env(sys.argv[1])
    facts = {}
    for name, check in (('canvas', check_canvas), ('github', check_github), ('piazza', check_piazza), ('deepgram', check_deepgram), ('deepseek', check_deepseek), ('zai', check_zai), ('smtp', check_smtp)):
        try:
            verdict, message = check(env, facts)
        except Exception as err:
            verdict, message = 'fail', 'the check itself failed (%s)' % type(err).__name__
        print('  %-8s %s: %s' % (name, {'ok': 'OK  ', 'fail': 'FAIL', 'skip': 'skip'}[verdict], message))
        print('RESULT %s %s' % (name, verdict))
    print('FACTS ' + json.dumps(facts, ensure_ascii=False))


if __name__ == '__main__':
    main()
PY

IMAGE=
for img in "${TAI_AGENT_IMAGE:-}" tai-agent:live tai-agent:clean; do
  [ -n "$img" ] || continue
  if docker image inspect "$img" >/dev/null 2>&1; then IMAGE=$img; break; fi
done
if [ -n "${TAI_PROBE_CMD:-}" ]; then
  # shellcheck disable=SC2206
  PROBE=($TAI_PROBE_CMD "$probe_py" "$cand")
elif [ -n "$IMAGE" ]; then
  PROBE=(docker run --rm --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges --memory 256m
         -v "$probe_py:/probe.py:ro" -v "$cand:/cand.env:ro" --entrypoint /opt/leanrag/bin/python3 "$IMAGE" /probe.py /cand.env)
else
  echo "no agent image (tai-agent:live or tai-agent:clean) on this host to run the checks in: nothing was changed" >&2
  exit 1
fi

echo "checking against the real services (read-only requests) ..." >&2
out=$("${PROBE[@]}" 2>&1) || true
if ! printf '%s\n' "$out" | grep -q '^RESULT '; then
  echo "the checks could not run: nothing was changed" >&2
  printf '%s\n' "$out" | head -n 3 | cut -c1-160 >&2      # a launcher's message; the probe prints no value
  exit 1
fi
printf '%s\n' "$out" | grep -v '^\(RESULT\|FACTS\) ' >&2 || true

failed=()
for svc in "${SERVICES[@]}"; do
  result=$(printf '%s\n' "$out" | sed -n "s/^RESULT $svc //p" | head -n 1)
  case "$result" in
    ok|skip) ;;
    *)
      for k in $(service_keys "$svc"); do V[$k]=${OLD[$k]:-}; done      # a failed check keeps what the service had
      failed+=("$svc") ;;
  esac
done

merge_facts() {      # what the checks found (ids, names, roles: nothing secret) joins owner-facts.json
  local facts
  facts=$(printf '%s\n' "$out" | sed -n 's/^FACTS //p' | tail -n 1)
  [ -n "$facts" ] || return 0
  printf '%s' "$facts" > "$L/.facts.new"
  python3 - "$FACTS" "$L/.facts.new" <<'PY'
import json, os, sys
target, fresh = sys.argv[1], sys.argv[2]
merged = json.load(open(target)) if os.path.exists(target) else {}
merged.update(json.load(open(fresh)))
with open(target, 'w') as handle:
    json.dump(merged, handle, indent=2, ensure_ascii=False)
os.chmod(target, 0o600)
PY
}

if [ "$CHECK" = 1 ]; then
  merge_facts
  if [ ${#failed[@]} -gt 0 ]; then
    echo "the stored values of ${failed[*]} do NOT check out (nothing was changed)" >&2
    exit 1
  fi
  echo "the stored values check out." >&2
  exit 0
fi

[ ! -e "$CRED" ] || [ -e "$CRED.bak-first" ] || cp -p "$CRED" "$CRED.bak-first"
write_env "$CRED.new"
chmod 600 "$CRED.new"
mv "$CRED.new" "$CRED"
echo "stored in $CRED (mode 600)" >&2
merge_facts

write_gateway_env() {      # the gateway's keys (DeepSeek's, z.ai's) go to its env file only, unquoted (docker --env-file keeps quotes as part of the value); the other lines stay
  local k old new label changed=0
  for k in "${GW_KEYS[@]}"; do
    old=${OLD[$k]:-}
    new=${V[$k]:-}
    [ "$new" != "$old" ] || continue
    if [ "$changed" = 0 ]; then
      [ ! -e "$GWENV" ] || [ -e "$GWENV.bak-first" ] || cp -p "$GWENV" "$GWENV.bak-first"
      changed=1
    fi
    { grep -v "^$k=" "$GWENV" 2>/dev/null || true; [ -z "$new" ] || printf '%s=%s\n' "$k" "$new"; } > "$GWENV.new"
    chmod 600 "$GWENV.new"
    mv "$GWENV.new" "$GWENV"
    case "$k" in DEEPSEEK_API_KEY) label="DeepSeek's" ;; ZAI_API_KEY) label="z.ai's" ;; *) label="$k" ;; esac
    if [ -n "$new" ]; then echo "$label key stored in $GWENV (mode 600), not in TAi's .env" >&2; else echo "$label key removed from $GWENV" >&2; fi
  done
  [ "$changed" = 1 ] || return 0
  echo "  the gateway reads it when it is created again: bash deploy/cs6650/tai_live.sh gateway (or the next deploy that changes the gateway)." >&2
  echo "  That cuts a call that is running: not while someone is on one." >&2
}
write_gateway_env

if [ -d "$L/tai" ] && [ -f "$BASE" ]; then
  env_tmp=$(mktemp "$L/tai/.env.XXXXXX")
  { cat "$BASE"; echo; cat "$CRED"; } > "$env_tmp"
  chmod 600 "$env_tmp"
  mv "$env_tmp" "$L/tai/.env"
  echo "applied to $L/tai/.env: the next agent container reads it" >&2
else
  echo "TAi's .env is built by the deploy step (tai_live.sh), which adds these" >&2
fi

if [ ${#failed[@]} -gt 0 ]; then
  echo "NOT stored (the check failed; the service keeps what it had): ${failed[*]}" >&2
  exit 1
fi
echo "done. Tell the agent: it runs a read-only check of its own." >&2
