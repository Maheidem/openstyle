#!/usr/bin/env python3
"""MLX ASR worker for Openstyle (Apple Silicon).

The Node server keeps this process alive and sends newline-delimited JSON over
stdin. Responses are newline-delimited JSON on stdout; logs go to stderr.

Pass any Hugging Face model id that mlx-audio supports via --model, for example:
  mlx-community/Qwen3-ASR-0.6B-5bit
  mlx-community/parakeet-...  (when published for mlx-audio STT)

LLM mode: ``--llm --model <hfId> --port <port>`` loads an mlx-lm model and
serves an OpenAI-style HTTP API on 127.0.0.1 (specs/local-mlx-llm.md section 2).

Embed mode: ``--embed --model <hfId> [--revision <sha>] --port <port>`` loads an
embedding model with mlx-vlm and serves ``POST /v1/embeddings`` on 127.0.0.1
(specs/local-semantic-search.md section 5.2).

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
import time
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


# ---------------------------------------------------------------------------
# LLM mode (specs/local-mlx-llm.md section 2).
#
# ``--llm --model <hfId> --port <port>`` loads an mlx-lm model and serves an
# OpenAI-style API on 127.0.0.1. HTTPServer handles one request at a time, so
# generation is serial. Strict JSON uses an llguidance logits processor
# (probe X2, .scratchpad/probe-x2/harness.py). Keep whitespace_flexible True:
# compact whitespace broke the output in probe X2.
# ---------------------------------------------------------------------------

# The JSON options of every strict grammar. Flexible whitespace stays on, so
# the model can start its natural pretty layout (probe X2: compact JSON made
# Qwen3.5 give empty lists and loops). The pattern bounds each whitespace run
# between two JSON tokens to 24 characters: the deepest pretty indent of our
# schemas is about 13 (newline + 3 levels of 4 spaces). Without the bound,
# Gemma 4 E2B wrote "\n" + 4 spaces until max_tokens after a closed list
# (PR #258, run 954be5f9: 3104 content chars, then only whitespace).
_JSON_GRAMMAR_OPTIONS: dict[str, Any] = {
    "whitespace_flexible": True,
    "whitespace_pattern": r"[\x20\x0A\x0D\x09]{0,24}",
}

_LLM_DEFAULT_MAX_TOKENS = 4096
# (open, close) of an empty thinking block. Qwen3.5 and Gemma 4.
_THINK_PAIRS: tuple[tuple[str, str], ...] = (("<think>", "</think>"), ("<|channel>", "<channel|>"))


class _BadRequest(Exception):
    pass


def _message_text(content: Any) -> str:
    """Flatten OpenAI content (a string or a list of text parts) to a string."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                parts.append(str(part.get("text") or ""))
            elif isinstance(part, str):
                parts.append(part)
            else:
                raise _BadRequest("only text content parts are supported")
        return "".join(parts)
    raise _BadRequest("message content must be a string or a list of text parts")


def _opt_number(body: dict[str, Any], name: str, cast: Any) -> Any:
    value = body.get(name)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _BadRequest(f"{name} must be a number")
    return cast(value)


