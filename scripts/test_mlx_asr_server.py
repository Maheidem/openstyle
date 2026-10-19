#!/usr/bin/env python3
"""Unit tests for mlx_asr_server helpers (no Metal / model weights required)."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest import mock

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

spec = importlib.util.spec_from_file_location(
    "mlx_asr_server",
    ROOT / "scripts" / "mlx_asr_server.py",
)
mlx_asr_server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mlx_asr_server)


class TranscribeKwargsTests(unittest.TestCase):
    def test_named_params_only(self) -> None:
        def generate(
            audio: str,
            *,
            language: str | None = None,
            system_prompt: str | None = None,
            **kwargs: object,
        ) -> object:
            return None

        out = mlx_asr_server._transcribe_kwargs(
            generate,
            language="en",
            context="Acme Corp",
        )
        self.assertEqual(
            out,
            {"language": "en", "system_prompt": "Acme Corp"},
        )

    def test_ignores_prompt_when_not_in_signature(self) -> None:
        def generate(audio: str, *, dtype: object = None, **kwargs: object) -> object:
            return None

        out = mlx_asr_server._transcribe_kwargs(
            generate,
            language="en",
            context="Acme Corp",
        )
        self.assertEqual(out, {})

    def test_whisper_initial_prompt(self) -> None:
        def generate(
            audio: str,
            *,
            language: str | None = None,
            initial_prompt: str | None = None,
        ) -> object:
            return None

        out = mlx_asr_server._transcribe_kwargs(
            generate,
            language="en",
            context="Acme Corp",
        )
        self.assertEqual(
            out,
            {"language": "en", "initial_prompt": "Acme Corp"},
        )

    def test_prefers_system_prompt_over_prompt(self) -> None:
        def generate(
            audio: str,
            *,
            system_prompt: str | None = None,
            prompt: str | None = None,
        ) -> object:
            return None

        out = mlx_asr_server._transcribe_kwargs(
            generate,
            language=None,
            context="only one",
        )
        self.assertEqual(out, {"system_prompt": "only one"})

    def test_empty_context_omitted(self) -> None:
        def generate(audio: str, *, system_prompt: str | None = None) -> object:
            return None

        self.assertEqual(
            mlx_asr_server._transcribe_kwargs(generate, language=None, context="  "),
            {},
        )


class PcmToWavTests(unittest.TestCase):
    def test_writes_16k_mono_wav(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pcm_path = Path(tmp) / "chunk.pcm"
            pcm_path.write_bytes(b"\x00\x00" * 1600)
            wav_path = mlx_asr_server._pcm_path_to_wav_path(pcm_path, 16000)
            self.assertTrue(Path(wav_path).is_file())
            with wave.open(wav_path, "rb") as wf:
                self.assertEqual(wf.getnchannels(), 1)
                self.assertEqual(wf.getsampwidth(), 2)
                self.assertEqual(wf.getframerate(), 16000)
                self.assertEqual(wf.getnframes(), 1600)


class TextFromResultTests(unittest.TestCase):
    def test_extracts_text_from_dict_result(self) -> None:
        self.assertEqual(
            mlx_asr_server._text_from_result({"text": "hello"}),
            "hello",
        )

    def test_extracts_text_from_list_result(self) -> None:
        self.assertEqual(
            mlx_asr_server._text_from_result([{"text": "hello"}]),
            "hello",
        )


class FakeTokenizer:
    """Maps token id N to the word wN; special ids (>= 1000) are dropped."""

    def decode(self, ids: list[int], skip_special_tokens: bool = False) -> str:
        words = [f"w{i}" for i in ids if not (skip_special_tokens and i >= 1000)]
        return " ".join(words)


class FakeQwenModel:
    """Fake with the Qwen3-ASR stream contract (no Metal, no weights)."""

    sample_rate = 16000

    def __init__(self, streams: list[list[int]]) -> None:
        self._tokenizer = FakeTokenizer()
        self._streams = streams
        self.calls: list[dict[str, object]] = []

    def _tokens_for(self, kwargs: dict[str, object]) -> list[int]:
        index = min(len(self.calls), len(self._streams) - 1)
        self.calls.append(kwargs)
        tokens = self._streams[index]
        cap = int(kwargs.get("max_tokens", 8192))  # type: ignore[arg-type]
        return tokens[:cap]

    def stream_generate(
        self,
        audio: object,
        *,
        max_tokens: int = 8192,
        sampler: object = None,
        logits_processors: object = None,
        language: str | None = None,
        prefill_step_size: int = 2048,
        verbose: bool = False,
        system_prompt: str | None = None,
    ):
        kwargs = {"max_tokens": max_tokens, "language": language, "system_prompt": system_prompt}
        self.audio_len = len(audio)  # type: ignore[arg-type]
        for token in self._tokens_for(kwargs):
            yield token, None

    def extract_language(self, text: str) -> tuple[str, str]:
        if "<asr_text>" in text and text.startswith("language "):
            return (
                text[len("language ") : text.find("<asr_text>")].strip(),
                text[text.find("<asr_text>") + len("<asr_text>") :],
            )
        return "English", text

    def generate(
        self,
        audio: object,
        *,
        max_tokens: int = 8192,
        language: str | None = None,
        system_prompt: str | None = None,
    ) -> dict[str, str]:
        # Same text as Qwen3-ASR generate() for one chunk: decode all tokens.
        tokens = self._tokens_for(
            {"max_tokens": max_tokens, "language": language, "system_prompt": system_prompt}
        )
        return {"text": self._tokenizer.decode(tokens, skip_special_tokens=True)}


class FakeGenerateOnlyModel:
    def __init__(self, text: str) -> None:
        self.text = text
        self.kwargs: dict[str, object] = {}

    def generate(self, audio: str, *, max_tokens: int = 8192, language: str | None = None) -> dict[str, str]:
        self.kwargs = {"max_tokens": max_tokens, "language": language}
        return {"text": self.text}


def _write_wav(path: Path, seconds: float, rate: int = 16000) -> str:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(b"\x00\x00" * int(seconds * rate))
    return str(path)


class LoopGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = dict(mlx_asr_server._state)
        self.logs: list[str] = []
        self._log_patch = mock.patch.object(mlx_asr_server, "_log", self.logs.append)
        self._log_patch.start()

    def tearDown(self) -> None:
        self._log_patch.stop()
        mlx_asr_server._state.clear()
        mlx_asr_server._state.update(self._saved)

    def _run(self, model: object, seconds: float, **kw: object) -> str:
        mlx_asr_server._state["model"] = model
        wav = np.zeros(int(seconds * 16000), dtype=np.float32)
        with mock.patch.object(mlx_asr_server, "_load_waveform", return_value=wav):
            return mlx_asr_server._transcribe("unused.wav", **kw)  # type: ignore[arg-type]

    def test_cap_formula(self) -> None:
        self.assertEqual(mlx_asr_server._max_tokens_for(26.2), 294)
        self.assertEqual(mlx_asr_server._max_tokens_for(30.0), 332)
        self.assertEqual(mlx_asr_server._max_tokens_for(0.0), 32)
        self.assertEqual(mlx_asr_server._max_tokens_for(0.01), 33)

    def test_audio_seconds_from_wav(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_wav(Path(tmp) / "a.wav", 2.5)
            self.assertAlmostEqual(mlx_asr_server._audio_seconds(path), 2.5)
            bad = Path(tmp) / "b.wav"
            bad.write_bytes(b"not a wav")
            self.assertIsNone(mlx_asr_server._audio_seconds(str(bad)))

    def test_is_loop_rule(self) -> None:
        normal = list(range(100))
        self.assertFalse(mlx_asr_server._is_loop(normal))
        loop = list(range(24)) + [7, 8, 9] * 8
        self.assertEqual(len(loop), 48)
        self.assertTrue(mlx_asr_server._is_loop(loop))
        self.assertFalse(mlx_asr_server._is_loop([5] * 47))
        self.assertFalse(mlx_asr_server._is_loop(list(range(24)) + [1, 2, 3, 4] * 6))

    def test_phrase_loop_triggers(self) -> None:
        # A 5-word phrase of 7 token ids: rule a does not find it.
        phrase = [11, 12, 13, 14, 15, 16, 17]
        tokens = list(range(100, 130)) + phrase * 7
        self.assertGreater(len(set(tokens[-24:])), 3)
        self.assertTrue(mlx_asr_server._is_loop(tokens))
        # One phrase copy less than the window (max(48, 4 * 7) = 48) is not a loop.
        self.assertFalse(mlx_asr_server._is_loop(list(range(100, 160)) + phrase * 6))

    def test_long_period_needs_four_periods(self) -> None:
        phrase = list(range(200, 240))  # period 40
        self.assertFalse(mlx_asr_server._is_loop(list(range(10)) + phrase * 3))
        self.assertTrue(mlx_asr_server._is_loop(list(range(10)) + phrase * 4))

    def test_varied_speech_not_loop(self) -> None:
        import random

        rng = random.Random(7)
        vocab = list(range(1, 400))
        speech = [rng.choice(vocab) for _ in range(400)]
        for end in range(48, len(speech) + 1):
            self.assertFalse(mlx_asr_server._is_loop(speech[:end]))

    def test_short_real_repeats_not_loop(self) -> None:
        no = [5, 6]  # "no," = 2 tokens
        tokens = [1, 2, 3] + no * 10 + [7, 8, 9]
        self.assertLess(len(tokens), 48)
        self.assertFalse(mlx_asr_server._is_loop(tokens))
        # The same repeat inside longer varied speech is not a loop either.
        tokens = list(range(100, 140)) + no * 10 + list(range(140, 170))
        for end in range(48, len(tokens) + 1):
            self.assertFalse(mlx_asr_server._is_loop(tokens[:end]))

    def test_phrase_loop_breaks_stream_and_retries(self) -> None:
        phrase = [11, 12, 13, 14, 15, 16, 17]
        model = FakeQwenModel([list(range(100, 130)) + phrase * 600, [1, 2, 3]])
        out = self._run(model, 26.2, language="English", context="Acme")
        self.assertEqual(out, "w1 w2 w3")
        self.assertEqual(self.logs, ["loop detected; retry without context: ok"])

    def test_stream_path_same_text_as_generate(self) -> None:
        stream = [1, 2, 3, 1001, 4, 5, 2, 3, 6]
        gen_model = FakeQwenModel([stream])
        expected = gen_model.generate("x", language="English", system_prompt="Acme")["text"]

        model = FakeQwenModel([stream])
        out = self._run(model, 5.0, language="English", context="Acme")
        self.assertEqual(out, expected)
        self.assertEqual(
            model.calls,
            [{"max_tokens": 82, "language": "English", "system_prompt": "Acme"}],
        )
        self.assertEqual(self.logs, [])

    def test_stream_path_extracts_language_when_auto(self) -> None:
        class LangTokenizer(FakeTokenizer):
            def decode(self, ids: list[int], skip_special_tokens: bool = False) -> str:
                return "language English<asr_text>" + super().decode(ids, skip_special_tokens)

        model = FakeQwenModel([[1, 2]])
        model._tokenizer = LangTokenizer()
        self.assertEqual(self._run(model, 2.0, language=None, context=None), "w1 w2")

    def test_stream_path_pads_short_audio(self) -> None:
        model = FakeQwenModel([[1]])
        self._run(model, 0.25, language="English", context=None)
        self.assertEqual(model.audio_len, 16000)

    def test_loop_breaks_and_retry_drops_prompt(self) -> None:
        loop = [9] * 5000
        model = FakeQwenModel([loop, [1, 2, 3]])
        out = self._run(model, 26.2, language="English", context="Acme vocabulary")
        self.assertEqual(out, "w1 w2 w3")
        self.assertEqual(len(model.calls), 2)
        self.assertEqual(model.calls[0]["system_prompt"], "Acme vocabulary")
        self.assertIsNone(model.calls[1]["system_prompt"])
        self.assertEqual(model.calls[1]["max_tokens"], 294)
        self.assertEqual(self.logs, ["loop detected; retry without context: ok"])

    def test_retry_loops_again_returns_collapsed_text(self) -> None:
        model = FakeQwenModel([[9] * 5000])
        out = self._run(model, 26.2, language="English", context="Acme")
        # 48 tokens "w9 w9 ... w9": Qwen's fix keeps one "w9 " plus the tail "w9".
        self.assertEqual(out, "w9 w9")
        self.assertEqual(len(model.calls), 2)
        self.assertEqual(self.logs, ["loop detected; retry without context: looped"])

    def test_loop_without_context_skips_retry(self) -> None:
        model = FakeQwenModel([[9] * 5000])
        out = self._run(model, 26.2, language="English", context=None)
        self.assertEqual(out, "w9 w9")
        self.assertEqual(len(model.calls), 1)
        self.assertEqual(self.logs, ["loop detected; retry without context: skipped (no context)"])

    def test_generate_only_model_gets_cap(self) -> None:
        model = FakeGenerateOnlyModel("hello world")
        mlx_asr_server._state["model"] = model
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_wav(Path(tmp) / "a.wav", 3.0)
            out = mlx_asr_server._transcribe(path, language="en", context=None)
        self.assertEqual(out, "hello world")
        self.assertEqual(model.kwargs, {"max_tokens": 62, "language": "en"})

    def test_generate_only_model_output_is_fixed(self) -> None:
        model = FakeGenerateOnlyModel("ok " + "yes " * 30)
        mlx_asr_server._state["model"] = model
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_wav(Path(tmp) / "a.wav", 3.0)
            self.assertEqual(mlx_asr_server._transcribe(path, language=None, context=None), "ok yes")


class DetectAndFixRepetitionsTests(unittest.TestCase):
    fix = staticmethod(mlx_asr_server.detect_and_fix_repetitions)

    def test_normal_text_unchanged(self) -> None:
        text = "The quick brown fox jumps over the lazy dog. Yes, yes, yes."
        self.assertEqual(self.fix(text), text)

    def test_char_run_over_threshold_collapses(self) -> None:
        self.assertEqual(self.fix("a" * 21 + "b"), "ab")
        self.assertEqual(self.fix("a" * 20 + "b"), "a" * 20 + "b")

    def test_word_pattern_collapses(self) -> None:
        self.assertEqual(self.fix("Okay. " * 4094), "Okay. ")
        self.assertEqual(self.fix("hi " + "so " * 20 + "end"), "hi so end")

    def test_pattern_below_threshold_kept(self) -> None:
        text = "so " * 19 + "end"
        self.assertEqual(self.fix(text), text)

    def test_pattern_longer_than_20_chars_kept(self) -> None:
        text = "twenty one chars here" * 25
        self.assertEqual(len("twenty one chars here"), 21)
        self.assertEqual(self.fix(text), text)

    def test_two_loops_in_one_text(self) -> None:
        self.assertEqual(self.fix("ab" * 25 + "X" + "cd" * 25), "abXcd")


if __name__ == "__main__":
    unittest.main()
