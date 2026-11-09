"""Local loopback inference bridge for Ari-0 v3, with v2 fallback."""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import torch

from model import Ari0LanguageModel, ModelConfig, parameter_count
from tokenizer import HybridTokenizer

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_V3_CHECKPOINT = ROOT / "models" / "ari" / "ari0-v3" / "checkpoint-finetune.pt"
DEFAULT_V2_CHECKPOINT = ROOT / "models" / "ari" / "ari0" / "checkpoint-hybrid-v2.pt"
HOST = os.environ.get("ARI0_HOST", "127.0.0.1")
PORT = int(os.environ.get("ARI0_PORT", "4174"))
MAX_BODY_BYTES = 32768
MAX_MESSAGES = 8
MAX_MESSAGE_CHARS = 2000
MAX_NEW_TOKENS = 128

MODEL_LOCK = threading.Lock()


def resolve_checkpoint():
    """Prefer the fine-tuned v3 checkpoint; retain v2 as a safe local fallback."""
    configured = os.environ.get("ARI0_CHECKPOINT")
    if configured:
        return Path(configured)
    if DEFAULT_V3_CHECKPOINT.is_file():
        return DEFAULT_V3_CHECKPOINT
    return DEFAULT_V2_CHECKPOINT


def _encode_ids(tokenizer, text):
    encoded = tokenizer.encode(text)
    return encoded.ids if hasattr(encoded, "ids") else list(encoded)


def _token_id(tokenizer, token):
    mapping = tokenizer.token_to_id
    value = mapping(token) if callable(mapping) else mapping.get(token)
    if value is None:
        raise ValueError(f"Tokenizer is missing required special token {token}.")
    return int(value)


def clean_message_text(value):
    text = str(value or "").strip()
    for marker in ("<|user|>", "<|assistant|>", "<|end|>"):
        text = text.replace(marker, " ")
    return text


def build_prompt(messages, tokenizer, block_size):
    """Encode recent chat turns and reserve room for Ari's assistant prefix."""
    if not isinstance(messages, list) or not messages:
        raise ValueError("At least one chat message is required.")
    if len(messages) > MAX_MESSAGES:
        messages = messages[-MAX_MESSAGES:]

    sections = []
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in ("user", "assistant"):
            raise ValueError("Each chat message must have a user or assistant role.")
        content = clean_message_text(message.get("content"))
        if not content:
            continue
        if len(content) > MAX_MESSAGE_CHARS:
            content = content[-MAX_MESSAGE_CHARS:]
        marker = "<|user|>" if message["role"] == "user" else "<|assistant|>"
        ending = "" if message["role"] == "user" else "<|end|>"
        sections.append(f"{marker}\n{content}\n{ending}\n")

    if not sections or messages[-1].get("role") != "user":
        raise ValueError("The latest message must be from the user.")

    assistant_prefix = _encode_ids(tokenizer, "<|assistant|>\n")
    available = block_size - len(assistant_prefix)
    if available < 1:
        raise ValueError("The model context window is too small for the assistant prefix.")

    history_tokens = _encode_ids(tokenizer, "".join(sections))
    return history_tokens[-available:] + assistant_prefix