def _parse_chat_request(body: Any) -> dict[str, Any]:
    """Validate a /v1/chat/completions body. Unknown fields are ignored."""
    if not isinstance(body, dict):
        raise _BadRequest("request body must be a JSON object")
    if body.get("stream"):
        raise _BadRequest("stream is not supported; send stream: false")

    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise _BadRequest("messages must be a non-empty list")
    parsed_messages = []
    for msg in messages:
        if not isinstance(msg, dict) or not isinstance(msg.get("role"), str):
            raise _BadRequest("each message needs a role")
        parsed_messages.append({"role": msg["role"], "content": _message_text(msg.get("content"))})

    max_tokens = body.get("max_tokens", body.get("max_completion_tokens"))
    if max_tokens is None:
        max_tokens = _LLM_DEFAULT_MAX_TOKENS
    if isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or max_tokens < 1:
        raise _BadRequest("max_tokens must be a positive integer")

    stop = body.get("stop")
    if stop is None:
        stop = []
    elif isinstance(stop, str):
        stop = [stop]
    elif not (isinstance(stop, list) and all(isinstance(s, str) for s in stop)):
        raise _BadRequest("stop must be a string or a list of strings")

    schema: Any = None
    response_format = body.get("response_format")
    if response_format is not None:
        if not isinstance(response_format, dict):
            raise _BadRequest("response_format must be an object")
        kind = response_format.get("type")
        if kind == "json_schema":
            spec = response_format.get("json_schema")
            schema = spec.get("schema") if isinstance(spec, dict) else response_format.get("schema")
            if not isinstance(schema, dict):
                raise _BadRequest("response_format.json_schema.schema must be an object")
        elif kind == "json_object":
            schema = {"type": "object"}
        elif kind not in (None, "text"):
            raise _BadRequest(f"unsupported response_format type: {kind}")

    kwargs = body.get("chat_template_kwargs")
    if kwargs is not None and not isinstance(kwargs, dict):
        raise _BadRequest("chat_template_kwargs must be an object")
    enable_thinking = bool((kwargs or {}).get("enable_thinking", False))

    return {
        "messages": parsed_messages,
        "max_tokens": max_tokens,
        "temperature": _opt_number(body, "temperature", float),
        "top_p": _opt_number(body, "top_p", float),
        "top_k": _opt_number(body, "top_k", int),
        "min_p": _opt_number(body, "min_p", float),
        "repetition_penalty": _opt_number(body, "repetition_penalty", float),
        "stop": [s for s in stop if s],
        "schema": schema,
        "enable_thinking": enable_thinking,
    }


def _single_token_id(hf_tok: Any, text: str) -> int | None:
    """Return the id of a token that exists as one vocab entry, else None."""
    vocab = hf_tok.get_vocab() if hasattr(hf_tok, "get_vocab") else {}
    token_id = vocab.get(text)
    return int(token_id) if isinstance(token_id, int) else None


def _generation_config_eos(model_id: str) -> set[int]:
    """Read eos_token_id from generation_config.json (an int or a list)."""
    try:
        if Path(model_id).is_dir():
            root = Path(model_id)
        else:
            from huggingface_hub import snapshot_download

            root = Path(snapshot_download(model_id, local_files_only=True))
        data = json.loads((root / "generation_config.json").read_text())
    except Exception:
        return set()
    eos = data.get("eos_token_id")
    if isinstance(eos, int):
        return {eos}
    if isinstance(eos, list):
        return {int(e) for e in eos if isinstance(e, int)}
    return set()


def _stop_token_ids(tok: Any, hf_tok: Any, model_id: str) -> set[int]:
    ids = {int(i) for i in (getattr(tok, "eos_token_ids", None) or [])}
    eos = getattr(hf_tok, "eos_token_id", None)
    if isinstance(eos, int):
        ids.add(eos)
    ids |= _generation_config_eos(model_id)
    im_end = _single_token_id(hf_tok, "<|im_end|>")
    if im_end is not None:
        ids.add(im_end)
    return ids


