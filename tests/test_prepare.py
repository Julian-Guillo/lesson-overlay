"""Synthetic preparation cases; no course text/media belongs in this file."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "prepare"))
from lesson_overlay import __main__ as cli
from lesson_overlay.mapping import build, identify, tokens


class CaptureLoginTests(unittest.TestCase):
    @patch.object(cli, "login")
    @patch.object(cli, "capture")
    def test_sign_in_then_retry_once(self, capture, login):
        capture.side_effect = [cli.LoginRequired(), ("snapshot", "audio")]
        self.assertEqual(
            cli.capture_with_login("s02e03", "/browser"), ("snapshot", "audio")
        )
        login.assert_called_once_with("/browser")
        self.assertEqual(capture.call_count, 2)

    @patch.object(cli, "login")
    @patch.object(cli, "capture", side_effect=cli.LoginRequired())
    def test_unavailable_after_sign_in_stops(self, capture, login):
        with self.assertRaisesRegex(ValueError, "still unavailable"):
            cli.capture_with_login("s02e03")
        login.assert_called_once_with(None)
        self.assertEqual(capture.call_count, 2)

    @patch.object(cli, "login")
    @patch.object(cli, "capture", side_effect=ValueError("access refused"))
    def test_other_errors_do_not_trigger_sign_in(self, capture, login):
        with self.assertRaisesRegex(ValueError, "access refused"):
            cli.capture_with_login("s02e03")
        login.assert_not_called()


def snapshot(texts):
    return {
        "lesson": "s00e00",
        "media": "/lessons/s00e00/audio/demo.mp3",
        "blocks": [{"kind": "paragraph", "section": "", "text": t} for t in texts],
    }


def aligned(text, start=1, step=0.3):
    return {
        "source_sha256": "a" * 64,
        "segments": [
            {
                "text": text,
                "words": [
                    {
                        "word": w,
                        "start": round(start + i * step, 4),
                        "end": round(start + i * step + 0.2, 4),
                    }
                    for i, w in enumerate(text.split())
                ],
            }
        ],
    }


class MappingTests(unittest.TestCase):
    def test_split_paragraphs_have_same_word_clock_and_different_targets(self):
        spoken = aligned("First useful sentence. Another useful sentence.")
        joined, _ = build(
            snapshot(["First useful sentence. Another useful sentence."]),
            spoken,
            "a" * 64,
            10,
        )
        split, report = build(
            snapshot(["First useful sentence.", "Another useful sentence."]),
            spoken,
            "a" * 64,
            10,
        )
        self.assertEqual(report["coverage"], 1)
        self.assertEqual(
            [c["start"] for c in joined["cues"]], [c["start"] for c in split["cues"]]
        )
        self.assertNotEqual(joined["article"], split["article"])
        self.assertEqual(len(set(c["target"] for c in split["cues"])), 2)

    def test_repeated_phrase_with_one_spoken_occurrence_is_ambiguous(self):
        data, report = build(
            snapshot(["Repeated useful phrase.", "Repeated useful phrase."]),
            aligned("Repeated useful phrase."),
            "a" * 64,
            10,
        )
        self.assertEqual(data["cues"], [])
        self.assertEqual(report["coverage"], 0)
        self.assertEqual(data["unknown"], [[0, 10]])

    def test_missing_text_and_long_unassigned_speech_do_not_get_filled(self):
        raw = aligned("Hello useful world.")
        raw["segments"][0]["words"][1].update(start=8, end=8.2)
        raw["segments"][0]["words"][2].update(start=8.3, end=8.5)
        data, _ = build(
            snapshot(["Hello useful world.", "Entirely unrelated paragraph here."]),
            raw,
            "a" * 64,
            10,
        )
        self.assertEqual(data["cues"], [])

    def test_figure_needs_label_evidence_not_just_a_gap(self):
        s = snapshot(["First useful sentence.", "Last useful sentence."])
        s["blocks"].insert(
            1,
            {
                "kind": "figure",
                "section": "",
                "text": "",
                "figure": "/figures/demo/frame.html",
                "alt": "different labels entirely",
            },
        )
        raw = aligned(
            "First useful sentence. This is extra diagram narration. Last useful sentence."
        )
        data, report = build(s, raw, "a" * 64, 20)
        self.assertEqual(report["timed_figures"], 0)
        self.assertTrue(any(a < 2.5 < z for a, z in data["unknown"]))

    def test_media_identity_and_ordering_are_hard_errors(self):
        raw = aligned("Hello useful world.")
        with self.assertRaises(ValueError):
            build(snapshot(["Hello useful world."]), raw, "b" * 64, 10)
        raw["segments"][0]["words"][1]["start"] = -1
        with self.assertRaises(ValueError):
            build(snapshot(["Hello useful world."]), raw, "a" * 64, 10)

    def test_chapter_disagreement_is_removed_and_reduces_coverage(self):
        s = snapshot(["First useful sentence."])
        s["blocks"][0].update(kind="heading", section="intro")
        s["chapters"] = [{"heading": "intro", "start": 8}]
        data, report = build(s, aligned("First useful sentence."), "a" * 64, 10)
        self.assertEqual(data["cues"], [])
        self.assertEqual(report["chapter_disagreements"], ["intro"])
        self.assertEqual(report["coverage"], 0)

    def test_unicode_keys_and_occurrence_identity_are_stable(self):
        self.assertEqual(tokens("It’s useful\u00a0today"), ["it's", "useful", "today"])
        bs = identify(snapshot(["Same phrase.", "Same phrase."])["blocks"])
        self.assertNotEqual(bs[0]["key"], bs[1]["key"])
        self.assertEqual(
            bs[0]["key"], identify(snapshot(["Same phrase."])["blocks"])[0]["key"]
        )


class ExportTests(unittest.TestCase):
    def test_atomic_write_keeps_previous_file_when_replace_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "pack.json"
            cli.atomic_json(path, {"old": True})
            with patch.object(cli.os, "replace", side_effect=OSError("disk failure")):
                with self.assertRaises(OSError):
                    cli.atomic_json(path, {"new": True})
            self.assertEqual(json.loads(path.read_text()), {"old": True})
            self.assertEqual(list(Path(folder).glob(".writing-*")), [])

    def test_pack_manifest_detects_corruption_and_lesson_name_mismatch(self):
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.object(cli, "PACK", Path(folder)),
            patch.object(cli, "validate_file"),
        ):
            lesson = Path(folder) / "lessons" / "s00e00.json"
            cli.atomic_json(lesson, {"lesson": "s00e00", "revision": "first"})
            cli.atomic_json(Path(folder) / "manifest.json", cli.inventory())
            cli.check_pack()
            cli.atomic_json(lesson, {"lesson": "s00e00", "revision": "changed"})
            with self.assertRaisesRegex(ValueError, "manifest mismatch"):
                cli.check_pack()
            cli.atomic_json(lesson, {"lesson": "s00e01", "revision": "changed"})
            with self.assertRaisesRegex(ValueError, "name mismatch"):
                cli.inventory()


if __name__ == "__main__":
    unittest.main()
