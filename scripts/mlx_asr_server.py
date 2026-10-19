#!/usr/bin/env python3
"""MLX ASR worker for Openstyle (Apple Silicon).

The Node server keeps this process alive and sends newline-delimited JSON over
stdin. Responses are newline-delimited JSON on stdout; logs go to stderr.

Pass any Hugging Face model id that mlx-audio supports via --model, for example:
  mlx-community/Qwen3-ASR-0.6B-5bit
  mlx-community/parakeet-...  (when published for mlx-audio STT)

Re-publish the frozen worker release when this script or mlx-audio dependencies change.
"""

from __future__ import annotations

import argparse
import json
import math
import multiprocessing
import os
import sys
import threading
import wave
from inspect import Parameter, signature
from pathlib import Path
from typing import Any

import numpy as np

_state: dict[str, Any] = {"model": None, "model_id": None}

# mlx-audio STT models use different keyword names for Openstyle word-boost / context.
# Pick the first alias present on ``generate`` — never send all.
_CONTEXT_PARAM_ALIASES: tuple[str, ...] = (
    "system_prompt",  # Qwen3-ASR
    "initial_prompt",  # Whisper
    "prompt",  # Qwen2-Audio, Granite Speech
    "context",  # VibeVoice ASR
)
_LANGUAGE_PARAM_ALIASES: tuple[str, ...] = ("language",)

# Loop guard. Greedy decoding loops on near-silent chunks: a 26 s mic chunk
# at the noise floor gave one word 4,094 times, until the default max_tokens
# 8192 stopped it (meeting 5578edb0, 2026-10-19). A global
# repetition_penalty stopped the loops but damaged normal speech (council
# r226), so the guard below acts only when a loop forms.
#
# 1. Token cap per chunk: ceil(seconds * 10) + 32. Fast speech is about
#    5.6 Qwen tokens/s (Switchboard 5.2 words/s x 1.08 tokens/word), so the
#    cap is near 2x fast speech. Whisper uses 224 tokens per 30 s.
# 2. Online loop stop, after at least 48 tokens. A loop forms when one of
#    these is true:
#    a. The last 24 tokens contain 3 or fewer unique ids
#       (mlx-audio-swift e5ba0d3). This also finds loops that change a
#       little, for example "a b a a b".
#    b. The last max(48, 4 * p) tokens repeat with a period p of 1-40
#       tokens. This finds phrase loops: a 5-word phrase had 6 or more
#       unique ids in 24 tokens, so rule a did not find it.
# 3. On a loop, decode the same audio once more without the context prompt.
# 4. Every final text goes through Qwen's detect_and_fix_repetitions.
_TOKENS_PER_SECOND_CAP = 10
_TOKEN_CAP_MARGIN = 32
_LOOP_WINDOW = 24
_LOOP_MAX_UNIQUE = 3
_LOOP_MIN_TOKENS = 48
_LOOP_MAX_PERIOD = 40
_LOOP_MIN_PERIODS = 4
# Qwen3-ASR generate() splits audio longer than this (chunk_duration
# default) and pads audio shorter than 1 s. The stream path copies only
# the padding, so it takes audio up to this length.
_STREAM_MAX_SECONDS = 1200.0


def _log(msg: str) -> None:
    print(f"[mlx-asr] {msg}", file=sys.stderr, flush=True)


def _send(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=True), flush=True)


class _DownloadProgress:
    """Holds aggregate download state and emits JSON progress to stdout."""

    def __init__(self) -> None:
        self.bytes_downloaded: int = 0
        self.bytes_total: int = 0

    def emit(self) -> None:
        if self.bytes_total > 0:
            _send({
                "type": "progress",
                "bytesDownloaded": self.bytes_downloaded,
                "bytesTotal": self.bytes_total,
            })


_dl_progress: _DownloadProgress | None = None