class _JsonGrammar:
    """mlx-lm logits processor that forces output to match a JSON Schema.

    Copied from the probe X2 harness. One extra: when ``think`` is set
    (thinking on), the first token may also open a thinking block. The grammar
    then waits until the block closes and starts after it. With thinking off,
    an empty block is already in the prompt (Qwen3.5) or absent (Gemma 4), so
    the grammar starts at the first token.
    """

    def __init__(
        self,
        matcher: Any,
        n_vocab: int,
        *,
        think: tuple[int, int] | None,
        allocate: Any,
        fill: Any,
        apply: Any,
    ) -> None:
        self.m = matcher
        self.think = think
        self.bitmask = allocate(1, n_vocab)
        self._fill = fill
        self._apply = apply
        self.state = "start"  # start | first | thinking | fresh | grammar
        self.thought = False

    def _mask(self, logits: Any, allow_open: bool = False) -> Any:
        self._fill(self.m, self.bitmask, 0)
        if allow_open and self.think is not None:
            open_id = self.think[0]
            words = self.bitmask.view(np.uint32)
            words[0, open_id // 32] |= np.uint32(1 << (open_id % 32))
        return self._apply(logits, self.bitmask)

    def _consume(self, token: int) -> None:
        if not self.m.is_stopped() and not self.m.consume_token(token):
            raise RuntimeError(f"grammar rejected token {token}: {self.m.get_error()}")

    def __call__(self, tokens: Any, logits: Any) -> Any:
        if self.state == "start":
            self.state = "first"
            return self._mask(logits, allow_open=True)
        token = int(tokens[-1].item())
        if self.state == "first":
            if self.think is not None and token == self.think[0]:
                self.state = "thinking"
                self.thought = True
                return logits
            self.state = "grammar"
            self._consume(token)
        elif self.state == "thinking":
            if token == self.think[1]:  # type: ignore[index]
                self.state = "grammar"
            return logits if self.state == "thinking" else self._mask(logits)
        else:
            self._consume(token)
        if self.m.is_stopped():
            return logits
        return self._mask(logits)


def _strip_thinking(text: str) -> str:
    """Drop a leading thinking block (empty or not) from the answer text."""
    stripped = text.lstrip()
    for open_s, close_s in _THINK_PAIRS:
        if stripped.startswith(open_s) and close_s in stripped:
            return stripped.split(close_s, 1)[1].lstrip()
    return text


def _cut_at_stop(text: str, stops: list[str]) -> str | None:
    """Return text before the first stop string, or None when no stop string is in it."""
    hits = [text.find(s) for s in stops if s in text]
    return text[: min(hits)] if hits else None


class _LlmEngine:
    """One loaded mlx-lm model. Collaborators are injected for unit tests."""

    def __init__(
        self,
        model_id: str,
        model: Any,
        tok: Any,
        *,
        stop_ids: set[int],
        n_vocab: int,
        stream_generate: Any,
        make_sampler: Any,
        make_logits_processors: Any,
        grammar_factory: Any,
        reset_peak_memory: Any = None,
    ) -> None:
        self.model_id = model_id
        # Resets the MLX peak memory counter before each request, so
        # usage.peak_memory_bytes is the peak of that request only.
        self._reset_peak_memory = reset_peak_memory
        self.model = model
        self.tok = tok
        self.stop_ids = set(stop_ids)
        self.n_vocab = n_vocab
        self._stream_generate = stream_generate
        self._make_sampler = make_sampler
        self._make_logits_processors = make_logits_processors
        self._grammar_factory = grammar_factory
        # mlx-lm stream_generate stops on tokenizer.eos_token_ids.
        tok.eos_token_ids = set(self.stop_ids)
        hf_tok = getattr(tok, "_tokenizer", tok)
        self.think: tuple[int, int] | None = None
        for open_s, close_s in _THINK_PAIRS:
            open_id = _single_token_id(hf_tok, open_s)
            close_id = _single_token_id(hf_tok, close_s)
            if open_id is not None and close_id is not None:
                self.think = (open_id, close_id)
                break
        self._seq = 0

    def _prompt_ids(self, req: dict[str, Any]) -> list[int]:
        prompt = self.tok.apply_chat_template(
            req["messages"],
            add_generation_prompt=True,
            enable_thinking=req["enable_thinking"],
            tokenize=False,
        )
        return list(self.tok.encode(prompt, add_special_tokens=False))

    def complete(self, req: dict[str, Any]) -> dict[str, Any]:
        started = time.perf_counter()
        if self._reset_peak_memory is not None:
            self._reset_peak_memory()
        ids = self._prompt_ids(req)
        sampler_kwargs: dict[str, Any] = {"temp": req["temperature"] or 0.0}
        for name in ("top_p", "top_k", "min_p"):
            if req[name] is not None:
                sampler_kwargs[name] = req[name]
        procs: list[Any] = []
        if req["repetition_penalty"] is not None:
            procs += self._make_logits_processors(repetition_penalty=req["repetition_penalty"])
        grammar = None
        if req["schema"] is not None:
            # A thinking block may open only when thinking is on. With thinking
            # off, Gemma 4 has no block in the prompt but still opens one when
            # the grammar allows it (about 350 hidden tokens on gemma-4-e2b).
            think = self.think if req["enable_thinking"] else None
            grammar = self._grammar_factory(json.dumps(req["schema"]), think)
            procs.append(grammar)

        text, last, finish, first_at = "", None, None, None
        for response in self._stream_generate(
            self.model,
            self.tok,
            ids,
            max_tokens=req["max_tokens"],
            sampler=self._make_sampler(**sampler_kwargs),
            logits_processors=procs,
        ):
            if first_at is None:
                first_at = time.perf_counter()
            text += response.text
            last = response
            if req["stop"]:
                cut = _cut_at_stop(text, req["stop"])
                if cut is not None:
                    text, finish = cut, "stop"
                    break
        if finish is None:
            finish = "length" if last is not None and last.finish_reason == "length" else "stop"

        completion_tokens = int(getattr(last, "generation_tokens", 0) or 0)
        self._seq += 1
        return {
            "id": f"chatcmpl-{os.getpid()}-{self._seq}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": self.model_id,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": _strip_thinking(text)},
                    "finish_reason": finish,
                }
            ],
            "usage": {
                "prompt_tokens": len(ids),
                "completion_tokens": completion_tokens,
                "total_tokens": len(ids) + completion_tokens,
                **_generation_stats(last, started, first_at, time.perf_counter()),
            },
        }


