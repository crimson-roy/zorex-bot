import base64
import http.client
from collections import UserDict
import importlib.util
import json
import os
import pathlib
import tempfile
import threading
import time
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("ari_kaggle_api_cell", ROOT / "dev" / "ari-kaggle-api-cell.py")
API = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(API)

COMPLETE_OBSERVATION = """Overall scene and composition: A simple diagram is centered on a plain white background, with two large geometric shapes arranged horizontally.
Identifiable objects: The image contains one red circle on the left and one blue square on the right, with no other distinct foreground objects.
Colours, shapes, textures, and visible characteristics: The circle is solid red with a smooth edge. The square is solid blue with straight edges and sharp corners. Both shapes appear flat and evenly coloured.
Positions and spatial relationships: The red circle is left of the blue square. There is a clear gap between them; neither shape overlaps the other.
Actions and interactions: No movement or interaction is visible. The image is a static diagram.
Background and environmental details: The background is plain white and contains no visible setting, horizon, or environmental texture.
Visible text and accurate transcription: No readable text, labels, numbers, or symbols are visible.
Additional relevant details that could be overlooked: The shapes are similar in visual size, and the square appears slightly taller than the circle's diameter.
Uncertainty, occlusion, and visual limitations: No objects appear occluded. Fine surface texture cannot be determined from this flat illustration; no other details are inferred."""


class FakeModel:
    def __init__(self, name):
        self.config = type("Config", (), {"_name_or_path": name})()

    def generate(self, **kwargs):
        raise AssertionError("generation_runner should intercept local tests")


class FakeProcessor:
    def __init__(self, name):
        self.name_or_path = name

    def apply_chat_template(self, *args, **kwargs):
        raise AssertionError("generation_runner should intercept local tests")

    def decode(self, *args, **kwargs):
        raise AssertionError("generation_runner should intercept local tests")


class FakeTensor:
    def __init__(self, values):
        self.values = values
        self.shape = (1, len(values[0])) if values and isinstance(values[0], list) else (len(values),)

    def to(self, _device):
        return self

    def tolist(self):
        return self.values

    def __getitem__(self, index):
        if isinstance(index, int) and self.values and isinstance(self.values[0], list):
            return FakeTensor(self.values[index])
        if isinstance(index, slice):
            values = self.values[0] if self.values and isinstance(self.values[0], list) else self.values
            return FakeTensor(values[index])
        return self.values[index]

    def __len__(self):
        return len(self.values[0]) if self.values and isinstance(self.values[0], list) else len(self.values)


class FakeBatch(dict):
    def to(self, _device):
        return self


class GeneratingFakeModel(FakeModel):
    def __init__(self, name, output_ids):
        super().__init__(name)
        self.output_ids = output_ids
        self.device = "cpu"
        self.generation_config = type("GenerationConfig", (), {"eos_token_id": 2})()

    def generate(self, **kwargs):
        self.last_generate_kwargs = kwargs
        input_ids = kwargs["input_ids"].tolist()[0]
        return FakeTensor([input_ids + self.output_ids])


class FakeMappingBatch(UserDict):
    """Mapping-like BatchEncoding that is deliberately not a plain dict."""
    pass


class FakeQwenTokenizer(FakeProcessor):
    def apply_chat_template(self, messages, **kwargs):
        self.last_messages = messages
        self.last_template_options = kwargs
        return FakeMappingBatch({"input_ids": FakeTensor([[101, 102]]), "attention_mask": FakeTensor([[1, 1]])})

    def convert_tokens_to_ids(self, _token):
        return 151668

    def decode(self, ids, skip_special_tokens=False):
        values = ids.tolist() if hasattr(ids, "tolist") else ids
        if values and isinstance(values[0], list):
            values = values[0]
        if 151668 in values:
            return "<think>private reasoning</think>Qwen parsed final."
        if 703 in values:
            return "Qwen parsed final."
        return "<think>private reasoning"


class LongPromptQwenTokenizer(FakeQwenTokenizer):
    def apply_chat_template(self, messages, **kwargs):
        self.last_messages = messages
        self.last_template_options = kwargs
        return FakeMappingBatch({"input_ids": FakeTensor([[101] * 100]), "attention_mask": FakeTensor([[1] * 100])})