class _ProgressTqdm:
    """Minimal tqdm replacement that emits JSON progress lines to stdout.

    ``huggingface_hub.snapshot_download`` uses this class in two roles:

    1. **Aggregate bytes bar** — created once via ``_create_progress_bar``.
       The internal ``_AggregatedTqdm`` helper mutates ``.total`` and calls
       ``.update(n)`` / ``.refresh()`` as each file chunk arrives.
    2. **File-listing bar** — created by ``thread_map`` to show how many
       files have been fetched.  We ignore this bar (``_is_bytes=False``).

    Only the aggregate bytes bar emits progress JSON to the Node caller.
    Thread safety: ``+= total`` and ``update(n)`` are called from up to 8
    download threads.  Minor races on ``self.n``/``self.total`` are
    acceptable for a progress bar.
    """

    _lock = threading.RLock()

    @classmethod
    def get_lock(cls) -> threading.RLock:
        return cls._lock

    @classmethod
    def set_lock(cls, lock: Any) -> None:
        cls._lock = lock

    def __init__(self, iterable: Any = None, *, total: int | None = None, **_kwargs: Any) -> None:
        self._iterable = iterable
        self.total: int = total or 0
        self.n: int = _kwargs.get("initial", 0)
        self._is_bytes = _kwargs.get("unit") == "B"

    def __iter__(self) -> Any:
        if self._iterable is None:
            return
        for item in self._iterable:
            self.update(1)
            yield item

    def __len__(self) -> int:
        return self.total

    def update(self, n: int | float | None = 1) -> None:
        if n:
            self.n += int(n)
        self._emit()

    def _emit(self) -> None:
        if self._is_bytes and _dl_progress is not None and self.total > 0:
            with self._lock:
                _dl_progress.bytes_downloaded = self.n
                _dl_progress.bytes_total = self.total
                _dl_progress.emit()

    def refresh(self) -> None:
        self._emit()

    def set_description(self, *_args: Any, **_kwargs: Any) -> None:
        pass

    def close(self) -> None:
        pass

    def __enter__(self) -> "_ProgressTqdm":
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()


def _download_model(model_id: str) -> None:
    global _dl_progress
    from huggingface_hub import snapshot_download

    _dl_progress = _DownloadProgress()
    _log(f"downloading {model_id} ...")
    path = snapshot_download(model_id, tqdm_class=_ProgressTqdm)
    _dl_progress = None
    _send({"type": "downloaded", "model": model_id, "path": path})


def _model_status(model_id: str) -> None:
    from huggingface_hub import snapshot_download

    try:
        path = snapshot_download(model_id, local_files_only=True)
        _send({"downloaded": True, "model": model_id, "path": path})
    except Exception:
        _send({"downloaded": False, "model": model_id})


def _load_model(model_id: str) -> None:
    if _state["model_id"] == model_id and _state["model"] is not None:
        return

    from mlx_audio.stt import load

    _log(f"loading {model_id} ...")
    _state["model"] = load(model_id)
    _state["model_id"] = model_id
    _log("model ready")


def _function_params(fn: Any) -> dict[str, Parameter]:
    try:
        return signature(fn).parameters
    except (TypeError, ValueError):
        return {}


def _pick_supported_param(
    fn: Any,
    aliases: tuple[str, ...],
    value: str | None,
) -> dict[str, Any]:
    if not value:
        return {}
    params = _function_params(fn)
    if not params:
        return {aliases[0]: value}
    for name in aliases:
        if name in params:
            return {name: value}
    _log(f"dropping {aliases[0]!r}: not supported by {_state['model_id']}")
    return {}


def _strip_prompt_kwargs(kwargs: dict[str, Any]) -> dict[str, Any]:
    drop = set(_CONTEXT_PARAM_ALIASES)
    return {key: value for key, value in kwargs.items() if key not in drop}


def _text_from_result(result: Any) -> str:
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    if isinstance(result, list):
        for item in result:
            text = _text_from_result(item)
            if text:
                return text
        return ""
    if isinstance(result, dict):
        for key in ("text", "transcription", "result"):
            if key in result:
                return _text_from_result(result[key])
        return ""
    text = getattr(result, "text", None)
    if text is not None:
        return _text_from_result(text)
    return str(result)