def _generation_stats(last: Any, started: float, first_at: float | None, ended: float) -> dict[str, Any]:
    """The mlx-lm stats of one request, for usage (specs/llm-runtime-tuning.md).

    ttft_ms runs from the request start (template, grammar, prefill) to the
    first token. prompt_tps, generation_tps and peak_memory come from the last
    mlx-lm GenerationResponse; peak_memory there is in GB (1e9 bytes).
    """
    stats: dict[str, Any] = {"total_ms": round((ended - started) * 1000, 1)}
    if first_at is not None:
        stats["ttft_ms"] = round((first_at - started) * 1000, 1)
    for name in ("prompt_tps", "generation_tps"):
        value = getattr(last, name, None)
        if isinstance(value, (int, float)):
            stats[name] = round(float(value), 2)
    peak = getattr(last, "peak_memory", None)
    if isinstance(peak, (int, float)):
        stats["peak_memory_bytes"] = int(peak * 1e9)
    return stats


def _metal_info() -> dict[str, Any]:
    """The Metal memory facts of this Mac for the ready line, or {} without Metal.

    max_recommended_working_set_size is the GPU ceiling that mlx-lm wires to
    (mlx_lm/utils.py). The server uses it for the model fit label.
    """
    try:
        import mlx.core as mx

        info = mx.device_info()
    except Exception:
        return {}
    out = {}
    for key in ("max_recommended_working_set_size", "memory_size"):
        value = info.get(key)
        if isinstance(value, int):
            out[key] = value
    return {"metal": out} if out else {}


def _vocab_size(model: Any, hf_tok: Any) -> int:
    """The logits width. Read it from one forward pass, because Gemma 4 keeps
    vocab_size in a nested text config and a wrong size breaks the bitmask."""
    try:
        import mlx.core as mx

        return int(model(mx.array([[0]])).shape[-1])
    except Exception:
        args = getattr(model, "args", None)
        size = getattr(args, "vocab_size", None)
        return int(size) if size else len(hf_tok)