class FakeGemmaProcessor(FakeProcessor):
    def apply_chat_template(self, messages, **kwargs):
        self.last_messages = messages
        self.last_template_options = kwargs
        return FakeBatch(input_ids=FakeTensor([[201, 202]]), attention_mask=FakeTensor([[1, 1]]))

    def decode(self, ids, **kwargs):
        return "raw Gemma response"

    def parse_response(self, raw, prefix=None):
        self.last_parse_prefix = prefix
        return {"final": "Gemma parsed final."}


class LongPromptGemmaProcessor(FakeGemmaProcessor):
    def apply_chat_template(self, messages, **kwargs):
        self.last_messages = messages
        self.last_template_options = kwargs
        return FakeBatch(input_ids=FakeTensor([[201] * 100]), attention_mask=FakeTensor([[1] * 100]))


def namespace(include_qwen=True, include_e2b=True, include_e4b=True):
    result = {"ARI_SYSTEM_PROMPT": "You are Ari."}
    if include_qwen:
        result["QWEN_MODEL"] = FakeModel("Qwen/Qwen3-4B")
        result["QWEN_TOKENIZER"] = FakeProcessor("Qwen/Qwen3-4B")
    if include_e2b:
        result["ARI_E2B_MODEL"] = FakeModel("google/gemma-4-E2B-it")
        result["ARI_E2B_PROCESSOR"] = FakeProcessor("google/gemma-4-E2B-it")
    if include_e4b:
        result["MODEL_ID"] = "google/gemma-4-E4B-it"
        result["MODEL"] = FakeModel("google/gemma-4-E4B-it")
        result["PROCESSOR"] = FakeProcessor("google/gemma-4-E4B-it")
    return result


def sample_request(tier="medium", image=None, options=None):
    return {
        "tier": tier,
        "messages": [{"role": "user", "content": "What is in this picture?" if image else "Explain photosynthesis."}],
        "image": image,
        "options": options or {"thinking": False, "max_new_tokens": 32},
    }


