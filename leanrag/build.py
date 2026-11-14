"""Build the course knowledge graph (offline, run by the operator). The graph is made from the course's RELEASED material.

    python -m leanrag.build --pages-dir <folder with weeks.json and materials-fall2026/> --dry-run
    python -m leanrag.build --pages-dir <folder> --probe                 (one real call on one unit: checks the key, the model and the answer's shape)
    python -m leanrag.build --pages-dir <folder> --slice "Day 4,Day 2"   (a few decks only: the thin slice)
    python -m leanrag.build --pages-dir <folder> --publish               (the whole corpus, then <out>/current)
    python -m leanrag.build --pages-dir <folder> --provider zai --max-calls 600 --max-output-tokens 300000     (the z.ai GLM Coding Plan: one request at a time)
    python -m leanrag.build --pages-dir <folder> --provider zai --offline --publish      (rebuild and publish from the cache: no key, nothing sent)

What leaves this computer: only the text of the corpus's units (and, for the cluster names, the entity names and descriptions made from it), to the model
API of --provider (or --base-url), one request per unit, and only after you have seen the size and the limits and typed yes (or passed --yes). The key is
the provider's environment variable or typed hidden when asked, and only when a request really has to be sent: every answer is cached (the units and the
cluster names), so a rebuild from the same text needs no key and sends nothing. The key is never written anywhere. --dry-run uses a stand-in that needs no
key and sends nothing, and writes a graph marked synthetic that is never published.

It does not import leanrag.config, leanrag.extract or leanrag.bedrock (those load a .env and use AWS); it reads no file but the pages folder and its caches.
Run from the repository root. Needs numpy, scikit-learn and pymupdf (all in the agent image); the query path needs none of them.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
import time
from pathlib import Path

from .corpus import CorpusError, load_corpus
from .graph_build import BuildParams, aggregate, build_graph, manifest_for, publish, write_artifact
from .graph_extract import HeuristicClient, build_prompt, cache_key, load_cache, make_units, run_extraction
from .llm import PROVIDERS, Budget, CachedClient, ChatClient, FatalLlmError, LazyClient, LlmError, OfflineClient, at_terminal, read_api_key, sum_usage

EST_OUT_PER_UNIT = 400           # tokens a unit's answer takes, from the dry run's shape and the old build's 9.5 tuples per chunk (the DeepSeek slice measured 498)
EST_ENTITIES_PER_UNIT = 5.9      # distinct entities per unit after merging (the DeepSeek slice: 330 for 56 units)
EST_SUMMARY_IN, EST_SUMMARY_OUT = 900, 150


class _Declined(Exception):
    """The operator did not type yes, or there was no terminal to ask at: nothing was sent. `code` is the exit code."""

    def __init__(self, code: int) -> None:
        super().__init__(code)
        self.code = code


def summary_calls(units: list) -> int:
    """How many naming and labelling requests follow the extraction: a name per cluster (about 20 entities each) and per theme (6 clusters each), and a label for the
    heaviest cross-cluster relations (at most 40). The thin slice made 46 of them for 56 units; the dry run of the whole corpus made 112 for 249."""
    clusters = max(1, round(len(units) * EST_ENTITIES_PER_UNIT / 20))
    return clusters + max(1, round(clusters / 6)) + min(40, round(clusters * 1.5))


def estimate(units: list) -> dict:
    """Tokens the run will use, by the 4-characters-a-token rule (an estimate: the API reports the real numbers)."""
    extra = summary_calls(units)
    tin = sum(sum(len(part) for part in build_prompt(u)) for u in units) // 4 + extra * EST_SUMMARY_IN
    tout = len(units) * EST_OUT_PER_UNIT + extra * EST_SUMMARY_OUT
    return {"units": len(units), "calls": len(units) + extra, "input_tokens": tin, "output_tokens": tout}


def dollars(tokens_in: int, tokens_out: int, price_in: float | None, price_out: float | None) -> str:
    if price_in is None or price_out is None:
        return "not computed (no --price-in / --price-out given)"
    return f"US${tokens_in / 1e6 * price_in + tokens_out / 1e6 * price_out:.2f}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m leanrag.build", description=__doc__.split("\n")[0])
    ap.add_argument("--pages-dir", default=os.environ.get("LEANRAG_PAGES_DIR"), help="the folder with weeks.json, homework.json, syllabus.json and materials-fall2026/")
    ap.add_argument("--out", default=str(Path("data") / "leanrag"), help="where builds, the cache and <out>/current go (default data/leanrag: git-ignored)")
    ap.add_argument("--dry-run", action="store_true", help="a stand-in model, no key, nothing sent; the graph is synthetic")
    ap.add_argument("--probe", action="store_true", help="one real call on the first unit, print what came back, stop")
    ap.add_argument("--slice", default="", help="comma-separated words: only the decks whose title has one of them (the thin slice)")
    ap.add_argument("--publish", action="store_true", help="after a real, complete build copy it to <out>/current (what the host mounts)")
    ap.add_argument("--yes", action="store_true", help="do not ask before sending (the size and the bound are printed anyway)")
    ap.add_argument("--provider", default="deepseek", choices=sorted(PROVIDERS), help="which API answers: deepseek, or zai (the z.ai GLM Coding Plan's endpoint: its quota is shared with the live service, so one request at a time)")
    ap.add_argument("--offline", action="store_true", help="send nothing and ask for no key: build from the cache only (a step that is not in it stops the build); how a finished build is rebuilt or published")
    ap.add_argument("--workers", type=int, default=None, help="requests at a time (default: the provider's, 4 for deepseek and 1 for zai)")
    ap.add_argument("--base-url", default=None, help="default: the provider's")
    ap.add_argument("--model", default=None, help="default: the provider's")
    ap.add_argument("--max-calls", type=int, default=400)
    ap.add_argument("--max-input-tokens", type=int, default=600_000)
    ap.add_argument("--max-output-tokens", type=int, default=170_000)
    ap.add_argument("--price-in", type=float, default=None, help="US$ per million input tokens, to print a cost bound")
    ap.add_argument("--price-out", type=float, default=None, help="US$ per million output tokens")
    ap.add_argument("--now", default=None, help="the clock for which assignments are unlocked (ISO, UTC); default the real time")
    ap.add_argument("--retry-failed", action="store_true")
    ap.add_argument("--default-mode", default="hybrid", choices=["hybrid", "entity", "bm25"], help="which mode of the engine the tool serves from this graph (written to the manifest)")
    ap.add_argument("--publish-build", default="", help="publish a build that is already in <out>/builds (its folder name, or a path) as <out>/current and stop: no corpus is read, no key, nothing sent")
    args = ap.parse_args(argv)

    def say(msg: str) -> None:
        try:
            print(msg, flush=True)
        except UnicodeEncodeError:        # a Windows console that cannot show a bullet or an arrow in a slide's words: show a ? instead of stopping a run that is paid for
            enc = getattr(sys.stdout, "encoding", None) or "ascii"
            print(msg.encode(enc, "replace").decode(enc), flush=True)

    if args.publish_build:
        return _publish_existing(args.publish_build, Path(args.out), say)
    if not args.pages_dir:
        ap.error("--pages-dir (or LEANRAG_PAGES_DIR) is required")

    now = dt.datetime.fromisoformat(args.now.replace("Z", "+00:00")) if args.now else None
    try:
        corpus = load_corpus(args.pages_dir, now=now)
    except CorpusError as exc:
        say(f"STOP: {exc}")
        return 2
    chunks = corpus.chunks
    if args.slice:
        words = [w.strip().lower() for w in args.slice.split(",") if w.strip()]
        keep = {c.deck for c in chunks if c.kind == "slide" and any(w in c.title.lower() for w in words)}
        chunks = [c for c in chunks if c.kind == "slide" and c.deck in keep]
        say(f"thin slice: {len(keep)} deck(s): {', '.join(sorted(keep)) or 'none matched'}")
    provider = PROVIDERS[args.provider]
    base_url = args.base_url or provider.base_url
    model = args.model or provider.model
    workers = args.workers or provider.workers
    out = Path(args.out)
    cache = out / "cache" / ("extract-dry.jsonl" if args.dry_run else f"extract-{model}.jsonl")
    names_cache = out / "cache" / f"naming-{model}.jsonl"
    units = make_units(chunks)
    est = estimate(units)
    cached = {} if args.dry_run else load_cache(cache)
    pending = units if args.dry_run else [u for u in units if cache_key(model, u) not in cached or (cached[cache_key(model, u)].get("failed") and args.retry_failed)]
    say(f"corpus: {len(corpus.chunks)} chunks read ({sum(len(c.text) for c in corpus.chunks)} characters), {len(chunks)} in this run, {est['units']} units"
        + (f", {len(units) - len(pending)} of them already in the cache" if len(pending) < len(units) and not args.dry_run else ""))
    for w in corpus.warnings:
        say(f"warning: {w}")
    cost = dollars(est['input_tokens'], est['output_tokens'], args.price_in, args.price_out)
    if args.provider == "zai" and args.price_in is None:
        cost = "none per token: it uses the coding plan's quota (its 5-hour and weekly limits apply)"
    say(f"estimate: about {est['calls']} requests, {est['input_tokens']:,} input and {est['output_tokens']:,} output tokens; cost {cost}")
    say(f"hard limits for this run: {args.max_calls} requests, {args.max_input_tokens:,} input, {args.max_output_tokens:,} output tokens (the run stops when one is reached)")
    if not units:
        say("STOP: nothing to extract")
        return 2

    params = BuildParams()
    stats: dict = {}
    if args.dry_run:
        client = HeuristicClient()
        naming = client
        say("DRY RUN: a stand-in model answers; nothing is sent anywhere and no key is read")
    elif args.offline:
        if args.probe:
            say("STOP: --probe sends a request and --offline sends none")
            return 2
        if pending:
            say(f"STOP: --offline, and {len(pending)} of {len(units)} units are not in the cache ({cache}): nothing was sent; run once without --offline to fill it")
            return 3
        client = OfflineClient(model)
        naming = CachedClient(client, names_cache)
        say("OFFLINE: nothing is sent and no key is read; every step must already be in the cache")
    else:
        if args.provider == "zai":
            say(f"note: {provider.note}. Run it at a quiet hour: it stops at the plan's first limit and keeps what it has done.")

        def make() -> ChatClient:
            """Asked for when a request first has to be sent: the key (typed hidden unless it is in the provider's variable), then the yes."""
            key = read_api_key(names=provider.key_variables, host=provider.host)
            real = ChatClient(key, base_url=base_url, model=model, budget=Budget(args.max_calls, args.max_input_tokens, args.max_output_tokens))
            say(f"model asked for: {real.model} at {real.base_url}")
            if not args.probe and not args.yes:
                if not at_terminal():
                    say("STOP: not at a terminal and no --yes: nothing was sent")
                    raise _Declined(2)
                if pending:
                    what = f"the text of {len(pending)} units (about {sum(len(u.text) for u in pending):,} characters of course material, no student data)"
                else:
                    what = "the entity names and descriptions of the graph (made from course text, no student data) to name its clusters"
                if input(f"Send {what} to {real.base_url}? type yes: ").strip().lower() != "yes":
                    say("not sent")
                    raise _Declined(1)
            return real

        client = LazyClient(model, make)
        naming = CachedClient(client, names_cache)
        try:
            if args.probe:
                return _probe(client.ensure(), units[0], say)
            if pending:
                client.ensure()                       # the key and the yes are asked here, on the main thread, before any request goes out
            else:
                say("every unit is already in the cache: no key and nothing sent for the extraction")
        except _Declined as stop:
            return stop.code
        except LlmError as exc:
            say(f"STOP: {exc}")
            return 2

    # the first request goes alone: a key, a model id or a parameter the API does not accept shows here, after one request, and not after hundreds
    first = pending[:1] if pending else units[:1]
    warm = run_extraction(first, client, cache, workers=1, retry_failed=args.retry_failed)
    if not warm.complete or not warm.results or warm.results[0].parsed is None:
        why = warm.stopped_because or (warm.results[0].error if warm.results else "no answer")
        say(f"STOP: the first request did not give a usable answer ({why}); nothing else was sent")
        return 3
    if not args.dry_run and pending:
        say(f"first request ok: the model that answered is {warm.results[0].model!r}")
    report = run_extraction(units, client, cache, workers=workers, progress=say, retry_failed=args.retry_failed)
    counts = report.counts()
    say(f"extraction: {counts['ok']} of {counts['units']} units parsed ({counts['from_cache']} from the cache), {counts['entities_kept']} entities and {counts['relations_kept']} relations kept, dropped {counts['dropped']}")
    proposed = counts["entities_kept"] + counts["dropped"].get("ungrounded", 0)
    per_unit = counts["completion_tokens"] / max(1, counts["units"])
    say(f"quality: {counts['entities_kept'] / max(1, counts['ok']):.1f} entities per unit, {100 * counts['dropped'].get('ungrounded', 0) / max(1, proposed):.0f}% of the entities the model proposed were dropped as not in the text, "
        f"slides replaced {counts['notes'].get('slides_replaced', 0)} / not cited {counts['notes'].get('slides_uncited', 0)}; "
        f"{per_unit:.0f} output tokens per unit, so {per_unit * len(make_units(corpus.chunks)):,.0f} for the whole corpus ({len(make_units(corpus.chunks))} units)")
    if not report.complete:
        say(f"STOPPED: {report.stopped_because or 'some units were not done'}. What was done is in the cache ({cache}); run the same command again to continue.")
        return 3
    entities, relations = aggregate(report.results)
    say(f"aggregated: {len(entities)} entities, {len(relations)} relations")
    if not entities:
        say("STOP: the extraction kept no entity")
        return 3
    try:
        graph = build_graph(entities, relations, naming, params, progress=say, stats=stats)
    except _Declined as stop:
        return stop.code
    except FatalLlmError as exc:
        say(f"STOPPED while naming the clusters: {exc}. The units are all in the cache and so is every name asked so far ({names_cache}); run the same command again to continue.")
        return 3
    # the totals are of the answers this graph is made from (cached or fresh): a rebuild from the cache says what the graph cost, and `this_run` what this process sent
    usage = sum_usage(report.records() + list(getattr(naming, "used", {}).values()))
    usage["this_run"] = client.usage.to_dict() if hasattr(client, "usage") else {}
    manifest = manifest_for(corpus, report, graph, params, client, synthetic=args.dry_run, usage=usage, default_mode=args.default_mode, naming=stats)
    manifest["slice"] = args.slice or ""
    manifest["provider"] = args.provider
    corpus_hash = hashlib.sha256(json.dumps(corpus.files, sort_keys=True).encode()).hexdigest()[:8]
    build_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + corpus_hash + ("-slice" if args.slice else "") + ("-dry" if args.dry_run else "")
    build_dir = write_artifact(out / ("dry-run" if args.dry_run else "builds") / build_id, chunks, graph, manifest)
    say(f"graph: {manifest['graph']}")
    say(f"tokens in the answers this graph is made from: {usage.get('prompt_tokens', 0):,} in, {usage.get('completion_tokens', 0):,} out in {usage.get('calls', 0)} requests; models that answered: {usage.get('models_returned', {})}")
    sent_now = usage["this_run"]
    say(f"sent by this run: {sent_now.get('calls', 0)} requests ({sent_now.get('prompt_tokens', 0):,} in, {sent_now.get('completion_tokens', 0):,} out)")
    say(f"wrote {build_dir}")
    if args.publish and not args.dry_run and not args.slice:
        say(f"published to {publish(build_dir, out)} (the host mounts it only when TAI_LEANRAG=1 and the host has it)")
    elif args.publish:
        say("not published: a dry run or a slice is never published")
    return 0


def _publish_existing(which: str, out: Path, say) -> int:
    """Copy a finished build to <out>/current, exactly as it is (the graph that was looked at is the graph that is published). Never a slice, never synthetic, never partial."""
    build_dir = Path(which)
    if not build_dir.is_dir():
        build_dir = out / "builds" / which
    manifest_path = build_dir / "manifest.json"
    if not manifest_path.is_file():
        say(f"STOP: no build at {build_dir} (it needs a manifest.json; builds are in {out / 'builds'})")
        return 2
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except ValueError:
        say(f"STOP: {manifest_path} is not readable")
        return 2
    if manifest.get("synthetic"):
        say("STOP: that build is synthetic (a dry run): it is never published")
        return 2
    if manifest.get("slice") or build_dir.name.endswith("-slice"):
        say("STOP: that build is a slice (a few decks only): it is never published")
        return 2
    if not (manifest.get("extraction") or {}).get("complete"):
        say("STOP: that build is not complete")
        return 2
    say(f"published {build_dir.name} to {publish(build_dir, out)} (the host mounts it only when TAI_LEANRAG=1 and the host has it)")
    return 0


def _probe(client: ChatClient, unit, say) -> int:
    from .graph_extract import parse_response  # noqa: PLC0415

    system, user = build_prompt(unit)
    try:
        done = client.complete_json(system, user, 1500)
    except LlmError as exc:
        say(f"PROBE FAILED: {exc}")
        return 3
    parsed = parse_response(done.text, unit)
    say(f"probe: model that answered {done.model!r}, {done.prompt_tokens} in / {done.completion_tokens} out tokens, finish {done.finish_reason!r}")
    if parsed is None:
        say("probe: the answer is NOT the JSON object asked for; first 300 characters:")
        say(done.text[:300])
        return 3
    say(f"probe: parsed {len(parsed.entities)} entities and {len(parsed.relations)} relations, dropped {parsed.dropped}")
    for e in parsed.entities[:5]:
        say(f"   entity: {e['name']} [{e['type']}] slides {e['chunks']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