def _load_llm_engine(model_id: str) -> _LlmEngine:
    import llguidance.hf
    import mlx.core as mx
    from llguidance import LLMatcher
    from llguidance.mlx import apply_token_bitmask
    from llguidance.numpy import allocate_token_bitmask, fill_next_token_bitmask
    from mlx_lm import load, stream_generate
    from mlx_lm.sample_utils import make_logits_processors, make_sampler

    _log(f"loading llm {model_id} ...")
    model, tok = load(model_id)
    hf_tok = tok._tokenizer
    stop_ids = _stop_token_ids(tok, hf_tok, model_id)
    n_vocab = _vocab_size(model, hf_tok)
    eos = hf_tok.eos_token_id if isinstance(hf_tok.eos_token_id, int) else min(stop_ids)
    ll_tok = llguidance.hf.from_tokenizer(hf_tok, n_vocab=n_vocab, eos_token=eos)
    _log(f"llm ready: n_vocab={n_vocab} stop_ids={sorted(stop_ids)}")

    def grammar_factory(schema_json: str, think: tuple[int, int] | None) -> _JsonGrammar:
        grammar = LLMatcher.grammar_from_json_schema(schema_json, defaults=_JSON_GRAMMAR_OPTIONS)
        matcher = LLMatcher(ll_tok, grammar)
        if matcher.is_error():
            raise _BadRequest(f"invalid json schema: {matcher.get_error()}")
        return _JsonGrammar(
            matcher,
            n_vocab,
            think=think,
            allocate=allocate_token_bitmask,
            fill=fill_next_token_bitmask,
            apply=apply_token_bitmask,
        )

    return _LlmEngine(
        model_id,
        model,
        tok,
        stop_ids=stop_ids,
        n_vocab=n_vocab,
        stream_generate=stream_generate,
        make_sampler=make_sampler,
        make_logits_processors=make_logits_processors,
        grammar_factory=grammar_factory,
        reset_peak_memory=mx.reset_peak_memory,
    )


def _http_handler_base(model_id: str) -> Any:
    """The shared base of the LLM and embed HTTP handlers: JSON replies,
    OpenAI-style errors and ``GET /v1/models``."""
    from http.server import BaseHTTPRequestHandler

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        route = ""

        def log_message(self, fmt: str, *args: Any) -> None:
            _log(f"http {fmt % args}")

        def _json(self, status: int, payload: dict[str, Any]) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            # One connection at a time (HTTPServer is not threaded, so a
            # generation stays serial). Close each connection after its reply:
            # an idle keep-alive socket would hold the server, and Node's fetch
            # opens a new connection that waits about 4 s for that socket to
            # time out. send_header also sets close_connection.
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)

        def _error(self, status: int, message: str, kind: str) -> None:
            self._json(status, {"error": {"message": message, "type": kind}})

        def handle_body(self, body: Any) -> dict[str, Any]:
            raise NotImplementedError

        def do_GET(self) -> None:  # noqa: N802
            if self.path.split("?")[0] == "/v1/models":
                self._json(200, {"object": "list", "data": [{"id": model_id, "object": "model"}]})
            else:
                self._error(404, f"not found: {self.path}", "invalid_request_error")

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length > 0 else b""
            if self.path.split("?")[0] != self.route:
                self._error(404, f"not found: {self.path}", "invalid_request_error")
                return
            try:
                result = self.handle_body(json.loads(raw or b"null"))
            except json.JSONDecodeError as exc:
                self._error(400, f"invalid json: {exc}", "invalid_request_error")
            except _BadRequest as exc:
                self._error(400, str(exc), "invalid_request_error")
            except Exception as exc:
                _log(f"request error: {exc}")
                self._error(500, str(exc), "server_error")
            else:
                self._json(200, result)

    return Handler


def _make_llm_handler(engine: _LlmEngine) -> Any:
    class Handler(_http_handler_base(engine.model_id)):
        route = "/v1/chat/completions"

        def handle_body(self, body: Any) -> dict[str, Any]:
            return engine.complete(_parse_chat_request(body))

    return Handler


# ---------------------------------------------------------------------------
# Embed mode (specs/local-semantic-search.md 5.2)
#
# ``--embed --model <hfId> [--revision <sha>] --port <port>`` loads an
# EmbeddingGemma 2 checkpoint with mlx_vlm.embedding_loader and serves an
# OpenAI-style ``POST /v1/embeddings``. The server adds the document and
# query prompts (spec S10); this mode embeds the text it gets. Keep bf16:
# Gemma gives bad output in float16 (#233 research comment).
# ---------------------------------------------------------------------------