def _transcribe_kwargs(
    fn: Any,
    *,
    language: str | None,
    context: str | None,
) -> dict[str, Any]:
    lang = language.strip() if language and language.strip() else None
    prompt = context.strip() if context and context.strip() else None

    kwargs: dict[str, Any] = {}
    kwargs.update(_pick_supported_param(fn, _LANGUAGE_PARAM_ALIASES, lang))
    kwargs.update(_pick_supported_param(fn, _CONTEXT_PARAM_ALIASES, prompt))
    return kwargs


def _pcm_path_to_wav_path(pcm_path: Path, sample_rate: int) -> str:
    """Convert raw PCM to a 16 kHz mono WAV path.

    Some mlx-audio models (e.g. Parakeet) accept file paths but fail on float32
    ndarrays passed to ``generate()``. Writing a sidecar WAV keeps streaming and
    batch inference on the same code path.
    """
    import wave

    pcm = np.fromfile(pcm_path, dtype=np.int16)
    out_rate = sample_rate
    if sample_rate != 16000:
        from mlx_audio.stt.utils import resample_audio

        f32 = pcm.astype(np.float32) / 32768.0
        f32 = resample_audio(f32, sample_rate, 16000)
        pcm = np.clip(f32 * 32768.0, -32768, 32767).astype(np.int16)
        out_rate = 16000

    wav_path = pcm_path.with_suffix(f"{pcm_path.suffix}.wav")
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(out_rate)
        wf.writeframes(pcm.tobytes())
    return str(wav_path)


def _audio_from_message(message: dict[str, Any]) -> str:
    audio_path = message.get("audio_path")
    if not isinstance(audio_path, str) or not audio_path:
        raise ValueError("missing audio_path")
    path = Path(audio_path)
    if not path.is_file():
        raise FileNotFoundError(audio_path)

    if message.get("audio_format") != "pcm_s16le":
        return audio_path

    sample_rate = int(message.get("sample_rate") or 16000)
    return _pcm_path_to_wav_path(path, sample_rate)


def _audio_seconds(audio: str) -> float | None:
    """Return the length of a PCM WAV file in seconds, or None."""
    try:
        with wave.open(audio, "rb") as wf:
            rate = wf.getframerate()
            return wf.getnframes() / rate if rate > 0 else None
    except (wave.Error, OSError, EOFError):
        return None


def _max_tokens_for(seconds: float) -> int:
    return math.ceil(seconds * _TOKENS_PER_SECOND_CAP) + _TOKEN_CAP_MARGIN


def _is_periodic(tokens: list[int], period: int) -> bool:
    """True when the tail of max(48, 4 * period) tokens repeats with this period."""
    window = max(_LOOP_MIN_TOKENS, _LOOP_MIN_PERIODS * period)
    n = len(tokens)
    if n < window:
        return False
    return all(tokens[i] == tokens[i - period] for i in range(n - window + period, n))


def _is_loop(tokens: list[int]) -> bool:
    if len(tokens) < _LOOP_MIN_TOKENS:
        return False
    if len(set(tokens[-_LOOP_WINDOW:])) <= _LOOP_MAX_UNIQUE:
        return True
    return any(_is_periodic(tokens, p) for p in range(1, _LOOP_MAX_PERIOD + 1))


def detect_and_fix_repetitions(text: str, threshold: int = 20) -> str:
    """Collapse long repeats, ported from Qwen3-ASR.

    Source: QwenLM/Qwen3-ASR qwen_asr/inference/utils.py, commit
    9567667698f195fa807b1581de5c03184e63d2b0 (Apache-2.0, Copyright 2026
    The Alibaba Qwen team). The logic is the same as the source.
    A character that repeats more than ``threshold`` times becomes one
    character. A pattern of 1-20 characters that repeats ``threshold`` or
    more times becomes one copy.
    """

    def fix_char_repeats(s: str, thresh: int) -> str:
        res = []
        i = 0
        n = len(s)
        while i < n:
            count = 1
            while i + count < n and s[i + count] == s[i]:
                count += 1
            if count > thresh:
                res.append(s[i])
            else:
                res.append(s[i : i + count])
            i += count
        return "".join(res)

    def fix_pattern_repeats(s: str, thresh: int, max_len: int = 20) -> str:
        n = len(s)
        min_repeat_chars = thresh * 2
        if n < min_repeat_chars:
            return s

        i = 0
        result = []
        found = False
        while i <= n - min_repeat_chars:
            found = False
            for k in range(1, max_len + 1):
                if i + k * thresh > n:
                    break
                pattern = s[i : i + k]
                valid = True
                for rep in range(1, thresh):
                    start_idx = i + rep * k
                    if s[start_idx : start_idx + k] != pattern:
                        valid = False
                        break
                if valid:
                    end_index = i + thresh * k
                    while end_index + k <= n and s[end_index : end_index + k] == pattern:
                        end_index += k
                    result.append(pattern)
                    result.append(fix_pattern_repeats(s[end_index:], thresh, max_len))
                    i = n
                    found = True
                    break
            if found:
                break
            result.append(s[i])
            i += 1

        if not found:
            result.append(s[i:])
        return "".join(result)

    text = fix_char_repeats(text, threshold)
    return fix_pattern_repeats(text, threshold)


