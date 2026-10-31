#!/usr/bin/env python3
"""Unit tests for mlx_asr_server helpers (no Metal / model weights required)."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
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


# --- LLM mode (specs/local-mlx-llm.md section 2) ---------------------------


class FakeHfTokenizer:
    eos_token_id = 7

    def get_vocab(self) -> dict[str, int]:
        return {"<|im_end|>": 7, "<think>": 8, "</think>": 9, "hello": 10}


class FakeLlmTokenizer:
    def __init__(self) -> None:
        self._tokenizer = FakeHfTokenizer()
        self.eos_token_ids = {7}
        self.template_kwargs: dict[str, object] = {}

    def apply_chat_template(self, messages: list[dict[str, str]], **kwargs: object) -> str:
        self.template_kwargs = {"messages": messages, **kwargs}
        return "PROMPT"

    def encode(self, text: str, add_special_tokens: bool = True) -> list[int]:
        return [1, 2, 3]


class FakeResponse:
    def __init__(self, text: str, finish_reason: str | None, generation_tokens: int) -> None:
        self.text = text
        self.finish_reason = finish_reason
        self.generation_tokens = generation_tokens


def _engine(chunks: list[tuple[str, str | None]], **kw: object):
    calls: dict[str, object] = {"grammar": []}

    def stream_generate(model, tok, ids, **kwargs):
        calls["stream"] = {"ids": ids, **kwargs}
        for i, (text, finish) in enumerate(chunks):
            yield FakeResponse(text, finish, i + 1)

    def make_sampler(**kwargs):
        calls["sampler"] = kwargs
        return "SAMPLER"

    def make_logits_processors(**kwargs):
        calls["rep"] = kwargs
        return ["REP"]

    def grammar_factory(schema_json: str, think: object) -> str:
        calls["grammar"].append((schema_json, think))  # type: ignore[union-attr]
        return "GRAMMAR"

    tok = FakeLlmTokenizer()
    engine = mlx_asr_server._LlmEngine(
        "mlx-community/Fake-LLM",
        object(),
        tok,
        stop_ids=kw.get("stop_ids", {7, 106}),  # type: ignore[arg-type]
        n_vocab=64,
        stream_generate=stream_generate,
        make_sampler=make_sampler,
        make_logits_processors=make_logits_processors,
        grammar_factory=grammar_factory,
        context_tokens=kw.get("context_tokens"),  # type: ignore[arg-type]
    )
    return engine, tok, calls


SCHEMA = {
    "type": "object",
    "properties": {"corrections": {"type": "array"}},
    "required": ["corrections"],
}


class ParseChatRequestTests(unittest.TestCase):
    parse = staticmethod(mlx_asr_server._parse_chat_request)

    def test_defaults_and_unknown_fields_ignored(self) -> None:
        req = self.parse({"model": "x", "messages": [{"role": "user", "content": "hi"}], "foo": 1})
        self.assertEqual(req["messages"], [{"role": "user", "content": "hi"}])
        self.assertEqual(req["max_tokens"], mlx_asr_server._LLM_DEFAULT_MAX_TOKENS)
        self.assertFalse(req["enable_thinking"])
        self.assertIsNone(req["schema"])
        self.assertEqual(req["stop"], [])

    def test_all_fields(self) -> None:
        req = self.parse(
            {
                "messages": [{"role": "user", "content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]}],
                "max_tokens": 50,
                "temperature": 0.2,
                "top_p": 0.9,
                "top_k": 20,
                "min_p": 0.05,
                "repetition_penalty": 1.1,
                "presence_penalty": 1.5,
                "stop": "END",
                "response_format": {"type": "json_schema", "json_schema": {"name": "x", "schema": SCHEMA, "strict": True}},
                "chat_template_kwargs": {"enable_thinking": True},
                "stream": False,
            }
        )
        self.assertEqual(req["messages"][0]["content"], "ab")
        self.assertEqual((req["max_tokens"], req["top_k"], req["stop"]), (50, 20, ["END"]))
        self.assertEqual(req["presence_penalty"], 1.5)
        self.assertEqual(req["schema"], SCHEMA)
        self.assertTrue(req["enable_thinking"])

    def test_json_object_gives_object_schema(self) -> None:
        req = self.parse({"messages": [{"role": "user", "content": "x"}], "response_format": {"type": "json_object"}})
        self.assertEqual(req["schema"], {"type": "object"})

    def test_bad_requests(self) -> None:
        msgs = [{"role": "user", "content": "x"}]
        for body in (
            {"messages": msgs, "stream": True},
            {"messages": []},
            {"messages": msgs, "max_tokens": 0},
            {"messages": msgs, "temperature": "hot"},
            {"messages": msgs, "response_format": {"type": "json_schema", "json_schema": {}}},
            {"messages": [{"role": "user", "content": [{"type": "image_url"}]}]},
            [],
        ):
            with self.assertRaises(mlx_asr_server._BadRequest, msg=str(body)):
                self.parse(body)


# --- T1: native tool calling (flag OPENSTYLE_MLX_LLM_NATIVE_TOOLS) ---------

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_chunks",
            "description": "Search meeting text.",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}}},
        },
    }
]
GEMMA_CALL = '<|tool_call>call:search_chunks{query:<|"|>budget review<|"|>}<tool_call|>'


def _fake_gemma_parser(text: str, _tools: object) -> dict[str, object]:
    # Same format as mlx_lm.tool_parsers.gemma4: call:name{key:<|"|>value<|"|>}
    import re

    m = re.fullmatch(r'call:([\w-]+)\{(\w+):<\|"\|>(.*)<\|"\|>\}', text)
    if not m:
        raise ValueError("No function provided.")
    return {"name": m.group(1), "arguments": {m.group(2): m.group(3)}}


class NativeToolsTests(unittest.TestCase):
    ENV = {mlx_asr_server._NATIVE_TOOLS_ENV: "1"}

    def _body(self, **extra: object) -> dict[str, object]:
        return {"messages": [{"role": "user", "content": "find the budget"}], "tools": TOOLS, **extra}

    def _tool_engine(self, chunks: list[tuple[str, str | None]]):
        engine, tok, calls = _engine(chunks)
        tok.tool_call_start, tok.tool_call_end = "<|tool_call>", "<tool_call|>"
        tok.tool_parser = _fake_gemma_parser
        return engine, tok, calls

    def test_flag_off_ignores_tools(self) -> None:
        with mock.patch.dict(os.environ, clear=False):
            os.environ.pop(mlx_asr_server._NATIVE_TOOLS_ENV, None)
            req = mlx_asr_server._parse_chat_request(
                self._body(tool_choice="bogus", response_format={"type": "json_object"})
            )
            self.assertNotIn("tools", req)
            self.assertEqual(req["messages"], [{"role": "user", "content": "find the budget"}])
            engine, tok, _ = self._tool_engine([(GEMMA_CALL, "stop")])
            out = engine.complete(req)
        self.assertNotIn("tools", tok.template_kwargs)
        choice = out["choices"][0]
        self.assertNotIn("tool_calls", choice["message"])
        self.assertEqual(choice["finish_reason"], "stop")

    def test_flag_on_parses_gemma_call(self) -> None:
        with mock.patch.dict(os.environ, self.ENV):
            req = mlx_asr_server._parse_chat_request(self._body(tool_choice="auto"))
            engine, tok, _ = self._tool_engine([("<|tool_call>call:search_", None), ('chunks{query:<|"|>budget review<|"|>}<tool_call|>', "stop")])
            out = engine.complete(req)
        self.assertEqual(tok.template_kwargs["tools"], TOOLS)
        self.assertIs(tok.template_kwargs["enable_thinking"], False)
        choice = out["choices"][0]
        self.assertEqual(choice["finish_reason"], "tool_calls")
        (call,) = choice["message"]["tool_calls"]
        self.assertEqual((call["type"], call["function"]["name"]), ("function", "search_chunks"))
        self.assertEqual(json.loads(call["function"]["arguments"]), {"query": "budget review"})
        self.assertTrue(call["id"])
        self.assertEqual(choice["message"]["content"], "")

    def test_text_answer_keeps_stop_and_cut_call_is_dropped(self) -> None:
        with mock.patch.dict(os.environ, self.ENV):
            req = mlx_asr_server._parse_chat_request(self._body())
            engine, _, _ = self._tool_engine([("Plain answer.", "stop")])
            choice = engine.complete(req)["choices"][0]
            self.assertEqual((choice["message"]["content"], choice["finish_reason"]), ("Plain answer.", "stop"))
            self.assertNotIn("tool_calls", choice["message"])
            engine, _, _ = self._tool_engine([("<|tool_call>call:search_chunks{query:<|", "length")])
            choice = engine.complete(req)["choices"][0]
            self.assertNotIn("tool_calls", choice["message"])
            self.assertEqual(choice["finish_reason"], "length")

    def test_tool_choice_none_sends_no_tools(self) -> None:
        with mock.patch.dict(os.environ, self.ENV):
            req = mlx_asr_server._parse_chat_request(self._body(tool_choice="none"))
            engine, tok, _ = self._tool_engine([(GEMMA_CALL, "stop")])
            out = engine.complete(req)
        self.assertNotIn("tools", tok.template_kwargs)
        self.assertEqual(out["choices"][0]["finish_reason"], "stop")

    def test_history_with_tool_calls_and_tool_role(self) -> None:
        messages = [
            {"role": "user", "content": "find it"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "search_chunks", "arguments": '{"query": "x"}'}}
                ],
            },
            {"role": "tool", "tool_call_id": "c1", "content": "chunk text"},
        ]
        with mock.patch.dict(os.environ, self.ENV):
            req = mlx_asr_server._parse_chat_request({"messages": messages, "tools": TOOLS})
        self.assertEqual(req["messages"][1]["tool_calls"][0]["function"]["arguments"], {"query": "x"})
        self.assertEqual(req["messages"][2], {"role": "tool", "content": "chunk text", "tool_call_id": "c1"})

    def test_bad_requests_with_flag_on(self) -> None:
        with mock.patch.dict(os.environ, self.ENV):
            for body in (
                self._body(response_format={"type": "json_object"}),
                self._body(tool_choice="sometimes"),
                self._body(tools=[{"type": "function"}]),
                self._body(tools="search"),
                {
                    "messages": [{"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "a", "arguments": "{"}}]}],
                },
            ):
                with self.assertRaises(mlx_asr_server._BadRequest, msg=str(body)):
                    mlx_asr_server._parse_chat_request(body)

    def test_model_without_tool_parser_is_a_bad_request(self) -> None:
        with mock.patch.dict(os.environ, self.ENV):
            req = mlx_asr_server._parse_chat_request(self._body())
            engine, _, _ = _engine([("x", "stop")])
            with self.assertRaises(mlx_asr_server._BadRequest):
                engine.complete(req)


class StopIdsTests(unittest.TestCase):
    def test_tokenizer_eos_generation_config_and_im_end(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "generation_config.json").write_text('{"eos_token_id": [1, 106, 50]}')
            tok = FakeLlmTokenizer()
            tok.eos_token_ids = {2}
            ids = mlx_asr_server._stop_token_ids(tok, tok._tokenizer, tmp)
        self.assertEqual(ids, {1, 2, 7, 50, 106})

    def test_int_eos_and_missing_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(mlx_asr_server._generation_config_eos(tmp), set())
            Path(tmp, "generation_config.json").write_text('{"eos_token_id": 106}')
            self.assertEqual(mlx_asr_server._generation_config_eos(tmp), {106})

    def test_engine_sets_tokenizer_stop_ids(self) -> None:
        engine, tok, _ = _engine([("x", "stop")], stop_ids={7, 106})
        self.assertEqual(tok.eos_token_ids, {7, 106})
        self.assertEqual(engine.think, (8, 9))


class LlmEngineTests(unittest.TestCase):
    def _req(self, **body: object) -> dict[str, object]:
        return mlx_asr_server._parse_chat_request({"messages": [{"role": "user", "content": "hi"}], **body})

    def test_usage_has_mlx_generation_stats(self) -> None:
        engine, _, _ = _engine([])
        resets: list[int] = []
        engine._reset_peak_memory = lambda: resets.append(1)

        def stream_generate(model, tok, ids, **kwargs):
            r = FakeResponse("{}", "stop", 4)
            r.prompt_tps, r.generation_tps, r.peak_memory = 1234.567, 88.123, 4.5
            yield r

        engine._stream_generate = stream_generate
        usage = engine.complete(self._req())["usage"]
        self.assertEqual(resets, [1])
        self.assertEqual(usage["prompt_tps"], 1234.57)
        self.assertEqual(usage["generation_tps"], 88.12)
        self.assertEqual(usage["peak_memory_bytes"], 4_500_000_000)
        self.assertEqual(usage["completion_tokens"], 4)
        self.assertLessEqual(usage["ttft_ms"], usage["total_ms"])

    def test_usage_without_tokens_has_no_ttft(self) -> None:
        engine, _, _ = _engine([])
        usage = engine.complete(self._req())["usage"]
        self.assertNotIn("ttft_ms", usage)
        self.assertNotIn("prompt_tps", usage)
        self.assertIn("total_ms", usage)

    def test_response_shape_and_template(self) -> None:
        engine, tok, calls = _engine([("Hel", None), ("lo", "stop")])
        out = engine.complete(self._req(max_tokens=9))
        self.assertEqual(tok.template_kwargs["enable_thinking"], False)
        self.assertEqual(tok.template_kwargs["add_generation_prompt"], True)
        self.assertEqual(out["model"], "mlx-community/Fake-LLM")
        self.assertEqual(out["object"], "chat.completion")
        self.assertTrue(str(out["id"]).startswith("chatcmpl-"))
        self.assertEqual(out["choices"][0]["message"], {"role": "assistant", "content": "Hello"})
        self.assertEqual(out["choices"][0]["finish_reason"], "stop")
        usage = dict(out["usage"])
        self.assertGreaterEqual(usage.pop("total_ms"), 0)
        self.assertGreaterEqual(usage.pop("ttft_ms"), 0)
        self.assertEqual(
            usage,
            {
                "prompt_tokens": 3,
                "completion_tokens": 2,
                "total_tokens": 5,
                "cached_tokens": 0,
                "prompt_tokens_details": {"cached_tokens": 0},
            },
        )
        self.assertNotIn("prompt_cache", calls["stream"])
        self.assertEqual(calls["stream"]["max_tokens"], 9)
        self.assertEqual(calls["stream"]["logits_processors"], [])
        self.assertEqual(calls["sampler"], {"temp": 0.0})
        self.assertEqual(calls["grammar"], [])

    def test_length_finish(self) -> None:
        engine, _, _ = _engine([("a", None), ("b", "length")])
        self.assertEqual(engine.complete(self._req())["choices"][0]["finish_reason"], "length")

    def test_grammar_wired_with_schema_and_think_pair(self) -> None:
        engine, _, calls = _engine([('{"corrections": []}', "stop")])
        out = engine.complete(
            self._req(
                repetition_penalty=1.1,
                top_p=0.8,
                response_format={"type": "json_schema", "json_schema": {"schema": SCHEMA}},
            )
        )
        self.assertEqual(calls["grammar"], [(json.dumps(SCHEMA), None)])
        self.assertEqual(calls["stream"]["logits_processors"], ["REP", "GRAMMAR"])
        self.assertEqual(calls["rep"], {"repetition_penalty": 1.1})
        self.assertEqual(calls["sampler"], {"temp": 0.0, "top_p": 0.8})
        self.assertEqual(json.loads(out["choices"][0]["message"]["content"]), {"corrections": []})

    def test_presence_penalty_reaches_the_logits_processors(self) -> None:
        engine, _, calls = _engine([("{}", "stop")])
        engine.complete(self._req(presence_penalty=1.5))
        self.assertEqual(calls["stream"]["logits_processors"], ["REP"])
        self.assertEqual(
            calls["rep"],
            {"presence_penalty": 1.5, "presence_context_size": mlx_asr_server._PRESENCE_CONTEXT_TOKENS},
        )
        engine, _, calls = _engine([("{}", "stop")])
        engine.complete(self._req(repetition_penalty=1.1, presence_penalty=0.5))
        self.assertEqual(calls["rep"]["repetition_penalty"], 1.1)
        self.assertEqual(calls["rep"]["presence_penalty"], 0.5)
        engine, _, calls = _engine([("{}", "stop")])
        engine.complete(self._req())
        self.assertNotIn("rep", calls)

    def test_repeat_penalty_is_an_alias_of_repetition_penalty(self) -> None:
        engine, _, calls = _engine([("{}", "stop")])
        engine.complete(self._req(repeat_penalty=1.2))
        self.assertEqual(calls["rep"], {"repetition_penalty": 1.2})
        engine, _, calls = _engine([("{}", "stop")])
        engine.complete(self._req(repeat_penalty=1.2, repetition_penalty=1.3))
        self.assertEqual(calls["rep"], {"repetition_penalty": 1.3})

    def test_think_pair_only_when_thinking_on(self) -> None:
        engine, _, calls = _engine([("{}", "stop")])
        engine.complete(self._req(response_format={"type": "json_object"}, chat_template_kwargs={"enable_thinking": True}))
        self.assertEqual(calls["grammar"], [(json.dumps({"type": "object"}), (8, 9))])

    def test_thinking_block_stripped(self) -> None:
        engine, _, _ = _engine([("<think>\n\n</think>\n\n", None), ('{"a": 1}', "stop")])
        self.assertEqual(engine.complete(self._req())["choices"][0]["message"]["content"], '{"a": 1}')
        self.assertEqual(mlx_asr_server._strip_thinking("<|channel>thought\n<channel|>ok"), "ok")

    def test_stop_string_cuts_text(self) -> None:
        engine, _, _ = _engine([("one ", None), ("two END three", None), ("never", "stop")])
        out = engine.complete(self._req(stop=["END"]))
        self.assertEqual(out["choices"][0]["message"]["content"], "one two ")
        self.assertEqual(out["choices"][0]["finish_reason"], "stop")


class PrefixTokenizer(FakeLlmTokenizer):
    """Each message becomes a header token and one token per word; the system
    prompt is long, so the prefix spans more than one prefill step."""

    def apply_chat_template(self, messages: list[dict[str, str]], **kwargs: object) -> str:
        parts = [f"<{m['role']}> {m['content']}" for m in messages]
        return " ".join(parts) + (" <model>" if kwargs.get("add_generation_prompt") else "")

    def __init__(self) -> None:
        super().__init__()
        self.vocab: dict[str, int] = {}

    def encode(self, text: str, add_special_tokens: bool = True) -> list[int]:
        return [self.vocab.setdefault(w, 1000 + len(self.vocab)) for w in text.split()]


class FakeKv:
    """One fake cache layer: it records the chunk lengths it was fed."""

    def __init__(self) -> None:
        self.chunks: list[int] = []
        self.nbytes = 0


class PrefixCacheTests(unittest.TestCase):
    SYSTEM = " ".join(f"rule{i}" for i in range(4500))

    def setUp(self) -> None:
        self._log_patch = mock.patch.object(mlx_asr_server, "_log", lambda _m: None)
        self._log_patch.start()
        self.engine, _, self.calls = _engine([("ok", "stop")])
        self.engine.tok = PrefixTokenizer()
        self.made: list[FakeKv] = []

        def make_cache() -> list[FakeKv]:
            kv = FakeKv()
            self.made.append(kv)
            return [kv]

        def forward(cache: list[FakeKv], ids: list[int]) -> None:
            cache[0].chunks.append(len(ids))

        self.engine._prefix_cache = mlx_asr_server._PrefixCache(make_cache, forward)

    def tearDown(self) -> None:
        mock.patch.stopall()

    def _req(self, mode: str | None, text: str = "hello world", system: str | None = None):
        req = mlx_asr_server._parse_chat_request(
            {"messages": [{"role": "system", "content": system or self.SYSTEM}, {"role": "user", "content": text}]}
        )
        req["prefix_cache"] = mode
        return req

    def test_prefix_is_prefilled_in_step_chunks_up_to_the_user_text(self) -> None:
        req = self._req("off")
        ids = self.engine._prompt_ids(req)
        out = self.engine.complete(req)
        # "<system>" + 4500 words + "<user>" = 4502 prefix tokens.
        n = 4502
        self.assertEqual(self.engine._system_prefix_len(req, ids), n)
        self.assertEqual(self.made[0].chunks, [2048, 2048, 406])
        self.assertEqual(self.calls["stream"]["ids"], ids[n:])
        self.assertIs(self.calls["stream"]["prompt_cache"][0], self.made[0])
        self.assertEqual(out["usage"]["cached_tokens"], 0)
        self.assertEqual(out["usage"]["prompt_tokens"], len(ids))
        self.assertIsNone(self.engine._prefix_cache.ids)  # "off" keeps nothing

    def test_on_hit_gives_a_copy_and_the_same_cut(self) -> None:
        first = self.engine.complete(self._req("on", "one two"))
        first_cache = self.calls["stream"]["prompt_cache"]
        first_feed = self.calls["stream"]["ids"]
        second = self.engine.complete(self._req("on", "three four five"))
        second_cache = self.calls["stream"]["prompt_cache"]
        self.assertEqual(len(self.made), 1)  # one prefill only
        self.assertEqual((first["usage"]["cached_tokens"], second["usage"]["cached_tokens"]), (0, 4502))
        self.assertEqual(second["usage"]["prompt_tokens_details"], {"cached_tokens": 4502})
        stored = self.engine._prefix_cache.cache
        self.assertIsNot(first_cache, stored)
        self.assertIsNot(second_cache, stored)
        second_cache[0].chunks.append(99)  # a request writes into its copy only
        self.assertEqual(stored[0].chunks, [2048, 2048, 406])
        self.assertEqual(len(first_feed), 3)  # "one two <model>": no system token
        self.assertEqual(len(self.calls["stream"]["ids"]), 4)

    def test_on_and_off_feed_the_same_tokens_and_chunks(self) -> None:
        self.engine.complete(self._req("off"))
        off_feed, off_chunks = self.calls["stream"]["ids"], self.calls["stream"]["prompt_cache"][0].chunks
        self.engine.complete(self._req("on"))
        self.engine.complete(self._req("on"))
        self.assertEqual(self.calls["stream"]["ids"], off_feed)
        self.assertEqual(self.calls["stream"]["prompt_cache"][0].chunks, off_chunks)

    def test_new_system_prompt_replaces_the_entry(self) -> None:
        self.engine.complete(self._req("on", system="short system"))
        out = self.engine.complete(self._req("on", system="other system"))
        self.assertEqual(out["usage"]["cached_tokens"], 0)
        self.assertEqual(len(self.made), 2)
        self.assertEqual(len(self.engine._prefix_cache.ids), 4)

    def test_big_prefix_is_not_kept(self) -> None:
        with mock.patch.object(mlx_asr_server, "_PREFIX_CACHE_MAX_BYTES", -1):
            self.engine.complete(self._req("on"))
        self.assertIsNone(self.engine._prefix_cache.ids)
        self.assertIn("prompt_cache", self.calls["stream"])

    def test_no_system_message_keeps_the_plain_path(self) -> None:
        req = mlx_asr_server._parse_chat_request({"messages": [{"role": "user", "content": "hi"}]})
        req["prefix_cache"] = "on"
        self.engine.complete(req)
        self.assertNotIn("prompt_cache", self.calls["stream"])
        self.assertEqual(self.made, [])

    def test_header_values_and_env_switch(self) -> None:
        mode = mlx_asr_server._prefix_cache_mode
        self.assertIsNone(mode(None))
        self.assertEqual((mode("on"), mode(" OFF ")), ("on", "off"))
        with self.assertRaises(mlx_asr_server._BadRequest):
            mode("yes")
        with mock.patch.dict(os.environ, {"OPENSTYLE_MLX_LLM_PREFIX_CACHE": "off"}):
            self.assertEqual(mode("on"), "off")


class FakeMatcher:
    def __init__(self) -> None:
        self.consumed: list[int] = []
        self.stopped = False

    def is_stopped(self) -> bool:
        return self.stopped

    def consume_token(self, token: int) -> bool:
        self.consumed.append(token)
        return token != 99

    def get_error(self) -> str:
        return "bad token"


class JsonGrammarTests(unittest.TestCase):
    def _grammar(self, think: tuple[int, int] | None = (8, 9)):
        matcher = FakeMatcher()
        fills: list[int] = []

        def fill(m, bitmask, index):
            fills.append(index)
            bitmask[:] = 0
            bitmask[0, 0] = 1  # token 0 allowed

        def apply(logits, bitmask):
            return ("masked", bitmask.view(np.uint32)[0].tolist())

        grammar = mlx_asr_server._JsonGrammar(
            matcher, 64, think=think, allocate=lambda n, v: np.zeros((n, (v + 31) // 32), dtype=np.int32),
            fill=fill, apply=apply,
        )
        return grammar, matcher

    def test_first_step_allows_think_open(self) -> None:
        grammar, _ = self._grammar()
        kind, words = grammar(np.array([1, 2, 3]), "LOGITS")
        self.assertEqual(kind, "masked")
        self.assertEqual(words[0], 1 | (1 << 8))

    def test_grammar_starts_after_thinking_block(self) -> None:
        grammar, matcher = self._grammar()
        grammar(np.array([1]), "L")
        self.assertEqual(grammar(np.array([1, 8]), "L"), "L")  # free inside the block
        self.assertEqual(grammar(np.array([1, 8, 5]), "L"), "L")
        kind, words = grammar(np.array([1, 8, 5, 9]), "L")  # block closed: mask again
        self.assertEqual((kind, words[0]), ("masked", 1))
        grammar(np.array([1, 8, 5, 9, 0]), "L")
        self.assertEqual(matcher.consumed, [0])
        self.assertTrue(grammar.thought)

    def test_no_think_consumes_every_token(self) -> None:
        grammar, matcher = self._grammar(think=None)
        kind, words = grammar(np.array([1]), "L")
        self.assertEqual(words[0], 1)
        grammar(np.array([1, 0]), "L")
        grammar(np.array([1, 0, 0]), "L")
        self.assertEqual(matcher.consumed, [0, 0])

    def test_rejected_token_raises(self) -> None:
        grammar, _ = self._grammar(think=None)
        grammar(np.array([1]), "L")
        with self.assertRaises(RuntimeError):
            grammar(np.array([1, 99]), "L")

    def test_stopped_matcher_still_masks(self) -> None:
        # The grammar is complete: its mask allows the stop token only. Raw
        # logits here would let the model write text after a complete answer.
        grammar, matcher = self._grammar(think=None)
        grammar(np.array([1]), "L")
        matcher.stopped = True
        kind, words = grammar(np.array([1, 0]), "L")
        self.assertEqual((kind, words[0]), ("masked", 1))
        self.assertEqual(matcher.consumed, [])


class ContextGuardTests(unittest.TestCase):
    """The worker context guard (specs/llm-runtime-tuning.md 7 step 4)."""

    def setUp(self) -> None:
        self.logged: list[str] = []
        self._log_patch = mock.patch.object(mlx_asr_server, "_log", self.logged.append)
        self._log_patch.start()

    def tearDown(self) -> None:
        mock.patch.stopall()

    def _req(self, max_tokens: int) -> dict[str, object]:
        return mlx_asr_server._parse_chat_request({"messages": [{"role": "user", "content": "x"}], "max_tokens": max_tokens})

    def test_a_request_that_fits_generates(self) -> None:
        # FakeLlmTokenizer gives 3 prompt tokens.
        engine, _, calls = _engine([("ok", "stop")], context_tokens=100)
        out = engine.complete(self._req(50))
        self.assertEqual(out["choices"][0]["message"]["content"], "ok")
        self.assertEqual(calls["stream"]["max_tokens"], 50)
        self.assertFalse(any("CONTEXT EXCEEDED" in m for m in self.logged))

    def test_exactly_at_the_limit_generates(self) -> None:
        engine, _, calls = _engine([("ok", "stop")], context_tokens=100)
        out = engine.complete(self._req(97))  # 3 + 97 = 100
        self.assertEqual(out["choices"][0]["message"]["content"], "ok")
        self.assertIn("stream", calls)

    def test_one_token_over_the_limit_is_refused_and_not_generated(self) -> None:
        engine, _, calls = _engine([("ok", "stop")], context_tokens=100)
        with self.assertRaises(mlx_asr_server._ContextExceeded) as ctx:
            engine.complete(self._req(98))  # 3 + 98 = 101
        self.assertNotIn("stream", calls)
        self.assertEqual(
            ctx.exception.body(),
            {
                "error": {
                    "type": "invalid_request_error",
                    "code": "context_length_exceeded",
                    "message": "prompt 3 tokens + max_tokens 98 > context window 100 tokens",
                    "prompt_tokens": 3,
                    "max_tokens": 98,
                    "context_tokens": 100,
                }
            },
        )
        self.assertEqual(
            self.logged,
            ["CONTEXT EXCEEDED: request refused, not generated: prompt 3 tokens + max_tokens 98 > context window 100 tokens"],
        )

    def test_no_context_window_means_no_guard(self) -> None:
        engine, _, calls = _engine([("ok", "stop")])
        engine.complete(self._req(1_000_000))
        self.assertEqual(calls["stream"]["max_tokens"], 1_000_000)

    def test_prefix_cache_tokens_count_in_full(self) -> None:
        engine, _, calls = _engine([("ok", "stop")])
        engine.tok = PrefixTokenizer()
        made: list[FakeKv] = []

        def make_cache() -> list[FakeKv]:
            made.append(FakeKv())
            return made[-1:]

        engine._prefix_cache = mlx_asr_server._PrefixCache(make_cache, lambda cache, ids: cache[0].chunks.append(len(ids)))
        system = " ".join(f"rule{i}" for i in range(100))

        def req(text: str, max_tokens: int) -> dict[str, object]:
            r = mlx_asr_server._parse_chat_request(
                {
                    "messages": [{"role": "system", "content": system}, {"role": "user", "content": text}],
                    "max_tokens": max_tokens,
                }
            )
            r["prefix_cache"] = "on"
            return r

        n = len(engine._prompt_ids(req("a b", 1)))  # 102 prefix + 3 user tokens
        engine.context_tokens = n + 10
        first = engine.complete(req("a b", 10))  # exactly at the limit: a miss
        self.assertEqual(first["usage"]["cached_tokens"], 0)
        second = engine.complete(req("c d", 10))  # at the limit: a hit
        self.assertEqual(second["usage"]["cached_tokens"], 102)
        self.assertEqual(second["usage"]["prompt_tokens"], n)
        del calls["stream"]
        # A hit feeds only 3 new tokens, but the guard counts all n tokens.
        with self.assertRaises(mlx_asr_server._ContextExceeded) as ctx:
            engine.complete(req("e f", 11))
        self.assertEqual((ctx.exception.prompt_tokens, ctx.exception.max_tokens), (n, 11))
        self.assertNotIn("stream", calls)
        self.assertEqual(len(made), 1)  # the refusal made no new prefill
        # A refusal on a miss does not prefill either.
        with self.assertRaises(mlx_asr_server._ContextExceeded):
            engine.complete(req("x " * 50, 10))
        self.assertEqual(len(made), 1)

    def test_main_passes_the_context_window(self) -> None:
        seen: list[tuple[object, ...]] = []
        argv = ["mlx_asr_server.py", "--llm", "--model", "m", "--port", "1", "--context-tokens", "32768"]
        with mock.patch.object(sys, "argv", argv), \
            mock.patch.object(mlx_asr_server, "_run_llm", lambda *a: seen.append(a)):
            mlx_asr_server.main()
        self.assertEqual(seen, [("m", 1, 32768)])
        argv = ["mlx_asr_server.py", "--llm", "--model", "m", "--port", "1"]
        with mock.patch.object(sys, "argv", argv), \
            mock.patch.object(mlx_asr_server, "_run_llm", lambda *a: seen.append(a)):
            mlx_asr_server.main()
        self.assertEqual(seen[-1], ("m", 1, None))
        argv = ["mlx_asr_server.py", "--llm", "--model", "m", "--port", "1", "--context-tokens", "0"]
        with mock.patch.object(sys, "argv", argv), mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            mlx_asr_server.main()


class LlmHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        from http.server import HTTPServer

        self._log_patch = mock.patch.object(mlx_asr_server, "_log", lambda _m: None)
        self._log_patch.start()
        self.engine, _, _ = _engine([('{"corrections": []}', "stop")])
        self.httpd = HTTPServer(("127.0.0.1", 0), mlx_asr_server._make_llm_handler(self.engine))
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self._log_patch.stop()

    def _call(self, method: str, path: str, body: object = None) -> tuple[int, dict[str, object]]:
        import urllib.error
        import urllib.request

        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())

    def test_models(self) -> None:
        self.assertEqual(
            self._call("GET", "/v1/models"),
            (200, {"object": "list", "data": [{"id": "mlx-community/Fake-LLM", "object": "model"}]}),
        )

    def test_chat_completion(self) -> None:
        status, out = self._call("POST", "/v1/chat/completions", {"messages": [{"role": "user", "content": "x"}], "stream": False})
        self.assertEqual(status, 200)
        self.assertEqual(out["choices"][0]["message"]["content"], '{"corrections": []}')
        self.assertIn("usage", out)

    def test_stream_true_is_400(self) -> None:
        status, out = self._call("POST", "/v1/chat/completions", {"messages": [{"role": "user", "content": "x"}], "stream": True})
        self.assertEqual(status, 400)
        self.assertEqual(out["error"]["type"], "invalid_request_error")
        self.assertIn("stream", out["error"]["message"])

    def test_generation_error_is_500(self) -> None:
        with mock.patch.object(self.engine, "complete", side_effect=RuntimeError("boom")):
            status, out = self._call("POST", "/v1/chat/completions", {"messages": [{"role": "user", "content": "x"}]})
        self.assertEqual((status, out["error"]["message"]), (500, "boom"))

    def test_unknown_path_is_404(self) -> None:
        self.assertEqual(self._call("GET", "/nope")[0], 404)

    def test_context_exceeded_is_a_typed_400(self) -> None:
        self.engine.context_tokens = 10
        status, out = self._call("POST", "/v1/chat/completions", {"messages": [{"role": "user", "content": "x"}], "max_tokens": 8})
        self.assertEqual(status, 400)
        self.assertEqual(
            out,
            {
                "error": {
                    "type": "invalid_request_error",
                    "code": "context_length_exceeded",
                    "message": "prompt 3 tokens + max_tokens 8 > context window 10 tokens",
                    "prompt_tokens": 3,
                    "max_tokens": 8,
                    "context_tokens": 10,
                }
            },
        )
        status, _ = self._call("POST", "/v1/chat/completions", {"messages": [{"role": "user", "content": "x"}], "max_tokens": 7})
        self.assertEqual(status, 200)

    def test_prefix_cache_header_reaches_the_engine(self) -> None:
        import urllib.error
        import urllib.request

        seen: list[object] = []
        body = json.dumps({"messages": [{"role": "user", "content": "x"}]}).encode()
        with mock.patch.object(self.engine, "complete", side_effect=lambda req: seen.append(req["prefix_cache"]) or {}):
            for value in (None, "on", "bad"):
                req = urllib.request.Request(f"http://127.0.0.1:{self.port}/v1/chat/completions", data=body, method="POST")
                if value is not None:
                    req.add_header("X-Openstyle-Prefix-Cache", value)
                try:
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        status = resp.status
                except urllib.error.HTTPError as err:
                    status = err.code
                seen.append(status)
        self.assertEqual(seen, [None, 200, "on", 200, 400])


class RunLlmTests(unittest.TestCase):
    def _run(self, **patches: object) -> list[dict[str, object]]:
        import io

        out = io.StringIO()
        with mock.patch.object(mlx_asr_server, "_log", lambda _m: None), \
            mock.patch("sys.stdout", out), \
            mock.patch("signal.signal") as sig, \
            mock.patch.object(mlx_asr_server.threading, "Thread"), \
            mock.patch("http.server.HTTPServer.serve_forever", return_value=None):
            for name, value in patches.items():
                mock.patch.object(mlx_asr_server, name, value).start()
            try:
                mlx_asr_server._run_llm("mlx-community/Fake-LLM", 0)
            finally:
                mock.patch.stopall()
            self.signal_calls = sig.call_args_list
        return [json.loads(line) for line in out.getvalue().splitlines()]

    def test_ready_line_after_load(self) -> None:
        engine, _, _ = _engine([])
        lines = self._run(_load_llm_engine=lambda _m, _c=None: engine)
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["type"], "ready")
        self.assertEqual(lines[0]["model"], "mlx-community/Fake-LLM")
        self.assertIsInstance(lines[0]["port"], int)
        self.assertGreater(lines[0]["port"], 0)
        import signal

        self.assertEqual(self.signal_calls[0].args[0], signal.SIGTERM)

    def test_ready_line_has_metal_info(self) -> None:
        engine, _, _ = _engine([])
        metal = {"metal": {"max_recommended_working_set_size": 107_000_000_000, "memory_size": 137_000_000_000}}
        lines = self._run(_load_llm_engine=lambda _m, _c=None: engine, _metal_info=lambda: metal)
        self.assertEqual(lines[0]["metal"], metal["metal"])

    def test_metal_info_is_empty_without_mlx(self) -> None:
        with mock.patch.dict(sys.modules, {"mlx": None, "mlx.core": None}):
            self.assertEqual(mlx_asr_server._metal_info(), {})

    def test_load_error_line_and_exit_1(self) -> None:
        def boom(_m: str, _c: object = None) -> object:
            raise RuntimeError("no weights")

        with self.assertRaises(SystemExit) as ctx:
            self._run(_load_llm_engine=boom)
        self.assertEqual(ctx.exception.code, 1)


class ShutdownTests(unittest.TestCase):
    """The HTTP worker always exits on SIGTERM and on stdin EOF, also when
    stderr is a broken pipe (the parent died) or a print() runs on stderr."""

    def test_exit_now_exits_when_stderr_is_broken(self) -> None:
        with mock.patch.object(mlx_asr_server.os, "write", side_effect=BrokenPipeError()), \
            mock.patch.object(mlx_asr_server.os, "_exit") as exit_:
            mlx_asr_server._exit_now("stdin closed; shutting down")
        exit_.assert_called_once_with(0)

    def test_exit_now_writes_one_line_to_fd_2(self) -> None:
        with mock.patch.object(mlx_asr_server.os, "write") as write, \
            mock.patch.object(mlx_asr_server.os, "_exit") as exit_:
            mlx_asr_server._exit_now("SIGTERM; shutting down")
        write.assert_called_once_with(2, b"[mlx-asr] SIGTERM; shutting down\n")
        exit_.assert_called_once_with(0)

    def test_watch_stdin_exits_on_eof_with_broken_stderr(self) -> None:
        with mock.patch("sys.stdin", iter(["a\n", "b\n"])), \
            mock.patch.object(mlx_asr_server.os, "write", side_effect=BrokenPipeError()), \
            mock.patch.object(mlx_asr_server.os, "_exit") as exit_:
            mlx_asr_server._watch_stdin()
        exit_.assert_called_once_with(0)

    def test_sigterm_handler_uses_exit_now(self) -> None:
        engine, _, _ = _engine([])
        handlers: dict[int, object] = {}
        with mock.patch.object(mlx_asr_server, "_log", lambda _m: None), \
            mock.patch("sys.stdout"), \
            mock.patch("signal.signal", side_effect=lambda s, h: handlers.__setitem__(s, h)), \
            mock.patch.object(mlx_asr_server.threading, "Thread"), \
            mock.patch("http.server.HTTPServer.serve_forever", return_value=None), \
            mock.patch.object(mlx_asr_server, "_load_llm_engine", lambda _m, _c=None: engine):
            mlx_asr_server._run_llm("mlx-community/Fake-LLM", 0)
        import signal

        with mock.patch.object(mlx_asr_server, "_exit_now") as exit_now:
            handlers[signal.SIGTERM](signal.SIGTERM, None)  # type: ignore[operator]
        exit_now.assert_called_once_with("SIGTERM; shutting down")

    def test_child_exits_after_stdin_eof_when_parent_closed_stderr(self) -> None:
        """A real process: stderr is a pipe whose reader is gone, as when the
        parent died. Before the fix, the watcher thread died on
        BrokenPipeError and the process stayed alive."""
        import subprocess

        code = (
            "import importlib.util, threading, time, sys\n"
            f"spec = importlib.util.spec_from_file_location('m', {str(ROOT / 'scripts' / 'mlx_asr_server.py')!r})\n"
            "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n"
            "threading.Thread(target=m._watch_stdin, daemon=True).start()\n"
            "print('ready', flush=True)\n"
            "while True: time.sleep(0.2)\n"
        )
        read_fd, write_fd = os.pipe()
        proc = subprocess.Popen(
            [sys.executable, "-c", code],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=write_fd,
        )
        os.close(write_fd)
        try:
            assert proc.stdout is not None and proc.stdin is not None
            self.assertEqual(proc.stdout.readline().strip(), b"ready")
            os.close(read_fd)  # the reader of stderr is gone: a broken pipe
            proc.stdin.close()  # EOF, as when the parent dies
            self.assertEqual(proc.wait(timeout=10), 0)
        finally:
            if proc.poll() is None:
                proc.kill()


# --- Embed mode (specs/local-semantic-search.md 5.2) -----------------------


class FakeEmbedTokenizer:
    """Whitespace tokenizer with a BOS token, in the shape of a HF tokenizer."""

    def __call__(self, texts, padding=False, truncation=False, max_length=None, return_tensors=None):
        ids = [[2] + [10 + len(w) for w in t.split()] for t in texts]
        if truncation and max_length:
            ids = [row[:max_length] for row in ids]
        if not padding:
            return {"input_ids": ids}
        width = max(len(row) for row in ids)
        return {
            "input_ids": np.array([row + [0] * (width - len(row)) for row in ids]),
            "attention_mask": np.array([[1] * len(row) + [0] * (width - len(row)) for row in ids]),
        }


def _embed_engine(scale: float = 1.0, nan: bool = False, dims: int = 4):
    seen: list[tuple[int, int]] = []

    def forward(input_ids, attention_mask):
        seen.append(tuple(input_ids.shape))
        n = input_ids.shape[0]
        out = np.zeros((n, dims), dtype=np.float32)
        for i in range(n):
            out[i, i % dims] = scale
        if nan and n > 1:
            out[0, 0] = np.nan
        return out

    engine = mlx_asr_server._EmbedEngine("org/fake-embed", FakeEmbedTokenizer(), forward)
    return engine, seen


class EmbedRequestTests(unittest.TestCase):
    def test_string_input_is_one_item(self) -> None:
        self.assertEqual(mlx_asr_server._parse_embed_request({"input": "a"}, 768), ["a"])

    def test_list_input_and_ignored_model(self) -> None:
        body = {"input": ["a", "b"], "model": "anything", "encoding_format": "float", "dimensions": 768}
        self.assertEqual(mlx_asr_server._parse_embed_request(body, 768), ["a", "b"])

    def test_bad_bodies_are_rejected(self) -> None:
        bad = [
            None,
            {},
            {"input": []},
            {"input": [1]},
            {"input": ["a"] * 33},
            {"input": "a", "encoding_format": "base64"},
            {"input": "a", "dimensions": 256},
            {"input": "a", "dimensions": True},
        ]
        for body in bad:
            with self.subTest(body=body), self.assertRaises(mlx_asr_server._BadRequest):
                mlx_asr_server._parse_embed_request(body, 768)

    def test_32_inputs_pass(self) -> None:
        self.assertEqual(len(mlx_asr_server._parse_embed_request({"input": ["a"] * 32}, 768)), 32)


class EmbedEngineTests(unittest.TestCase):
    def test_dims_come_from_a_probe_pass(self) -> None:
        engine, seen = _embed_engine(dims=6)
        self.assertEqual(engine.dims, 6)
        self.assertEqual(len(seen), 1)

    def test_embed_shape_order_and_usage(self) -> None:
        engine, _ = _embed_engine()
        out = engine.embed(["one two", "three"])
        self.assertEqual(out["object"], "list")
        self.assertEqual(out["model"], "org/fake-embed")
        self.assertEqual([d["index"] for d in out["data"]], [0, 1])
        self.assertEqual([len(d["embedding"]) for d in out["data"]], [4, 4])
        self.assertEqual(out["openstyle"], {"tokens": [3, 2], "truncated": [False, False]})
        self.assertEqual(out["usage"], {"prompt_tokens": 5, "total_tokens": 5})

    def test_vectors_are_renormalized(self) -> None:
        engine, _ = _embed_engine(scale=3.0)
        out = engine.embed(["a", "b"])
        for row in out["data"]:
            self.assertAlmostEqual(float(np.linalg.norm(row["embedding"])), 1.0, places=5)

    def test_long_input_is_truncated_and_marked(self) -> None:
        engine, seen = _embed_engine()
        out = engine.embed([" ".join(["w"] * 600)])
        self.assertEqual(out["openstyle"], {"tokens": [601], "truncated": [True]})
        self.assertEqual(out["usage"]["prompt_tokens"], 512)
        self.assertEqual(seen[-1], (1, 512))

    def test_nan_output_raises(self) -> None:
        engine, _ = _embed_engine(nan=True)
        with self.assertRaises(RuntimeError):
            engine.embed(["a", "b"])


class EmbedHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        from http.server import HTTPServer

        self._log_patch = mock.patch.object(mlx_asr_server, "_log", lambda _m: None)
        self._log_patch.start()
        self.engine, _ = _embed_engine()
        self.httpd = HTTPServer(("127.0.0.1", 0), mlx_asr_server._make_embed_handler(self.engine))
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self._log_patch.stop()

    def _call(self, method: str, path: str, body: object = None) -> tuple[int, dict[str, object]]:
        import urllib.error
        import urllib.request

        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())

    def test_models(self) -> None:
        self.assertEqual(
            self._call("GET", "/v1/models"),
            (200, {"object": "list", "data": [{"id": "org/fake-embed", "object": "model"}]}),
        )

    def test_embeddings(self) -> None:
        status, out = self._call("POST", "/v1/embeddings", {"input": ["a", "b c"], "model": "x"})
        self.assertEqual(status, 200)
        self.assertEqual(len(out["data"]), 2)
        self.assertEqual(len(out["data"][1]["embedding"]), 4)

    def test_bad_request_is_400(self) -> None:
        status, out = self._call("POST", "/v1/embeddings", {"input": "a", "dimensions": 3})
        self.assertEqual((status, out["error"]["type"]), (400, "invalid_request_error"))

    def test_nan_is_500(self) -> None:
        with mock.patch.object(self.engine, "embed", side_effect=RuntimeError("embedding output is not finite")):
            status, out = self._call("POST", "/v1/embeddings", {"input": "a"})
        self.assertEqual((status, out["error"]["type"]), (500, "server_error"))

    def test_chat_path_is_404(self) -> None:
        self.assertEqual(self._call("POST", "/v1/chat/completions", {"messages": []})[0], 404)

    def test_closes_each_connection_so_the_next_one_is_served(self) -> None:
        import http.client
        import time

        body = json.dumps({"input": ["a"]})
        first = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        first.request("POST", "/v1/embeddings", body, {"Content-Type": "application/json"})
        resp = first.getresponse()
        resp.read()
        self.assertEqual(resp.getheader("Connection"), "close")
        # The first client keeps its socket open, as a keep-alive pool does.
        # The single-threaded server must still serve a new connection now.
        second = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        try:
            start = time.monotonic()
            second.request("POST", "/v1/embeddings", body, {"Content-Type": "application/json"})
            self.assertEqual(second.getresponse().status, 200)
            self.assertLess(time.monotonic() - start, 1.0)
        finally:
            # Free the server even when the check fails, so tearDown ends.
            first.close()
            second.close()


class RunEmbedTests(unittest.TestCase):
    def _run(self, load: object) -> list[dict[str, object]]:
        import io

        out = io.StringIO()
        with mock.patch.object(mlx_asr_server, "_log", lambda _m: None), \
            mock.patch("sys.stdout", out), \
            mock.patch("signal.signal"), \
            mock.patch.object(mlx_asr_server.threading, "Thread"), \
            mock.patch("http.server.HTTPServer.serve_forever", return_value=None), \
            mock.patch.object(mlx_asr_server, "_load_embed_engine", load):
            mlx_asr_server._run_embed("org/fake-embed", "abc123", 0)
        return [json.loads(line) for line in out.getvalue().splitlines()]

    def test_ready_line_has_dims(self) -> None:
        engine, _ = _embed_engine(dims=768)
        calls: list[tuple[str, object]] = []

        def load(model_id: str, revision: object) -> object:
            calls.append((model_id, revision))
            return engine

        lines = self._run(load)
        self.assertEqual(calls, [("org/fake-embed", "abc123")])
        self.assertEqual(len(lines), 1)
        self.assertEqual((lines[0]["type"], lines[0]["model"], lines[0]["dims"]), ("ready", "org/fake-embed", 768))
        self.assertGreater(lines[0]["port"], 0)

    def test_load_error_line_and_exit_1(self) -> None:
        def boom(_m: str, _r: object) -> object:
            raise RuntimeError("no weights")

        with self.assertRaises(SystemExit) as ctx:
            self._run(boom)
        self.assertEqual(ctx.exception.code, 1)


class ResolveModelDirTests(unittest.TestCase):
    def _cache(self, tmp: str) -> Path:
        repo = Path(tmp) / "models--org--fake-embed"
        (repo / "snapshots" / "rev1").mkdir(parents=True)
        (repo / "snapshots" / "rev1" / "config.json").write_text("{}")
        (repo / "refs").mkdir()
        (repo / "refs" / "main").write_text("rev1\n")
        return repo

    def test_pinned_revision_and_refs_main(self) -> None:
        import huggingface_hub.constants as hub_constants

        with tempfile.TemporaryDirectory() as tmp:
            repo = self._cache(tmp)
            with mock.patch.object(hub_constants, "HF_HUB_CACHE", tmp):
                self.assertEqual(mlx_asr_server._resolve_model_dir("org/fake-embed", "rev1"), repo / "snapshots" / "rev1")
                self.assertEqual(mlx_asr_server._resolve_model_dir("org/fake-embed", None), repo / "snapshots" / "rev1")
                with self.assertRaises(FileNotFoundError):
                    mlx_asr_server._resolve_model_dir("org/fake-embed", "other")
                with self.assertRaises(FileNotFoundError):
                    mlx_asr_server._resolve_model_dir("org/missing", None)



class _ByteTokenizer:
    """One token per byte, plus EOS 256. Enough for llguidance to check text."""

    eos_token_id = 256
    bos_token_id = None
    tokens = [bytes([i]) for i in range(256)] + [b"<eos>"]
    special_token_ids = [256]

    def __call__(self, s: bytes | str) -> list[int]:
        return list(s.encode("utf-8") if isinstance(s, str) else s)


class JsonGrammarOptionsTests(unittest.TestCase):
    """PR #258: flexible JSON whitespace, but each run is at most 24 chars."""

    SUMMARY = {
        "type": "object",
        "properties": {
            "actionItems": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"task": {"type": "string"}},
                    "required": ["task"],
                    "additionalProperties": False,
                },
            },
            "openQuestions": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["actionItems", "openQuestions"],
        "additionalProperties": False,
    }

    def test_options_keep_flexible_and_bound_the_run(self) -> None:
        self.assertEqual(
            mlx_asr_server._JSON_GRAMMAR_OPTIONS,
            {"whitespace_flexible": True, "whitespace_pattern": r"[\x20\x0A\x0D\x09]{0,24}"},
        )

    def _accepted(self, text: str) -> tuple[int, int]:
        try:
            import llguidance
            from llguidance import LLMatcher
        except ImportError:
            self.skipTest("llguidance is not installed (use the worker build venv)")
        ll_tok = llguidance.LLTokenizer(llguidance.TokenizerWrapper(_ByteTokenizer()))
        grammar = LLMatcher.grammar_from_json_schema(
            json.dumps(self.SUMMARY), defaults=mlx_asr_server._JSON_GRAMMAR_OPTIONS
        )
        matcher = LLMatcher(ll_tok, grammar)
        self.assertFalse(matcher.is_error(), matcher.get_error())
        ids = list(text.encode("utf-8"))
        return matcher.validate_tokens(ids), len(ids)

    def test_pretty_and_compact_json_pass(self) -> None:
        pretty = json.dumps({"actionItems": [{"task": "Send the plan"}], "openQuestions": []}, indent=4)
        compact = json.dumps({"actionItems": [], "openQuestions": ["Who?"]}, separators=(",", ":"))
        for text in (pretty, compact):
            ok, total = self._accepted(text)
            self.assertEqual(ok, total, text)

    def test_whitespace_loop_after_a_closed_list_is_cut(self) -> None:
        head = '{\n  "actionItems": [\n    {\n      "task": "Send the plan"\n    }\n  ]'
        ok, total = self._accepted(head + "\n    " * 40)
        # The grammar takes the head and at most 24 whitespace chars, then
        # the model must write "," or "}".
        self.assertLessEqual(ok, len(head) + 24)
        self.assertLess(ok, total)

    def test_whitespace_inside_a_string_is_free(self) -> None:
        text = json.dumps({"actionItems": [{"task": "a" + " " * 60 + "b"}], "openQuestions": []})
        ok, total = self._accepted(text)
        self.assertEqual(ok, total)