_EMBED_MAX_INPUTS = 32
_EMBED_MAX_TOKENS = 512
_EMBED_NORM_TOLERANCE = 1e-3


def _parse_embed_request(body: Any, dims: int) -> list[str]:
    """Validate a /v1/embeddings body and return the inputs. ``model`` is ignored."""
    if not isinstance(body, dict):
        raise _BadRequest("request body must be a JSON object")
    inputs = body.get("input")
    if isinstance(inputs, str):
        inputs = [inputs]
    if not (isinstance(inputs, list) and inputs and all(isinstance(t, str) for t in inputs)):
        raise _BadRequest("input must be a string or a non-empty list of strings")
    if len(inputs) > _EMBED_MAX_INPUTS:
        raise _BadRequest(f"input has more than {_EMBED_MAX_INPUTS} items")
    encoding = body.get("encoding_format")
    if encoding not in (None, "float"):
        raise _BadRequest('encoding_format must be "float"')
    dimensions = body.get("dimensions")
    if dimensions is not None and (isinstance(dimensions, bool) or dimensions != dims):
        raise _BadRequest(f"dimensions must be {dims}")
    return inputs


class _EmbedEngine:
    """One loaded embedding model. ``tokenizer`` is a Hugging Face tokenizer;
    ``forward(input_ids, attention_mask)`` returns float32 vectors (n, dims).
    Both are injected for unit tests."""

    def __init__(self, model_id: str, tokenizer: Any, forward: Any) -> None:
        self.model_id = model_id
        self.tok = tokenizer
        self._forward = forward
        self.dims = int(self._vectors(["dims probe"]).shape[1])

    def _vectors(self, texts: list[str]) -> np.ndarray:
        enc = self.tok(
            texts,
            padding=True,
            truncation=True,
            max_length=_EMBED_MAX_TOKENS,
            return_tensors="np",
        )
        return np.asarray(self._forward(enc["input_ids"], enc["attention_mask"]), dtype=np.float32)

    def embed(self, texts: list[str]) -> dict[str, Any]:
        tokens = [len(ids) for ids in self.tok(texts)["input_ids"]]
        vectors = self._vectors(texts)
        if vectors.shape != (len(texts), self.dims):
            raise RuntimeError(f"embedding output has shape {vectors.shape}")
        if not np.isfinite(vectors).all():
            raise RuntimeError("embedding output is not finite")
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        if np.any(np.abs(norms - 1.0) > _EMBED_NORM_TOLERANCE):
            vectors = vectors / np.maximum(norms, 1e-9)
        used = sum(min(t, _EMBED_MAX_TOKENS) for t in tokens)
        return {
            "object": "list",
            "model": self.model_id,
            "data": [
                {"object": "embedding", "index": i, "embedding": [float(x) for x in row]}
                for i, row in enumerate(vectors)
            ],
            "usage": {"prompt_tokens": used, "total_tokens": used},
            "openstyle": {
                "tokens": tokens,
                "truncated": [t > _EMBED_MAX_TOKENS for t in tokens],
            },
        }


def _resolve_model_dir(model_id: str, revision: str | None) -> Path:
    """The local snapshot folder of ``model_id`` at ``revision`` (else refs/main).

    The server downloads only the files the model needs, so this reads the
    cache layout directly. ``snapshot_download(local_files_only=True)`` would
    refuse the snapshot because the README and license files are absent.
    """
    if Path(model_id).is_dir():
        return Path(model_id)
    from huggingface_hub.constants import HF_HUB_CACHE

    repo = Path(HF_HUB_CACHE) / ("models--" + model_id.replace("/", "--"))
    if revision is None:
        ref = repo / "refs" / "main"
        if not ref.is_file():
            raise FileNotFoundError(f"{model_id} is not downloaded")
        revision = ref.read_text().strip()
    path = repo / "snapshots" / revision
    if not (path / "config.json").is_file():
        raise FileNotFoundError(f"{model_id} at {revision} is not downloaded")
    return path