def _can_stream(model: Any) -> bool:
    """True for a model with the Qwen3-ASR stream contract.

    Qwen3-ASR stream_generate() yields (token, logprobs) and stops at EOS.
    Other mlx-audio models also have stream_generate() but yield other
    types, so the check also asks for the tokenizer and extract_language().
    """
    return all(
        callable(getattr(model, name, None))
        for name in ("stream_generate", "extract_language")
    ) and hasattr(getattr(model, "_tokenizer", None), "decode")


def _load_waveform(audio: str) -> np.ndarray:
    from mlx_audio.stt.utils import load_audio

    return np.array(load_audio(audio))


def _stream_decode(model: Any, wav: np.ndarray, kwargs: dict[str, Any]) -> tuple[str, bool]:
    """Decode one chunk like Qwen3-ASR _generate_single_chunk(); stop on a loop.

    Without a loop, the text is the same as the text of generate(). Returns
    (text, looped).
    """
    tokens: list[int] = []
    looped = False
    for token, _ in model.stream_generate(wav, **kwargs):
        tokens.append(int(token))
        if _is_loop(tokens):
            looped = True
            break
    text = model._tokenizer.decode(tokens, skip_special_tokens=True)
    if kwargs.get("language") is None:
        _, text = model.extract_language(text)
    return text, looped


def _transcribe_streamed(
    model: Any,
    wav: np.ndarray,
    *,
    language: str | None,
    context: str | None,
) -> str:
    sample_rate = int(getattr(model, "sample_rate", 16000))
    seconds = len(wav) / sample_rate
    # generate() pads audio shorter than 1 s to 1 s. Do the same.
    if len(wav) < sample_rate:
        wav = np.pad(wav, (0, sample_rate - len(wav)))

    kwargs = _transcribe_kwargs(model.stream_generate, language=language, context=context)
    if "max_tokens" in _function_params(model.stream_generate):
        kwargs["max_tokens"] = _max_tokens_for(seconds)

    text, looped = _stream_decode(model, wav, kwargs)
    if not looped:
        return text

    trimmed = _strip_prompt_kwargs(kwargs)
    if trimmed == kwargs:
        _log("loop detected; retry without context: skipped (no context)")
        return text
    retry_text, retry_looped = _stream_decode(model, wav, trimmed)
    _log(f"loop detected; retry without context: {'looped' if retry_looped else 'ok'}")
    return retry_text


def _transcribe_generate(
    model: Any,
    audio: str,
    *,
    language: str | None,
    context: str | None,
) -> str:
    kwargs = _transcribe_kwargs(
        model.generate,
        language=language,
        context=context,
    )
    seconds = _audio_seconds(audio)
    if seconds is not None and "max_tokens" in _function_params(model.generate):
        kwargs["max_tokens"] = _max_tokens_for(seconds)
    try:
        result = model.generate(audio, **kwargs)
    except TypeError:
        trimmed = _strip_prompt_kwargs(kwargs)
        if trimmed == kwargs:
            raise
        result = model.generate(audio, **trimmed)
    return _text_from_result(result)


