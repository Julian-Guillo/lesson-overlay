"""Conservative ordered text anchors. Unknown speech stays unknown."""

import hashlib
import json
import math
import re
import unicodedata
from collections import Counter
from difflib import SequenceMatcher

PIPELINE = "1"
TOKEN = re.compile(r"[^\W_]+(?:['’][^\W_]+)*", re.UNICODE)


def tokens(text):
    return [
        unicodedata.normalize("NFKC", m.group()).lower().replace("’", "'")
        for m in TOKEN.finditer(text)
    ]


def js_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def identify(blocks):
    seen = {}
    result = []
    for b in blocks:
        identity = b["figure"] if b["kind"] == "figure" else " ".join(tokens(b["text"]))
        signature = js_json([b["kind"], b["section"], identity])
        occurrence = seen.get(signature, 0)
        seen[signature] = occurrence + 1
        result.append(
            {
                **b,
                "key": digest(js_json([b["kind"], b["section"], identity, occurrence])),
            }
        )
    return result


def source_words(aligned, duration):
    words = []
    for s in aligned["segments"]:
        for w in s.get("words", []):
            if "start" not in w or "end" not in w:
                continue
            start, end = w["start"], w["end"]
            if (
                not all(
                    isinstance(x, (int, float)) and math.isfinite(x)
                    for x in (start, end)
                )
                or not 0 <= start <= end <= duration
                or (words and start < words[-1]["start"])
            ):
                raise ValueError("Unordered or out-of-bounds aligned words")
            words.append(w)
    if not words:
        raise ValueError("No aligned words")
    return words


def complement(cues, duration):
    gaps, end = [], 0
    for c in cues:
        if c["start"] > end:
            gaps.append([end, c["start"]])
        end = c["end"]
    if end < duration:
        gaps.append([end, duration])
    return gaps


