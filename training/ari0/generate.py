"""Generate text from a trained Ari-0 hybrid-token checkpoint."""

import argparse
from pathlib import Path

import torch

from model import Ari0LanguageModel, ModelConfig
from tokenizer import HybridTokenizer


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CHECKPOINT = ROOT / "models" / "ari" / "ari0" / "checkpoint-hybrid-v2.pt"


def parse_args():
    parser = argparse.ArgumentParser(description="Generate text with a trained Ari-0 checkpoint.")
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--prompt", default="<|user|>\nHello Ari\n<|assistant|>\n")
    parser.add_argument("--new-tokens", "--new-characters", dest="new_tokens", type=int, default=120)
    parser.add_argument("--temperature", type=float, default=0.8)
    parser.add_argument("--top-k", type=int, default=40)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    return parser.parse_args()


def main():
    args = parse_args()
    if not args.checkpoint.is_file():
        raise FileNotFoundError(f"Checkpoint not found: {args.checkpoint}. Train the hybrid Ari-0 model first.")
    if args.new_tokens < 1:
        raise ValueError("new-tokens must be positive.")
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but no CUDA-enabled GPU is available.")

    device = torch.device(
        "cuda" if args.device == "cuda" or (args.device == "auto" and torch.cuda.is_available())
        else "cpu"
    )
    checkpoint = torch.load(args.checkpoint, map_location=device, weights_only=True)
    if checkpoint.get("format") != "ari0-hybrid-transformer-v2":
        raise ValueError("This is not a hybrid-token Ari-0 checkpoint. The original character checkpoint is kept separately.")

    tokenizer = HybridTokenizer.from_dict(checkpoint["tokenizer"])
    config = ModelConfig(**checkpoint["config"])
    model = Ari0LanguageModel(config).to(device)
    model.load_state_dict(checkpoint["model_state_dict"])
    model.eval()

    encoded_prompt = tokenizer.encode(args.prompt)
    if not encoded_prompt:
        raise ValueError("The prompt produced no tokens.")
    context = torch.tensor([encoded_prompt], dtype=torch.long, device=device)
    generated = model.generate(
        context,
        max_new_tokens=args.new_tokens,
        temperature=args.temperature,
        top_k=args.top_k,
    )[0].tolist()

    generated_ids = generated[len(encoded_prompt):]
    if tokenizer.end_id in generated_ids:
        generated_ids = generated_ids[:generated_ids.index(tokenizer.end_id)]
    print(tokenizer.decode(generated_ids, skip_special=True))


if __name__ == "__main__":
    try:
        main()
    except (FileNotFoundError, ValueError, RuntimeError) as error:
        raise SystemExit(f"[Ari-0] {error}") from error