def _transcribe(
    audio: str,
    *,
    language: str | None,
    context: str | None,
) -> str:
    model = _state["model"]
    if model is None:
        raise RuntimeError("model not loaded")

    text: str | None = None
    if _can_stream(model):
        wav = _load_waveform(audio)
        sample_rate = int(getattr(model, "sample_rate", 16000))
        if len(wav) <= _STREAM_MAX_SECONDS * sample_rate:
            text = _transcribe_streamed(model, wav, language=language, context=context)
    if text is None:
        text = _transcribe_generate(model, audio, language=language, context=context)

    return detect_and_fix_repetitions(text.strip()).strip()


def _handle_transcribe(message: dict[str, Any]) -> None:
    req_id = message.get("id")

    try:
        audio = _audio_from_message(message)
        text = _transcribe(
            audio,
            language=message.get("language"),
            context=message.get("context"),
        )
        _send({"id": req_id, "type": "final", "text": text})
    except Exception as exc:
        _log(f"inference error: {exc}")
        _send({"id": req_id, "error": str(exc)})


def _item_field(item: Any, names: tuple[str, ...]) -> Any:
    """Read the first present attribute/key from an aligned-item span."""
    for name in names:
        value = item.get(name) if isinstance(item, dict) else getattr(item, name, None)
        if value is not None:
            return value
    return None


def _handle_align(message: dict[str, Any]) -> None:
    """Forced alignment: word times for (audio, text, language).

    Used only by a worker that loaded a forced-aligner model (specs/
    meeting-transcription-v2.md section 3.6). Input: ``{id, audio_path,
    audio_format, sample_rate, text, language}``. Output: ``{id, type:
    "aligned", words: [{text, start, end}]}`` with start/end in seconds
    relative to the audio start. A worker that loaded an ASR model answers
    with an error (its ``generate`` is not an aligner).
    """
    req_id = message.get("id")
    try:
        model = _state["model"]
        if model is None:
            raise RuntimeError("model not loaded")

        text = message.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("missing text")

        audio = _audio_from_message(message)
        language = message.get("language")
        result = model.generate(
            audio,
            text,
            language=language if isinstance(language, str) and language else "English",
        )

        # generate() returns a ForcedAlignResult (iterable of items) for a
        # single sample; be defensive about list wrappers.
        items = result.items if hasattr(result, "items") else list(result)
        words = []
        for item in items:
            wtext = _item_field(item, ("text",))
            start = _item_field(item, ("start_time", "start"))
            end = _item_field(item, ("end_time", "end"))
            if wtext is None or start is None or end is None:
                continue
            words.append(
                {
                    "text": str(wtext),
                    "start": float(start),
                    "end": float(end),
                }
            )
        _send({"id": req_id, "type": "aligned", "words": words})
    except Exception as exc:
        _log(f"align error: {exc}")
        _send({"id": req_id, "error": str(exc)})


def _serve() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            _send({"error": f"invalid json: {exc}"})
            continue

        msg_type = message.get("type")
        if msg_type == "shutdown":
            _log("shutting down")
            return
        if msg_type == "transcribe":
            _handle_transcribe(message)
            continue
        if msg_type == "align":
            _handle_align(message)
            continue
        _send({"id": message.get("id"), "error": f"unknown message type: {msg_type}"})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model",
        default="mlx-community/Qwen3-ASR-0.6B-5bit",
        help="Hugging Face model id for mlx_audio.stt.load()",
    )
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--preload", action="store_true")
    parser.add_argument("--download-model", action="store_true")
    parser.add_argument("--model-status", action="store_true")
    args = parser.parse_args()

    if args.model_status:
        _model_status(args.model)
        return

    if args.download_model:
        _download_model(args.model)
        return

    try:
        import mlx_audio  # noqa: F401
    except ImportError:
        _log("mlx_audio is not installed - run: pip install mlx-audio")
        sys.exit(1)

    _load_model(args.model)
    _send({"type": "ready", "model": args.model})
    _serve()


if __name__ == "__main__":
    # The frozen worker starts multiprocessing helpers (for example the
    # resource tracker) by running its own binary with extra arguments.
    # freeze_support() must run before argparse so these helper processes
    # do their job and do not run main() again.
    multiprocessing.freeze_support()
    main()