# --- Rerank mode (specs/meeting-chat-agent.md 7.4.3) -----------------------


class FakeRerankTokenizer:
    """One token per character. The text of a pair has a fixed prefix, so the
    row length grows with the document."""

    def encode(self, text):
        return [ord(c) % 251 + 1 for c in text]

    def decode(self, ids):
        return "".join(chr((i - 1) % 251) for i in ids)


def _rerank_engine(pad_id: int = 0):
    """A stub forward whose score depends ONLY on the real tokens of a row."""
    calls: list[tuple[int, int]] = []

    def forward(rows, lengths):
        calls.append((len(rows), len(rows[0])))
        out = []
        for row, n in zip(rows, lengths):
            real = row[:n]
            value = (sum(real) * 31 + real[-1]) % 1000 / 1000.0
            out.append(value)
        return out

    return mlx_asr_server._RerankEngine("org/fake-rerank", FakeRerankTokenizer(), forward, pad_id=pad_id), calls


class RerankRequestTests(unittest.TestCase):
    def test_good_body_and_default_batch(self) -> None:
        q, docs, batch = mlx_asr_server._parse_rerank_request({"query": "q", "documents": ["a", "b"]})
        self.assertEqual((q, docs, batch), ("q", ["a", "b"], mlx_asr_server._RERANK_DEFAULT_BATCH))

    def test_batch_is_kept(self) -> None:
        self.assertEqual(mlx_asr_server._parse_rerank_request({"query": "q", "documents": ["a"], "batch": 5})[2], 5)

    def test_bad_bodies_are_rejected(self) -> None:
        bad = [
            None,
            {},
            {"query": "", "documents": ["a"]},
            {"query": "q", "documents": []},
            {"query": "q", "documents": [1]},
            {"query": "q", "documents": ["a"] * 65},
            {"query": "q", "documents": ["a"], "batch": 0},
            {"query": "q", "documents": ["a"], "batch": 33},
            {"query": "q", "documents": ["a"], "batch": True},
        ]
        for body in bad:
            with self.subTest(body=body), self.assertRaises(mlx_asr_server._BadRequest):
                mlx_asr_server._parse_rerank_request(body)