class Ari0Inference:
    def __init__(self, checkpoint_path=None):
        self.checkpoint_path = Path(checkpoint_path) if checkpoint_path else resolve_checkpoint()
        self.model = None
        self.tokenizer = None
        self.step = None
        self.parameters = None
        self.model_name = None
        self.mode = None
        self.stop_ids = set()
        self.load_error = None
        self.device = torch.device("cpu")
        torch.set_num_threads(max(1, int(os.environ.get("ARI0_THREADS", "2"))))
        self._load()

    def _load(self):
        if not self.checkpoint_path.is_file():
            self.load_error = f"Checkpoint not found: {self.checkpoint_path}"
            print(f"[Ari-0 inference] {self.load_error}", file=sys.stderr, flush=True)
            return

        try:
            checkpoint = torch.load(
                self.checkpoint_path, map_location=self.device, weights_only=True
            )
            checkpoint_format = checkpoint.get("format")
            if checkpoint_format == "ari0-v3-bpe-transformer":
                if checkpoint.get("mode") != "finetune":
                    raise ValueError("The v3 inference checkpoint must be conversationally fine-tuned.")
                try:
                    from tokenizers import Tokenizer
                except ImportError as error:
                    raise RuntimeError(
                        "The tokenizers package is required to serve Ari-0 v3. "
                        "Install it with: python -m pip install tokenizers"
                    ) from error
                tokenizer = Tokenizer.from_str(checkpoint["tokenizer_json"])
                model_name = "Ari-0 BPE v3"
                self.mode = "fine-tuned"
            elif checkpoint_format == "ari0-hybrid-transformer-v2":
                tokenizer = HybridTokenizer.from_dict(checkpoint["tokenizer"])
                model_name = "Ari-0 Hybrid v2"
                self.mode = "hybrid"
            else:
                raise ValueError(f"Unsupported Ari-0 checkpoint format: {checkpoint_format}")

            for marker in ("<|user|>", "<|assistant|>", "<|end|>"):
                self.stop_ids.add(_token_id(tokenizer, marker)) if marker == "<|end|>" else _token_id(tokenizer, marker)

            config = ModelConfig(**checkpoint["config"])
            config.validate()
            if config.vocab_size != (
                tokenizer.get_vocab_size() if hasattr(tokenizer, "get_vocab_size") else len(tokenizer.tokens)
            ):
                raise ValueError("Checkpoint vocabulary size does not match its tokenizer.")
            model = Ari0LanguageModel(config).to(self.device)
            model.load_state_dict(checkpoint["model_state_dict"])
            model.eval()

            self.model = model
            self.tokenizer = tokenizer
            self.step = int(checkpoint.get("step", 0))
            self.parameters = parameter_count(model)
            self.model_name = model_name
            print(
                f"[Ari-0 inference] Loaded {model_name} checkpoint at step {self.step}; "
                f"{self.parameters:,} parameters; CPU.",
                flush=True,
            )
        except Exception as error:
            self.load_error = str(error)
            print(f"[Ari-0 inference] Could not load checkpoint: {error}", file=sys.stderr, flush=True)

    def health(self):
        return {
            "ok": True,
            "modelLoaded": self.model is not None,
            "model": self.model_name,
            "mode": self.mode,
            "step": self.step,
            "parameters": self.parameters,
            "device": "cpu",
            "error": self.load_error,
        }

    def generate(self, messages):
        if self.model is None or self.tokenizer is None:
            raise RuntimeError(self.load_error or "Ari-0 checkpoint is not loaded.")

        prompt_ids = build_prompt(
            messages, self.tokenizer, self.model.config.block_size
        )
        context = torch.tensor([prompt_ids], dtype=torch.long, device=self.device)

        with MODEL_LOCK, torch.inference_mode():
            generated = self.model.generate(
                context,
                max_new_tokens=MAX_NEW_TOKENS,
                temperature=0.8,
                top_k=40,
            )[0].tolist()

        new_ids = generated[len(prompt_ids):]
        output_ids = []
        for token_id in new_ids:
            if token_id in self.stop_ids:
                break
            output_ids.append(token_id)

        try:
            reply = self.tokenizer.decode(output_ids, skip_special_tokens=True).strip()
        except TypeError:
            reply = self.tokenizer.decode(output_ids, skip_special=True).strip()
        if not reply:
            reply = "…"
        return {
            "reply": reply,
            "model": self.model_name,
            "step": self.step,
        }


def make_handler(engine):
    class Handler(BaseHTTPRequestHandler):
        server_version = "Ari0LocalInference/2.0"

        def _send_json(self, status, payload):
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                self._send_json(200, engine.health())
                return
            self._send_json(404, {"error": "Not found."})

        def do_POST(self):
            if self.path != "/api/generate":
                self._send_json(404, {"error": "Not found."})
                return
            try:
                raw_length = self.headers.get("Content-Length", "")
                length = int(raw_length)
                if length < 1 or length > MAX_BODY_BYTES:
                    self._send_json(413, {"error": "Request body is too large or empty."})
                    return
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                messages = payload.get("messages") if isinstance(payload, dict) else None
                result = engine.generate(messages)
                self._send_json(200, result)
            except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
                self._send_json(400, {"error": str(error) or "Invalid JSON request."})
            except RuntimeError as error:
                self._send_json(503, {"error": str(error)})
            except Exception as error:
                print(f"[Ari-0 inference] Request failed: {error}", file=sys.stderr, flush=True)
                self._send_json(500, {"error": "Ari-0 could not generate a response."})

        def log_message(self, format_string, *args):
            print("[Ari-0 inference] " + (format_string % args), flush=True)

    return Handler


def main():
    checkpoint = resolve_checkpoint()
    engine = Ari0Inference(checkpoint)
    server = ThreadingHTTPServer((HOST, PORT), make_handler(engine))
    server.daemon_threads = True
    print(f"[Ari-0 inference] Local bridge listening at http://{HOST}:{PORT}", flush=True)
    print("[Ari-0 inference] This service accepts connections only through loopback.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