def _load_embed_engine(model_id: str, revision: str | None = None) -> _EmbedEngine:
    import gc

    import mlx.core as mx
    from mlx_vlm.embedding_loader import load_embedding_model
    from transformers import AutoTokenizer

    _log(f"loading embedding model {model_id}@{revision or 'main'} ...")
    path = _resolve_model_dir(model_id, revision)
    model = load_embedding_model(path)
    # Text only: drop the image and audio towers (a no-op for a text-only repo).
    for attr in ("vision_tower", "embed_vision", "audio_tower", "embed_audio"):
        if getattr(model, attr, None) is not None:
            setattr(model, attr, None)
    gc.collect()
    mx.clear_cache()
    tok = AutoTokenizer.from_pretrained(str(path))
    tok.padding_side = "right"

    def forward(input_ids: Any, attention_mask: Any) -> np.ndarray:
        out = model(input_ids=mx.array(input_ids), attention_mask=mx.array(attention_mask))
        vectors = out.text_embeds.astype(mx.float32)
        mx.eval(vectors)
        return np.array(vectors)

    engine = _EmbedEngine(model_id, tok, forward)
    _log(f"embedding model ready: dims={engine.dims}")
    return engine


def _make_embed_handler(engine: _EmbedEngine) -> Any:
    class Handler(_http_handler_base(engine.model_id)):
        route = "/v1/embeddings"

        def handle_body(self, body: Any) -> dict[str, Any]:
            return engine.embed(_parse_embed_request(body, engine.dims))

    return Handler


def _watch_stdin() -> None:
    """Exit when stdin closes: the parent process died."""
    for _ in sys.stdin:
        pass
    _log("stdin closed; shutting down")
    os._exit(0)


def _serve_http(mode: str, port: int | None, load: Any, make_handler: Any, ready: Any) -> None:
    """Load the engine, bind 127.0.0.1:<port>, print one ready line, serve.
    Errors before ready print one error line and exit 1."""
    import signal
    from http.server import HTTPServer

    if port is None:
        _send({"type": "error", "error": f"--{mode} needs --port"})
        sys.exit(1)
    try:
        engine = load()
        httpd = HTTPServer(("127.0.0.1", port), make_handler(engine))
    except Exception as exc:
        _log(f"{mode} start error: {exc}")
        _send({"type": "error", "error": str(exc)})
        sys.exit(1)

    def _on_term(*_args: Any) -> None:
        _log("SIGTERM; shutting down")
        os._exit(0)

    signal.signal(signal.SIGTERM, _on_term)
    threading.Thread(target=_watch_stdin, daemon=True).start()
    _send({"type": "ready", "port": httpd.server_address[1], **ready(engine)})
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()


def _run_llm(model_id: str, port: int | None) -> None:
    _serve_http(
        "llm",
        port,
        lambda: _load_llm_engine(model_id),
        _make_llm_handler,
        lambda _engine: {"model": model_id, **_metal_info()},
    )


def _run_embed(model_id: str, revision: str | None, port: int | None) -> None:
    _serve_http(
        "embed",
        port,
        lambda: _load_embed_engine(model_id, revision),
        _make_embed_handler,
        lambda engine: {"model": model_id, "dims": engine.dims},
    )


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
    parser.add_argument(
        "--llm",
        action="store_true",
        help="serve an mlx-lm model over an OpenAI-style HTTP API on 127.0.0.1:--port",
    )
    parser.add_argument(
        "--embed",
        action="store_true",
        help="serve an embedding model over an OpenAI-style /v1/embeddings on 127.0.0.1:--port",
    )
    parser.add_argument("--revision", default=None, help="Hugging Face commit of --model (embed mode)")
    args = parser.parse_args()

    if args.llm:
        _run_llm(args.model, args.port)
        return

    if args.embed:
        _run_embed(args.model, args.revision, args.port)
        return

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
