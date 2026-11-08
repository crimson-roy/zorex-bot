"""Local HTTP inference bridge for the Ari-0 hybrid-token checkpoint."""

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
DEFAULT_CHECKPOINT = ROOT / "models" / "ari" / "ari0" / "checkpoint-hybrid-v2.pt"
HOST = os.environ.get("ARI0_HOST", "127.0.0.1")
PORT = int(os.environ.get("ARI0_PORT", "4174"))
MAX_BODY_BYTES = 32768
MAX_MESSAGES = 8
MAX_MESSAGE_CHARS = 2000
MAX_NEW_TOKENS = 96

MODEL_LOCK = threading.Lock()


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

    assistant_prefix = tokenizer.encode("<|assistant|>\n")
    available = block_size - len(assistant_prefix)
    if available < 1:
        raise ValueError("The model context window is too small for the assistant prefix.")

    history_tokens = tokenizer.encode("".join(sections))
    return history_tokens[-available:] + assistant_prefix


class Ari0Inference:
    def __init__(self, checkpoint_path):
        self.checkpoint_path = Path(checkpoint_path)
        self.model = None
        self.tokenizer = None
        self.step = None
        self.parameters = None
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
            if checkpoint.get("format") != "ari0-hybrid-transformer-v2":
                raise ValueError("Checkpoint is not an Ari-0 hybrid-token v2 model.")

            tokenizer = HybridTokenizer.from_dict(checkpoint["tokenizer"])
            config = ModelConfig(**checkpoint["config"])
            config.validate()
            model = Ari0LanguageModel(config).to(self.device)
            model.load_state_dict(checkpoint["model_state_dict"])
            model.eval()

            self.model = model
            self.tokenizer = tokenizer
            self.step = int(checkpoint.get("step", 0))
            self.parameters = parameter_count(model)
            print(
                f"[Ari-0 inference] Loaded checkpoint at step {self.step}; "
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
            "model": "Ari-0 Hybrid v2" if self.model is not None else None,
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
        stop_ids = {
            self.tokenizer.token_to_id["<|end|>"],
            self.tokenizer.token_to_id["<|user|>"],
            self.tokenizer.token_to_id["<|assistant|>"],
        }
        output_ids = []
        for token_id in new_ids:
            if token_id in stop_ids:
                break
            output_ids.append(token_id)

        reply = self.tokenizer.decode(output_ids, skip_special=True).strip()
        if not reply:
            reply = "…" 
        return {
            "reply": reply,
            "model": "Ari-0 Hybrid v2",
            "step": self.step,
        }


def make_handler(engine):
    class Handler(BaseHTTPRequestHandler):
        server_version = "Ari0LocalInference/1.0"

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
    checkpoint = Path(os.environ.get("ARI0_CHECKPOINT", str(DEFAULT_CHECKPOINT)))
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