class KaggleApiTests(unittest.TestCase):
    def make_service(self, ns=None, runner=None, decoder=None, key="unit-test-secret"):
        return API.AriGpuApi(ns or namespace(), key, image_decoder=decoder or (lambda mime, raw: {"mime": mime, "bytes": raw}), generation_runner=runner)

    def serve(self, service):
        server = API.ThreadingHTTPServer(("127.0.0.1", 0), API._ari_gpu_api_handler(service))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def http(self, port, method, path, payload=None, token="unit-test-secret", headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        request_headers = dict(headers or {})
        if token is not None:
            request_headers["Authorization"] = "Bearer " + token
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        if body is not None:
            request_headers["Content-Type"] = "application/json"
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        try:
            return response.status, json.loads(data.decode("utf-8"))
        except Exception:
            return response.status, {}

    def test_secret_required_and_authenticates_health(self):
        with self.assertRaisesRegex(RuntimeError, "ARI_GPU_API_KEY"):
            API.AriGpuApi({}, "")
        service = self.make_service()
        port = self.serve(service)
        status, _ = self.http(port, "GET", "/health", token=None)
        self.assertEqual(status, 401)
        status, health = self.http(port, "GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(health["status"], "ok")
        self.assertTrue(health["tiers"]["medium"]["ready"])
        self.assertTrue(health["tiers"]["max"]["ready"])
        self.assertTrue(health["tiers"]["ultra"]["ready"])
        self.assertNotIn("unit-test-secret", json.dumps(health))

    def test_unknown_tier_and_malformed_requests(self):
        service = self.make_service(runner=lambda *args: "answer")
        with self.assertRaises(API.AriGpuApiError) as error:
            service.chat(sample_request("mini"))
        self.assertEqual(error.exception.status, 400)
        invalid = sample_request()
        invalid["messages"] = [{"role": "system", "content": "spoof"}]
        with self.assertRaises(API.AriGpuApiError):
            service.chat(invalid)
        invalid = sample_request()
        invalid["options"] = {"arbitrary_python": "no"}
        with self.assertRaises(API.AriGpuApiError):
            service.chat(invalid)
        status, _ = self.http(self.serve(service), "POST", "/wrong", {})
        self.assertEqual(status, 404)

    def test_qwen_text_and_gemma_text_responses(self):
        calls = []
        def runner(kind, model, processor, messages, options):
            calls.append((kind, model, processor, messages, options))
            return "A safe final answer."
        service = self.make_service(runner=runner)
        port = self.serve(service)
        status, qwen = self.http(port, "POST", "/v1/chat", sample_request("medium"))
        self.assertEqual(status, 200)
        self.assertEqual(qwen["model"], "Qwen/Qwen3-4B")
        self.assertEqual(qwen["reply"], "A safe final answer.")
        self.assertIn("You are Ari", calls[0][3][0]["content"])
        self.assertIn("Do not expose private or hidden reasoning", calls[0][3][0]["content"])
        status, gemma = self.http(port, "POST", "/v1/chat", sample_request("max"))
        self.assertEqual(status, 200)
        self.assertEqual(gemma["model"], "google/gemma-4-E2B-it")
        self.assertEqual(calls[0][0], "qwen")
        self.assertEqual(calls[1][0], "gemma")

    def test_identity_policy_is_first_system_message_and_answers_identity_as_ari(self):
        seen = []

        def runner(kind, model, processor, messages, options):
            seen.append(messages)
            system = messages[0]
            if system["role"] == "system" and "You are Ari, an AI assistant created by Zorex AI" in system["content"]:
                return "I'm Ari, an AI assistant created by Zorex AI."
            return "I'm Qwen."

        service = self.make_service(runner=runner)
        request = sample_request("medium")
        request["messages"] = [{"role": "user", "content": "Who are you?"}]
        response = service.chat(request)
        self.assertEqual(response["reply"], "I'm Ari, an AI assistant created by Zorex AI.")
        self.assertEqual(seen[0][0]["role"], "system")
        self.assertTrue(seen[0][0]["content"].startswith("You are Ari."))
        self.assertIn("Never introduce yourself as Qwen, Gemma, Alibaba Cloud, Google", seen[0][0]["content"])
        self.assertIn("never reveal or guess a creator's personal or legal name", seen[0][0]["content"])
        self.assertIn("never disclose numeric quotas", seen[0][0]["content"])
        self.assertIn("browser-local, isolated by the signed-in Google account", seen[0][0]["content"])
        self.assertIn("When open registration is enabled", seen[0][0]["content"])
        self.assertNotIn("invite-only", seen[0][0]["content"])
        self.assertEqual(seen[0][1], request["messages"][0])
        max_request = sample_request("max")
        max_request["messages"] = [{"role": "user", "content": "Who are you?"}]
        self.assertEqual(service.chat(max_request)["reply"], "I'm Ari, an AI assistant created by Zorex AI.")
        self.assertEqual(seen[1][0]["role"], "system")

    def test_medium_image_observer_then_qwen_final(self):
        calls = []
        def runner(kind, model, processor, messages, options):
            calls.append((kind, model, messages, options.copy()))
            return COMPLETE_OBSERVATION if kind == "gemma" else "The circle is to the left of the square."
        image = {"mime_type": "image/png", "data_base64": base64.b64encode(b"fake-image").decode("ascii")}
        service = self.make_service(runner=runner)
        request = sample_request("medium", image, options={"thinking": True, "max_new_tokens": 1024})
        request["messages"] = [
            {"role": "user", "content": "I am comparing these shapes."},
            {"role": "assistant", "content": "I can help compare what is visible."},
            {"role": "user", "content": "What is in this picture?"},
        ]
        status, data = self.http(self.serve(service), "POST", "/v1/chat", request)
        self.assertEqual(status, 200)
        self.assertEqual(data["route"], "qwen_with_gemma_e2b_observation")
        self.assertEqual([call[0] for call in calls], ["gemma", "qwen"])
        self.assertIn("What is in this picture?", calls[1][2][-1]["content"])
        self.assertIn("<untrusted_visual_observation>\n" + COMPLETE_OBSERVATION + "\n</untrusted_visual_observation>", calls[1][2][-1]["content"])
        self.assertIn("I am comparing these shapes.", calls[1][2][1]["content"])
        self.assertIn("I am comparing these shapes.", calls[0][2][1]["content"][1]["text"])
        self.assertIn("uncertainty, occlusion, and visual limitations", calls[0][2][0]["content"].lower())
        self.assertFalse(calls[0][3]["thinking"])
        self.assertEqual(calls[0][3]["max_new_tokens"], API.ARI_GPU_API_OBSERVER_MAX_NEW_TOKENS)
        self.assertTrue(calls[1][3]["thinking"])

    def test_incomplete_observation_fails_closed_without_calling_qwen(self):
        calls = []
        def runner(kind, *_args):
            calls.append(kind)
            return "A short report with only one apparent object." if kind == "gemma" else "This must never be returned."
        image = {"mime_type": "image/png", "data_base64": base64.b64encode(b"fake-image").decode("ascii")}
        service = self.make_service(runner=runner)
        with self.assertRaises(API.AriGpuApiError) as error:
            service.chat(sample_request("medium", image))
        self.assertEqual(error.exception.status, 502)
        self.assertIn("observation was incomplete", error.exception.message)
        self.assertEqual(calls, ["gemma"])
        self.assertNotIn("This must never be returned", error.exception.message)

    def test_max_and_ultra_use_their_own_models_for_images(self):
        used = []
        def runner(kind, model, processor, messages, options):
            used.append((kind, model.config._name_or_path))
            self.assertEqual(messages[-1]["content"][0]["type"], "image")
            return "Direct visual answer."
        image = {"mime_type": "image/jpeg", "data_base64": base64.b64encode(b"fake-image").decode("ascii")}
        service = self.make_service(runner=runner)
        self.assertEqual(service.chat(sample_request("max", image))["model"], "google/gemma-4-E2B-it")
        self.assertEqual(service.chat(sample_request("ultra", image))["model"], "google/gemma-4-E4B-it")
        self.assertEqual(used, [("gemma", "google/gemma-4-E2B-it"), ("gemma", "google/gemma-4-E4B-it")])
        self.assertNotIn("qwen", [kind for kind, _model in used], "Max and Ultra must never call Qwen for image input.")

    def test_max_text_uses_gemma_directly_and_never_calls_qwen(self):
        calls = []
        def runner(kind, model, _processor, _messages, options):
            calls.append((kind, model.config._name_or_path, options.copy()))
            return "Gemma's direct text answer."
        service = self.make_service(runner=runner)
        result = service.chat(sample_request("max", options={"thinking": True, "max_new_tokens": 32}))
        self.assertEqual(result["reply"], "Gemma's direct text answer.")
        self.assertEqual(result["route"], "gemma_text")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], "gemma")
        self.assertEqual(calls[0][1], "google/gemma-4-E2B-it")
        self.assertFalse(calls[0][2]["thinking"])

    def test_unavailable_e2b_and_ultra_are_not_substituted(self):
        service = self.make_service(namespace(include_e2b=False), runner=lambda *args: "answer")
        health = service.health()
        self.assertFalse(health["models"]["gemma4_e2b"]["available"])
        self.assertFalse(health["tiers"]["max"]["ready"])
        with self.assertRaises(API.AriGpuApiError) as error:
            service.chat(sample_request("max"))
        self.assertEqual(error.exception.status, 503)
        image = {"mime_type": "image/png", "data_base64": base64.b64encode(b"data").decode("ascii")}
        with self.assertRaises(API.AriGpuApiError) as error:
            service.chat(sample_request("medium", image))
        self.assertIn("E2B is not loaded", error.exception.message)

        no_ultra = self.make_service(namespace(include_e4b=False), runner=lambda *args: "answer")
        with self.assertRaises(API.AriGpuApiError) as error:
            no_ultra.chat(sample_request("ultra"))
        self.assertIn("E4B is not loaded", error.exception.message)

    def test_missing_qwen_disables_medium_but_does_not_disable_max(self):
        calls = []
        no_qwen = self.make_service(
            namespace(include_qwen=False),
            runner=lambda kind, model, _processor, _messages, _options: calls.append((kind, model.config._name_or_path)) or "Gemma Max answer.",
        )
        health = no_qwen.health()
        self.assertFalse(health["tiers"]["medium"]["ready"])
        self.assertTrue(health["tiers"]["max"]["ready"])
        with self.assertRaises(API.AriGpuApiError) as error:
            no_qwen.chat(sample_request("medium"))
        self.assertIn("Qwen3-4B is not loaded", error.exception.message)
        self.assertEqual(no_qwen.chat(sample_request("max"))["reply"], "Gemma Max answer.")
        self.assertEqual(calls, [("gemma", "google/gemma-4-E2B-it")])

    def test_image_validation_and_size_limits(self):
        service = self.make_service(runner=lambda *args: "answer")
        invalid_format = {"mime_type": "image/gif", "data_base64": base64.b64encode(b"bad").decode("ascii")}
        with self.assertRaises(API.AriGpuApiError) as error:
            service.chat(sample_request("ultra", invalid_format))
        self.assertEqual(error.exception.status, 400)
        invalid_base64 = {"mime_type": "image/png", "data_base64": "%%%"}
        with self.assertRaises(API.AriGpuApiError):
            service.chat(sample_request("ultra", invalid_base64))
        oversized = {"mime_type": "image/png", "data_base64": "A" * (((API.ARI_GPU_API_MAX_IMAGE_BYTES + 2) // 3) * 4 + 5)}
        with self.assertRaises(API.AriGpuApiError) as error:
            service.chat(sample_request("ultra", oversized))
        self.assertEqual(error.exception.status, 413)
        bad_image = {"mime_type": "image/png", "data_base64": base64.b64encode(b"not-an-image").decode("ascii")}
        decoding = self.make_service(decoder=lambda _mime, _raw: (_ for _ in ()).throw(ValueError("bad image")), runner=lambda *args: "answer")
        with self.assertRaises(ValueError):
            decoding._image_for(bad_image)

    def test_request_body_limit(self):
        service = self.make_service(runner=lambda *args: "answer")
        port = self.serve(service)
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        connection.request("POST", "/v1/chat", body=None, headers={
            "Authorization": "Bearer unit-test-secret",
            "Content-Length": str(API.ARI_GPU_API_MAX_BODY + 1),
        })
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        response.read()
        connection.close()

    def test_generation_is_serialized_and_empty_output_rejected(self):
        started = threading.Event()
        release = threading.Event()
        def runner(*args):
            started.set()
            release.wait(2)
            return "serialized answer"
        service = self.make_service(runner=runner)
        result = []
        thread = threading.Thread(target=lambda: result.append(service.chat(sample_request("medium"))))
        thread.start()
        self.assertTrue(started.wait(1))
        with self.assertRaises(API.AriGpuApiError) as error:
            service.chat(sample_request("ultra"))
        self.assertEqual(error.exception.status, 429)
        release.set()
        thread.join(2)
        self.assertEqual(result[0]["reply"], "serialized answer")

        empty = self.make_service(runner=lambda *args: " ")
        with self.assertRaises(API.AriGpuApiError) as error:
            empty.chat(sample_request("medium"))
        self.assertEqual(error.exception.status, 502)

    def test_qwen_thinking_parser_does_not_return_partial_reasoning(self):
        with self.assertRaises(API.AriGpuApiError) as error:
            API._ari_api_clean_qwen_text("<think>private reasoning", True, False)
        self.assertEqual(error.exception.status, 502)
        self.assertNotIn("private reasoning", error.exception.message)
        self.assertEqual(API._ari_api_clean_qwen_text("<think>private</think>Final answer", True, False), "Final answer")
        with self.assertRaises(API.AriGpuApiError):
            API._ari_api_clean_qwen_text("Final answer", False, True)

    def test_long_prompt_with_short_generation_does_not_hit_token_limit(self):
        ns = {
            "ARI_SYSTEM_PROMPT": "You are Ari.",
            "QWEN_MODEL": GeneratingFakeModel("Qwen/Qwen3-4B", [703, 704]),
            "QWEN_TOKENIZER": LongPromptQwenTokenizer("Qwen/Qwen3-4B"),
            "ARI_E2B_MODEL": GeneratingFakeModel("google/gemma-4-E2B-it", [903, 904]),
            "ARI_E2B_PROCESSOR": LongPromptGemmaProcessor("google/gemma-4-E2B-it"),
        }
        service = API.AriGpuApi(ns, "unit-test-secret")
        request = sample_request("medium", options={"thinking": False, "max_new_tokens": 4})
        request["options"] = {"max_new_tokens": 4}
        self.assertEqual(service.chat(request)["reply"], "Qwen parsed final.")
        self.assertFalse(ns["QWEN_TOKENIZER"].last_template_options["enable_thinking"])

        mode_calls = []
        mode_service = self.make_service(runner=lambda kind, model, processor, messages, options: mode_calls.append(options.copy()) or "Ari final answer.")
        normal = sample_request("medium", options={"max_new_tokens": 512})
        mode_service.chat(normal)
        self.assertFalse(mode_calls[-1]["thinking"])
        self.assertEqual(mode_calls[-1]["max_new_tokens"], 512)
        think = sample_request("medium", options={"thinking": True, "max_new_tokens": 1024})
        mode_service.chat(think)
        self.assertTrue(mode_calls[-1]["thinking"])
        self.assertEqual(mode_calls[-1]["max_new_tokens"], 1024)

        gemma_request = sample_request("max", options={"thinking": False, "max_new_tokens": 4})
        self.assertEqual(service.chat(gemma_request)["reply"], "Gemma parsed final.")

    def test_audio_routes_to_gemma_on_max_and_is_rejected_on_medium(self):
        observed = []
        service = self.make_service(
            runner=lambda kind, model, processor, messages, options: observed.append((kind, messages)) or "Gemma audio response."
        )
        audio_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        audio_path = audio_file.name
        audio_file.close()
        service._decode_audio_payload = lambda _payload: audio_path

        request = sample_request("max")
        request["audio"] = {"mime_type": "audio/wav", "data_base64": base64.b64encode(b"fixture").decode("ascii")}
        result = service.chat(request)
        self.assertEqual(result["reply"], "Gemma audio response.")
        self.assertEqual(result["route"], "gemma_audio")
        self.assertEqual(observed[0][0], "gemma")
        audio_part = observed[0][1][-1]["content"][-1]
        self.assertEqual(audio_part["type"], "audio")
        self.assertEqual(audio_part["url"], audio_path)
        self.assertFalse(os.path.exists(audio_path), "temporary audio must be deleted after inference")

        medium_request = sample_request("medium")
        medium_request["audio"] = request["audio"]
        with self.assertRaises(API.AriGpuApiError) as error:
            service.chat(medium_request)
        self.assertEqual(error.exception.status, 400)

    def test_real_adapter_shapes_use_notebook_generation_interfaces(self):
        ns = {
            "ARI_SYSTEM_PROMPT": "You are Ari.",
            "QWEN_MODEL": GeneratingFakeModel("Qwen/Qwen3-4B", [703, 2]),
            "QWEN_TOKENIZER": FakeQwenTokenizer("Qwen/Qwen3-4B"),
            "ARI_E2B_MODEL": GeneratingFakeModel("google/gemma-4-E2B-it", [903, 2]),
            "ARI_E2B_PROCESSOR": FakeGemmaProcessor("google/gemma-4-E2B-it"),
            "MODEL_ID": "google/gemma-4-E4B-it",
            "MODEL": GeneratingFakeModel("google/gemma-4-E4B-it", [904, 2]),
            "PROCESSOR": FakeGemmaProcessor("google/gemma-4-E4B-it"),
        }
        service = API.AriGpuApi(ns, "unit-test-secret")
        qwen = service.chat(sample_request("medium"))
        self.assertEqual(qwen["reply"], "Qwen parsed final.")
        self.assertFalse(ns["QWEN_TOKENIZER"].last_template_options["enable_thinking"])
        self.assertTrue(ns["QWEN_TOKENIZER"].last_template_options["return_dict"])
        ns["QWEN_MODEL"].output_ids = [501, 151668, 703, 2]
        thinking_request = sample_request("medium", options={"thinking": True, "max_new_tokens": 32})
        thinking = service.chat(thinking_request)
        self.assertEqual(thinking["reply"], "Qwen parsed final.")
        self.assertEqual(ns["QWEN_TOKENIZER"].last_template_options["enable_thinking"], True)
        self.assertEqual(ns["QWEN_MODEL"].last_generate_kwargs["temperature"], 0.6)
        ns["QWEN_MODEL"].output_ids = [501, 2]
        with self.assertRaises(API.AriGpuApiError) as error:
            service.chat(thinking_request)
        self.assertEqual(error.exception.status, 502)
        gemma = service.chat(sample_request("max"))
        self.assertEqual(gemma["reply"], "Gemma parsed final.")
        self.assertTrue(ns["ARI_E2B_PROCESSOR"].last_template_options["enable_thinking"] is False)
        self.assertIsNotNone(ns["ARI_E2B_PROCESSOR"].last_parse_prefix)
        gemma_thinking = service.chat(sample_request("max", options={"thinking": True, "max_new_tokens": 1024}))
        self.assertEqual(gemma_thinking["reply"], "Gemma parsed final.")
        self.assertFalse(ns["ARI_E2B_PROCESSOR"].last_template_options["enable_thinking"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