def build(snapshot, aligned, audio_hash, duration):
    if aligned["source_sha256"] != audio_hash:
        raise ValueError("Alignment belongs to different audio")
    blocks = identify(snapshot["blocks"])
    spoken = []
    for i, w in enumerate(source_words(aligned, duration)):
        spoken.extend(
            {"token": t, "start": w["start"], "end": w["end"], "index": i}
            for t in tokens(w["word"])
        )
    written, owners = [], []
    for b in blocks:
        b["tokens"] = tokens(b["text"]) if b["kind"] != "figure" else []
        b["anchors"] = {}
        if b["kind"] != "figure":
            written.extend(b["tokens"])
            owners.extend((b, i) for i in range(len(b["tokens"])))
    repeated = Counter(tuple(b["tokens"]) for b in blocks if b["kind"] != "figure")
    spoken_keys = [w["token"] for w in spoken]
    ambiguous = set()
    for phrase, count in repeated.items():
        if count > 1 and phrase:
            hits = sum(
                spoken_keys[i : i + len(phrase)] == list(phrase)
                for i in range(len(spoken_keys) - len(phrase) + 1)
            )
            if hits != count:
                ambiguous.add(phrase)
    for match in SequenceMatcher(
        None, written, [w["token"] for w in spoken], autojunk=False
    ).get_matching_blocks():
        # Ignore isolated one-word coincidences: they are unsafe across figure narration.
        if match.size < 2:
            continue
        for i in range(match.size):
            b, index = owners[match.a + i]
            if tuple(b["tokens"]) not in ambiguous:
                b["anchors"][index] = spoken[match.b + i]
    cues, covered, figure_count = [], set(), 0
    for b in blocks:
        if b["kind"] == "figure":
            continue
        matches = list(TOKEN.finditer(b["text"]))
        # Sentences control scrolling; paragraph/list element remains the highlight.
        boundaries = (
            [0]
            + [m.end() for m in re.finditer(r'(?<=[.!?])\s+(?=[A-Z"“])', b["text"])]
            + [len(b["text"])]
        )
        for lo, hi in zip(boundaries, boundaries[1:]):
            indexes = [i for i, m in enumerate(matches) if lo <= m.start() < hi]
            mapped = [(i, b["anchors"][i]) for i in indexes if i in b["anchors"]]
            if len(mapped) >= 4 and mapped[1][1]["start"] - mapped[0][1]["end"] > 3:
                mapped.pop(0)
            if not indexes or len(mapped) / len(indexes) < 0.7:
                continue
            if (
                max(
                    (r[1]["start"] - l[1]["end"] for l, r in zip(mapped, mapped[1:])),
                    default=0,
                )
                > 3
            ):
                continue
            start, end = mapped[0][1]["start"], mapped[-1][1]["end"]
            if end <= start:
                continue
            cues.append(
                {
                    "start": start,
                    "end": end,
                    "target": b["key"],
                    "from": indexes[0],
                    "to": indexes[-1] + 1,
                }
            )
            covered.update((b["key"], i) for i, _ in mapped)
    cues.sort(key=lambda c: (c["start"], c["end"]))
    # Conflicting intervals are both discarded, never reassigned or arbitrarily clipped.
    conflicts = {
        i
        for i in range(len(cues))
        for j in (i - 1, i + 1)
        if 0 <= j < len(cues)
        and max(cues[i]["start"], cues[j]["start"])
        < min(cues[i]["end"], cues[j]["end"])
    }
    cues = [c for i, c in enumerate(cues) if i not in conflicts]
    # A figure needs one candidate between prose targets and distinctive alt-label anchors.
    positions = {b["key"]: i for i, b in enumerate(blocks)}
    figure_cues = []
    stop = set(
        "the a an and or of to in on is it this that with for from by as at be are its has have was were we you our their there they can not more one two".split()
    )
    for left, right in zip(cues, cues[1:]):
        a, z = positions[left["target"]], positions[right["target"]]
        span = blocks[a + 1 : z]
        candidates = [b for b in span if b["kind"] == "figure"]
        if len(candidates) != 1 or len(span) != 1 or right["start"] - left["end"] < 2:
            continue
        b = candidates[0]
        region = [
            w
            for w in spoken
            if left["end"] <= w["start"] and w["end"] <= right["start"]
        ]
        labels = set(tokens(b.get("alt", ""))) - stop
        matching = [w for w in region if w["token"] in labels]
        distinctive = {w["token"] for w in matching}
        if (
            len(distinctive) < 6
            or len(distinctive) / max(1, len(labels)) < 0.25
            or len(matching) / max(1, len(region)) < 0.18
        ):
            continue
        start, end = matching[0]["start"], matching[-1]["end"]
        if end - start < 1:
            continue
        figure_cues.append(
            {"start": start, "end": end, "target": b["key"], "from": 0, "to": 0}
        )
        figure_count += 1
    cues = sorted(cues + figure_cues, key=lambda c: c["start"])
    # Hold only short natural pauses, within the same target and without intervening unknown speech.
    for left, right in zip(cues, cues[1:]):
        if left["target"] == right["target"] and right["start"] - left["end"] <= 0.8:
            if not any(left["end"] < w["start"] < right["start"] for w in spoken):
                left["end"] = right["start"]
    # Coverage counts only anchors in retained intervals, including all prose/outline tokens in denominator.
    heading_errors = []
    for chapter in snapshot.get("chapters", []):
        heading = next(
            (
                b
                for b in blocks
                if b["kind"] == "heading" and b["section"] == chapter.get("heading")
            ),
            None,
        )
        cue = next((c for c in cues if heading and c["target"] == heading["key"]), None)
        if cue and abs(cue["start"] - chapter["start"]) > 0.5:
            heading_errors.append(chapter["heading"])
    bad_headings = {
        b["key"]
        for b in blocks
        if b["kind"] == "heading" and b["section"] in heading_errors
    }
    cues = [c for c in cues if c["target"] not in bad_headings]
    retained = {(c["target"], i) for c in cues for i in range(c["from"], c["to"])}
    coverage = len(covered & retained) / max(1, len(written))
    report = {
        "coverage": round(coverage, 4),
        "eligible_tokens": len(written),
        "covered_tokens": len(covered & retained),
        "figures": sum(b["kind"] == "figure" for b in blocks),
        "timed_figures": figure_count,
        "chapter_disagreements": heading_errors,
        "conflicting_cues_dropped": len(conflicts),
        "verification": "Machine consistency checks; no guarantee of semantic accuracy.",
    }
    data = {
        "schema": 1,
        "normalization": 1,
        "lesson": snapshot["lesson"],
        "revision": "",
        "media": {
            "path": snapshot["media"],
            "sha256": audio_hash,
            "duration": duration,
        },
        "article": digest("\n".join(b["key"] for b in blocks)),
        "status": "ready" if coverage >= 0.9 and not heading_errors else "partial",
        "targets": [
            {"key": b["key"], "kind": b["kind"], "tokens": len(b["tokens"])}
            for b in blocks
        ],
        "cues": cues,
        "unknown": complement(cues, duration),
        "checks": report,
    }
    data["revision"] = digest(js_json(data))[:12]
    return data, report
