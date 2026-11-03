"""Maintainer CLI. All course artifacts and authentication remain in .private/."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .mapping import PIPELINE, build, digest, js_json

ROOT = Path(__file__).resolve().parents[2]
PRIVATE = ROOT / ".private"
PACK = ROOT / "timings"
ID = re.compile(r"s\d{2}e\d{2}\Z")


def file_hash(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".writing-")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(js_json(value) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextmanager
def lock():
    # The maintainer CLI targets Linux/macOS; recipients need only their browser.
    import fcntl

    PRIVATE.mkdir(mode=0o700, exist_ok=True)
    PRIVATE.chmod(0o700)
    with (PRIVATE / "prepare.lock").open("w") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another preparation/pack update is running") from None
        yield


def duration(path):
    return float(
        subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nw=1:nk=1",
                str(path),
            ],
            text=True,
        )
    )


def validate_file(path, snapshot=None):
    # The same validator is the trust boundary in both the worker and preparation CLI.
    command = ["node", str(ROOT / "prepare" / "validate.cjs"), str(path)]
    if snapshot:
        command.append(str(snapshot))
    subprocess.run(command, cwd=ROOT, check=True)


def inventory():
    entries = []
    for path in sorted((PACK / "lessons").glob("*.json")):
        if not ID.fullmatch(path.stem):
            raise ValueError("Unexpected file in timings/lessons")
        validate_file(path)
        d = json.loads(path.read_text())
        if d["lesson"] != path.stem:
            raise ValueError("Timing file lesson/name mismatch")
        entries.append(
            {
                "lesson": path.stem,
                "file": f"lessons/{path.name}",
                "sha256": file_hash(path),
                "revision": d["revision"],
            }
        )
    return {"schema": 1, "revision": digest(js_json(entries))[:12], "lessons": entries}


def check_pack():
    expected = inventory()
    actual = json.loads((PACK / "manifest.json").read_text())
    if actual != expected:
        raise ValueError("Pack manifest mismatch; regenerate before sharing")
    print(
        f"Pack valid: {len(expected['lessons'])} lesson(s), revision {expected['revision']}"
    )


def browser_context(playwright, headed=False, executable=None):
    profile = PRIVATE / "browser-profile"
    return playwright.chromium.launch_persistent_context(
        str(profile),
        headless=not headed,
        executable_path=executable,
        accept_downloads=True,
        viewport={"width": 1280, "height": 900},
    )


def capture(lesson, executable=None):
    from playwright.sync_api import sync_playwright

    folder = PRIVATE / "captures" / lesson
    folder.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p, browser_context(p, executable=executable) as context:
        page = context.new_page()
        response = page.goto(
            f"https://hq.mega.dev/lessons/{lesson}/", wait_until="domcontentloaded"
        )
        if response is None or response.status >= 400:
            raise ValueError(
                "Course access refused. Use the supported sign-in/browser capture route; no automatic access retries."
            )
        if not page.locator(".lesson-article .prose").count():
            raise ValueError(
                "Lesson unavailable or login expired. Run the login command in the dedicated profile."
            )
        source = (ROOT / "shared.js").read_text()
        blocks = page.evaluate(
            "() => {"
            + source
            + "\nreturn LessonOverlay.snapshot(document).map(({element,parts,...b}) => ({...b,figure:b.kind==='figure'?b.identity:undefined}));}"
        )
        media = page.locator("audio.lesson-audio-media").get_attribute("src")
        if (
            not media
            or not media.startswith(f"/lessons/{lesson}/audio/")
            or ".." in media
            or "?" in media
        ):
            raise ValueError("Unsupported lesson audio path")
        chapters = page.locator("[data-start][data-heading]").evaluate_all(
            "els => els.map(e => ({start:Number(e.dataset.start),heading:e.dataset.heading}))"
        )
        snapshot = {
            "lesson": lesson,
            "media": media,
            "blocks": blocks,
            "chapters": chapters,
            "capture": "dedicated authenticated browser",
            "browser": context.browser.version
            if context.browser
            else "persistent Chromium",
        }
        # Keep the page's real structure for private integration debugging. It is never distributed.
        (folder / "article.html").write_text(
            page.locator(".lesson-article").evaluate("e=>e.outerHTML")
        )
        audio_response = context.request.get(
            "https://hq.mega.dev" + media, fail_on_status_code=False
        )
        if not audio_response.ok or not audio_response.headers.get(
            "content-type", ""
        ).lower().startswith(("audio/", "application/octet-stream")):
            raise ValueError("Audio download refused or did not return media")
        if int(audio_response.headers.get("content-length", "0")) > 512_000_000:
            raise ValueError("Audio exceeds 512 MB")
        body = audio_response.body()
        if len(body) > 512_000_000:
            raise ValueError("Audio exceeds 512 MB")
        media_file = folder / "audio.mp3"
        media_file.write_bytes(body)
        atomic_json(folder / "snapshot.json", snapshot)
    return folder / "snapshot.json", media_file


def login(executable=None):
    from playwright.sync_api import sync_playwright

    with (
        sync_playwright() as p,
        browser_context(p, headed=True, executable=executable) as context,
    ):
        page = context.new_page()
        page.goto("https://hq.mega.dev/lessons", wait_until="domcontentloaded")
        print(
            "Sign in in the dedicated preparation window, then close that window. Your everyday profile is not used.",
            flush=True,
        )
        try:
            page.wait_for_event("close", timeout=0)
        except Exception:
            if page.is_closed():
                return
            raise


def speech(audio, cache, model):
    output = cache / f"aligned-{model}.json"
    if output.exists():
        print(f"Reusing aligned {model} cache", flush=True)
        return json.loads(output.read_text())
    subprocess.run(
        [sys.executable, "-m", "lesson_overlay.speech", str(audio), str(cache), model],
        check=True,
    )
    return json.loads(output.read_text())


def prepare(args):
    if not ID.fullmatch(args.lesson):
        raise ValueError("Lesson ID must have the form s00e00")
    if bool(args.snapshot) != bool(args.audio):
        raise ValueError("Supply both --snapshot and --audio, or neither")
    if args.aligned and not args.snapshot:
        raise ValueError(
            "--aligned requires explicit --snapshot and --audio provenance"
        )
    snapshot_path, audio = (
        (args.snapshot.resolve(), args.audio.resolve())
        if args.snapshot
        else capture(args.lesson, args.browser)
    )
    snapshot = json.loads(snapshot_path.read_text())
    if (
        snapshot["lesson"] != args.lesson
        or not snapshot.get("blocks")
        or len(snapshot["blocks"]) > 5000
    ):
        raise ValueError("Snapshot lesson mismatch or invalid blocks")
    for b in snapshot["blocks"]:
        if (
            b["kind"] not in ("paragraph", "item", "heading", "figure")
            or not isinstance(b["section"], str)
            or not isinstance(b["text"], str)
        ):
            raise ValueError("Invalid snapshot block")
    sha = file_hash(audio)
    length = duration(audio)
    # Speech cache is independent of DOM boundaries, so text-only changes reuse expensive inference.
    cache = PRIVATE / "cache" / digest(sha + PIPELINE)
    cache.mkdir(parents=True, exist_ok=True)
    if args.aligned:
        aligned = json.loads(args.aligned.read_text())
        if aligned.get("source_sha256") != sha:
            raise ValueError("Seed alignment/audio hash mismatch")
        atomic_json(cache / "aligned-small.json", aligned)
    aligned = speech(audio, cache, "small")
    data, report = build(snapshot, aligned, sha, length)
    retry = report["coverage"] < 0.9 or report["chapter_disagreements"]
    retry_error = None
    if retry and not args.no_retry:
        print("Coverage/chapters need a bounded medium-model retry", flush=True)
        try:
            candidate, candidate_report = build(
                snapshot, speech(audio, cache, "medium"), sha, length
            )
            if (
                len(candidate_report["chapter_disagreements"]),
                -candidate_report["coverage"],
            ) < (len(report["chapter_disagreements"]), -report["coverage"]):
                data, report = candidate, candidate_report
        except (ValueError, OSError, subprocess.CalledProcessError) as error:
            retry_error = type(error).__name__
            print(
                "Medium retry failed; retaining the first valid candidate, subject to the same checks.",
                flush=True,
            )
    report = {
        **report,
        "pipeline": PIPELINE,
        "audio_sha256": sha,
        "snapshot_sha256": file_hash(snapshot_path),
        "retry_requested": bool(retry),
        "retry_skipped": bool(retry and args.no_retry),
        "retry_error": retry_error,
        "generated": datetime.now(timezone.utc).isoformat(),
    }
    reports = PRIVATE / "reports"
    atomic_json(reports / f"{args.lesson}.json", report)
    if report["coverage"] < 0.7 or not data["cues"]:
        raise ValueError(
            "Usable coverage below 70%; previous pack retained. See .private/reports."
        )
    # Validate the entire existing pack before changing it; corrupt neighbors do not cause half-updates.
    inventory()
    candidate_path = cache / "candidate.json"
    atomic_json(candidate_path, data)
    validate_file(candidate_path, snapshot_path)
    integration = subprocess.check_output(
        ["node", "tests/check-lesson.cjs", str(snapshot_path), str(candidate_path)],
        cwd=ROOT,
        text=True,
    )
    report["runtime_checks"] = json.loads(integration)
    atomic_json(reports / f"{args.lesson}.json", report)
    target = PACK / "lessons" / f"{args.lesson}.json"
    old = target.read_bytes() if target.exists() else None
    try:
        atomic_json(target, data)
        atomic_json(PACK / "manifest.json", inventory())
    except Exception:
        if old is None:
            target.unlink(missing_ok=True)
        else:
            target.write_bytes(old)
        raise
    print(
        f"{args.lesson}: {data['status']}, {report['coverage']:.1%} prose coverage, {len(data['cues'])} cues, {report['timed_figures']}/{report['figures']} figures; revision {data['revision']}"
    )
    print(
        "Private pack: timings/. Reload the extension and refresh the lesson after copying updates."
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("lesson")
    p.add_argument(
        "--snapshot",
        type=Path,
        help="Agent/browser capture JSON instead of a new signed-in capture",
    )
    p.add_argument("--audio", type=Path)
    p.add_argument(
        "--aligned",
        type=Path,
        help="Seed a matching existing local alignment; original input is preserved",
    )
    p.add_argument(
        "--no-retry",
        action="store_true",
        help="Explicit offline import: report but skip medium inference",
    )
    p.add_argument(
        "--browser",
        help="Maintainer browser executable; uses a separate .private profile",
    )
    p = sub.add_parser("login")
    p.add_argument("--browser")
    sub.add_parser("check-pack")
    args = parser.parse_args()
    try:
        with lock():
            if args.command == "prepare":
                prepare(args)
            elif args.command == "login":
                login(args.browser)
            else:
                check_pack()
    except Exception as error:
        print(f"Preparation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