class RerankEngineTests(unittest.TestCase):
    DOCS = ["a", "a much longer document " * 5, "mid size doc", "x" * 40, "second short", "z"]

    def test_batched_scores_equal_unbatched_scores(self) -> None:
        engine, _ = _rerank_engine()
        single = engine.score("question", self.DOCS, batch=1)
        for batch in (2, 4, 32):
            got = engine.score("question", self.DOCS, batch=batch)
            for a, b in zip(single, got):
                self.assertAlmostEqual(a, b, places=3)

    def test_rows_are_right_padded_with_the_pad_id_and_lengths_are_real(self) -> None:
        seen: list[tuple[list[list[int]], list[int]]] = []

        def forward(rows, lengths):
            seen.append((rows, lengths))
            return [0.5] * len(rows)

        engine = mlx_asr_server._RerankEngine("m", FakeRerankTokenizer(), forward, pad_id=7)
        engine.score("q", ["a", "a longer document here"], batch=2)
        rows, lengths = seen[0]
        self.assertEqual(len({len(r) for r in rows}), 1)
        for row, n in zip(rows, lengths):
            self.assertEqual(row[n:], [7] * (len(row) - n))
            self.assertNotEqual(row[n - 1], 7)
        self.assertLess(min(lengths), max(lengths))

    def test_order_of_the_scores_is_the_order_of_the_documents(self) -> None:
        engine, _ = _rerank_engine()
        full = engine.score("question", self.DOCS, batch=3)
        for i, doc in enumerate(self.DOCS):
            self.assertAlmostEqual(engine.score("question", [doc], batch=1)[0], full[i], places=3)

    def test_batches_are_cut_by_the_batch_size_and_sorted_by_length(self) -> None:
        engine, calls = _rerank_engine()
        engine.score("question", self.DOCS, batch=4)
        self.assertEqual([n for n, _ in calls], [4, 2])
        widths = [w for _, w in calls]
        self.assertEqual(widths, sorted(widths))

    def test_long_document_is_cut_to_700_tokens(self) -> None:
        engine, calls = _rerank_engine()
        engine.score("q", ["w" * 5000], batch=1)
        prefix_and_suffix = len(engine._pair_ids("q", ""))
        self.assertEqual(calls[-1][1], prefix_and_suffix + mlx_asr_server._RERANK_MAX_DOC_TOKENS)

    def test_not_finite_output_raises(self) -> None:
        engine = mlx_asr_server._RerankEngine(
            "m", FakeRerankTokenizer(), lambda rows, lengths: [float("nan")] * len(rows)
        )
        with self.assertRaises(RuntimeError):
            engine.score("q", ["a"])

    def test_wrong_size_output_raises(self) -> None:
        engine = mlx_asr_server._RerankEngine("m", FakeRerankTokenizer(), lambda rows, lengths: [0.5])
        with self.assertRaises(RuntimeError):
            engine.score("q", ["a", "b"], batch=2)


class RerankHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        from http.server import HTTPServer

        self._log_patch = mock.patch.object(mlx_asr_server, "_log", lambda _m: None)
        self._log_patch.start()
        self.engine, _ = _rerank_engine()
        self.httpd = HTTPServer(("127.0.0.1", 0), mlx_asr_server._make_rerank_handler(self.engine))
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self._log_patch.stop()

    def _call(self, method: str, path: str, body: object = None) -> tuple[int, dict[str, object]]:
        import urllib.error
        import urllib.request

        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())

    def test_models(self) -> None:
        self.assertEqual(
            self._call("GET", "/v1/models"),
            (200, {"object": "list", "data": [{"id": "org/fake-rerank", "object": "model"}]}),
        )

    def test_rerank(self) -> None:
        status, out = self._call("POST", "/v1/rerank", {"query": "q", "documents": ["a", "bb", "ccc"], "batch": 2})
        self.assertEqual(status, 200)
        self.assertEqual(len(out["scores"]), 3)
        self.assertGreaterEqual(out["ms"], 0)

    def test_bad_request_is_400(self) -> None:
        status, out = self._call("POST", "/v1/rerank", {"query": "q", "documents": []})
        self.assertEqual((status, out["error"]["type"]), (400, "invalid_request_error"))

    def test_engine_error_is_500(self) -> None:
        with mock.patch.object(self.engine, "score", side_effect=RuntimeError("boom")):
            status, out = self._call("POST", "/v1/rerank", {"query": "q", "documents": ["a"]})
        self.assertEqual((status, out["error"]["type"]), (500, "server_error"))

    def test_embed_path_is_404(self) -> None:
        self.assertEqual(self._call("POST", "/v1/embeddings", {"input": "a"})[0], 404)


if __name__ == "__main__":
    unittest.main()
