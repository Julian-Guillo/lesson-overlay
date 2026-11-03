"""Pinned local CPU transcription plus non-interpolating English forced alignment."""

import importlib.metadata
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from .__main__ import PRIVATE, atomic_json, file_hash
from .mapping import tokens

MODELS = {
    "small": (
        "Systran/faster-whisper-small",
        "536b0662742c02347bc0e980a01041f333bce120",
    ),
    "medium": (
        "Systran/faster-whisper-medium",
        "08e178d48790749d25932bbc082711ddcfdfbc4f",
    ),
}
ALIGN_NAME = "WAV2VEC2_ASR_BASE_960H"
ALIGN_FILE = "wav2vec2_fairseq_base_ls960_asr_ls960.pth"
ALIGN_HASH = "488fd4f16de84438ffc945334278c1b9fb9b7159a806c1080b16111a958c945d"
ALIGN_URL = "https://download.pytorch.org/torchaudio/models/" + ALIGN_FILE


def group_segments(segments):
    result, pending = [], None
    for s in segments:
        if pending is None:
            pending = {"start": s["start"], "end": s["end"], "text": s["text"].strip()}
        else:
            pending["text"] += " " + s["text"].strip()
            pending["end"] = s["end"]
        if (
            re.search(r'[.!?]["”]?$', s["text"].strip())
            or pending["end"] - pending["start"] > 22
        ):
            result.append(pending)
            pending = None
    if pending:
        result.append(pending)
    return result


def run(audio, cache, size):
    os.environ.setdefault("NLTK_DATA", str(PRIVATE / "models" / "nltk"))
    os.environ.setdefault("TORCH_HOME", str(PRIVATE / "models" / "torch"))
    import numpy as np
    import torch
    import whisperx
    from faster_whisper import WhisperModel
    from huggingface_hub import snapshot_download

    torch.set_num_threads(4)
    models = PRIVATE / "models"
    models.mkdir(parents=True, exist_ok=True)
    source_hash = file_hash(audio)
    raw_path = cache / f"transcript-{size}.json"
    # ffmpeg is the tested decoder; no audio is sent to a server.
    wave = np.frombuffer(
        subprocess.check_output(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(audio),
                "-f",
                "f32le",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-",
            ]
        ),
        dtype=np.float32,
    ).copy()
    repo, revision = MODELS[size]
    if raw_path.exists():
        raw = json.loads(raw_path.read_text())
    else:
        print(f"Transcribing with pinned {size} model on CPU", flush=True)
        model_dir = snapshot_download(
            repo_id=repo, revision=revision, cache_dir=str(models / "huggingface")
        )
        model = WhisperModel(
            model_dir, device="cpu", compute_type="int8", cpu_threads=4
        )
        segments, _ = model.transcribe(
            wave, language="en", word_timestamps=True, beam_size=5
        )
        rows = [
            {
                "start": s.start,
                "end": s.end,
                "text": s.text,
                "words": [
                    {
                        "word": w.word,
                        "start": w.start,
                        "end": w.end,
                        "probability": w.probability,
                    }
                    for w in s.words or []
                ],
            }
            for s in segments
        ]
        raw = {
            "source_sha256": source_hash,
            "model": repo,
            "revision": revision,
            "segments": rows,
        }
        atomic_json(raw_path, raw)
        del model
    if raw["source_sha256"] != source_hash or raw["revision"] != revision:
        raise ValueError("Transcription cache provenance mismatch")
    align_dir = models / "alignment"
    align_dir.mkdir(parents=True, exist_ok=True)
    weights = align_dir / ALIGN_FILE
    if not weights.exists():
        # Fetch weights before loading so their exact hash is checked before torch deserializes them.
        import urllib.request

        temp = weights.with_suffix(".download")
        urllib.request.urlretrieve(ALIGN_URL, temp)
        if file_hash(temp) != ALIGN_HASH:
            temp.unlink()
            raise ValueError("Alignment model hash mismatch")
        temp.replace(weights)
    if file_hash(weights) != ALIGN_HASH:
        raise ValueError("Alignment model hash mismatch")
    model, metadata = whisperx.load_align_model(
        "en", "cpu", model_name=ALIGN_NAME, model_dir=str(align_dir)
    )
    aligned, missing = [], []
    grouped = group_segments(raw["segments"])
    for i, s in enumerate(grouped):
        padded = {
            **s,
            "start": max(0, s["start"] - 0.15),
            "end": min(len(wave) / 16000, s["end"] + 0.25),
        }
        result = whisperx.align(
            [padded], model, metadata, wave, "cpu", interpolate_method="ignore"
        )
        for segment in result["segments"]:
            words = []
            for w in segment["words"]:
                if "start" not in w or "end" not in w:
                    missing.append(w["word"])
                else:
                    words.append(w)
            aligned.append(
                {
                    "start": segment["start"],
                    "end": segment["end"],
                    "text": segment["text"],
                    "words": words,
                }
            )
        if i % 25 == 0:
            print(f"Aligned {i + 1}/{len(grouped)} segments", flush=True)
    expected = tokens(" ".join(s["text"] for s in raw["segments"]))
    actual = tokens(" ".join(s["text"] for s in aligned))
    if expected != actual:
        raise ValueError("Forced alignment changed transcript text")
    runtime = {
        p: importlib.metadata.version(p)
        for p in ("whisperx", "faster-whisper", "torch", "torchaudio")
    }
    atomic_json(
        cache / f"aligned-{size}.json",
        {
            "source_sha256": source_hash,
            "model": repo,
            "revision": revision,
            "alignment_model": ALIGN_NAME,
            "alignment_sha256": ALIGN_HASH,
            "runtime": runtime,
            "interpolation": "ignore",
            "unaligned_words": missing,
            "segments": aligned,
        },
    )


if __name__ == "__main__":
    try:
        run(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
    except ImportError as error:
        sys.exit(
            f"Missing local speech dependency ({error}). Run uv sync --project prepare --extra speech --frozen."
        )
