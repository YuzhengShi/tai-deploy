#!/usr/bin/env bash
# Runs ON the CS6650 host, started from the owner's own terminal:
#   ssh -t "$TAI_HOST" "bash ~/tai-weak/bin/setup_keys.sh"
# Asks for the two provider keys without echoing them and for the weak model to test. The keys go to ~/tai-weak/weak.env (mode 600),
# which only the scratch gateway's `docker run --env-file` reads; the choice and its UTC time go to ~/tai-weak/choice.txt.
# Nothing here prints a key. Press Enter on an empty key to keep the one already saved.
set -u
D="$HOME/tai-weak"
F="$D/weak.env"
mkdir -p "$D"
umask 077
touch "$F"
chmod 600 "$F"

ask_key() {   # name, where to get it
  local name="$1" where="$2" k have=""
  grep -q "^$name=." "$F" 2>/dev/null && have=" (Enter keeps the saved one)"
  printf '\n%s  [%s]%s\nPaste it, then press Enter (nothing is shown): ' "$name" "$where" "$have"
  IFS= read -rs k
  echo
  k="${k//[$'\r\n\t ']/}"
  if [ -z "$k" ]; then
    [ -n "$have" ] && echo "  kept the saved $name" || echo "  nothing typed: $name not saved"
    return 0
  fi
  { grep -v "^$name=" "$F" 2>/dev/null; printf '%s=%s\n' "$name" "$k"; } > "$F.new" && mv "$F.new" "$F" && chmod 600 "$F"
  echo "  saved $name (${#k} characters)"
}

echo "TAi weak-model experiment: two keys and one choice. Keys stay on this host, in ~/tai-weak/weak.env (mode 600)."
ask_key DEEPSEEK_API_KEY "platform.deepseek.com -> API keys (the baseline, deepseek-flash)"
ask_key OPENROUTER_API_KEY "openrouter.ai -> Keys (the weak model; a few dollars of credit is enough)"

printf '\nWhich weak model?\n  1 = Ministral 3 8B (Mistral, Apache 2.0)   [default]\n  2 = Llama 3.1 8B Instruct (Meta, served by Groq)\n  3 = both (Ministral is the main result)\nType 1, 2 or 3 and press Enter: '
IFS= read -r c
case "${c// /}" in
  2) pick="W-b llama-3.1-8b" ;;
  3) pick="W-a ministral-8b + W-b llama-3.1-8b" ;;
  *) pick="W-a ministral-8b" ;;
esac
printf 'choice=%s\nat=%s\n' "$pick" "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" > "$D/choice.txt"
chmod 600 "$D/choice.txt"
echo "  weak model: $pick"
echo
echo "Done. You can close this tab; the runs start by themselves."
