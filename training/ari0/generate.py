"""Generate text from a trained Ari-0 checkpoint."""

import argparse
from pathlib import Path

import torch

from model import Ari0LanguageModel, ModelConfig


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CHECKPOINT = ROOT / "models" / "ari" / "ari0" / "checkpoint.pt"


def parse_args():
    parser = argparse.ArgumentParser(description="Generate text with a trained Ari-0 checkpoint.")
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--prompt", default="User: Hello Ari\nAssistant:")
    parser.add_argument("--new-characters", type=int, default=240)
    parser.add_argument("--temperature", type=float, default=0.8)
    parser.add_argument("--top-k", type=int, default=40)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    return parser.parse_args()


def main():
    args = parse_args()
    if not args.checkpoint.is_file():
        raise FileNotFoundError(f"Checkpoint not found: {args.checkpoint}. Train Ari-0 first.")
    if args.new_characters < 1:
        raise ValueError("new-characters must be positive.")
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but no CUDA-enabled GPU is available.")

    device = torch.device(
        "cuda" if args.device == "cuda" or (args.device == "auto" and torch.cuda.is_available())
        else "cpu"
    )
    checkpoint = torch.load(args.checkpoint, map_location=device, weights_only=True)
    if checkpoint.get("format") != "ari0-char-transformer-v1":
        raise ValueError("This checkpoint is not a supported Ari-0 model.")

    vocabulary = checkpoint["vocabulary"]
    token_to_id = {token: index for index, token in enumerate(vocabulary)}
    config = ModelConfig(**checkpoint["config"])
    model = Ari0LanguageModel(config).to(device)
    model.load_state_dict(checkpoint["model_state_dict"])
    model.eval()

    unknown_id = token_to_id["<unk>"]
    encoded_prompt = [token_to_id.get(character, unknown_id) for character in args.prompt]
    if not encoded_prompt:
        encoded_prompt = [unknown_id]
    context = torch.tensor([encoded_prompt], dtype=torch.long, device=device)
    generated = model.generate(
        context,
        max_new_tokens=args.new_characters,
        temperature=args.temperature,
        top_k=args.top_k,
    )[0].tolist()

    print("".join(vocabulary[index] for index in generated[len(encoded_prompt):]))


if __name__ == "__main__":
    try:
        main()
    except (FileNotFoundError, ValueError, RuntimeError) as error:
        raise SystemExit(f"[Ari-0] {error}") from error
