"""Train Ari-0's small hybrid-token Transformer from random weights."""

import argparse
import random
from pathlib import Path

import torch

from model import Ari0LanguageModel, ModelConfig, parameter_count
from tokenizer import HybridTokenizer


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS_DIR = ROOT / "data" / "processed" / "ari0"
DEFAULT_CHECKPOINT = ROOT / "models" / "ari" / "ari0" / "checkpoint-hybrid-v2.pt"


def read_text(path: Path) -> str:
    if not path.is_file():
        raise FileNotFoundError(f"Corpus file not found: {path}")
    text = path.read_text(encoding="utf-8")
    if len(text.strip()) < 200:
        raise ValueError(f"{path} contains too little text. Prepare the OASST1 corpus first.")
    return text


def encode_text(text: str, tokenizer: HybridTokenizer) -> torch.Tensor:
    return torch.tensor(tokenizer.encode(text), dtype=torch.long)


def make_batch(data: torch.Tensor, batch_size: int, block_size: int, device: torch.device):
    if data.numel() <= block_size + 1:
        raise ValueError("The selected corpus split is shorter than block_size + 2.")
    starts = torch.randint(0, data.numel() - block_size - 1, (batch_size,))
    inputs = torch.stack([data[index:index + block_size] for index in starts])
    targets = torch.stack([data[index + 1:index + block_size + 1] for index in starts])
    return inputs.to(device), targets.to(device)


@torch.no_grad()
def estimate_loss(model, train_data, validation_data, args, device):
    model.eval()
    results = {}
    for name, data in (("train", train_data), ("validation", validation_data)):
        losses = []
        for _ in range(args.eval_batches):
            inputs, targets = make_batch(data, args.batch_size, args.block_size, device)
            _, loss = model(inputs, targets)
            losses.append(float(loss.item()))
        results[name] = sum(losses) / len(losses)
    model.train()
    return results


def save_checkpoint(path: Path, model, config, tokenizer, step, losses):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    torch.save(
        {
            "format": "ari0-hybrid-transformer-v2",
            "step": step,
            "config": config.__dict__,
            "tokenizer": tokenizer.to_dict(),
            "model_state_dict": model.state_dict(),
            "losses": losses,
        },
        temporary_path,
    )
    temporary_path.replace(path)


def parse_args():
    parser = argparse.ArgumentParser(description="Train Ari-0 from random initial weights.")
    parser.add_argument("--corpus-dir", type=Path, default=DEFAULT_CORPUS_DIR)
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--steps", type=int, default=200)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--block-size", type=int, default=128)
    parser.add_argument("--embedding-size", type=int, default=64)
    parser.add_argument("--heads", type=int, default=2)
    parser.add_argument("--layers", type=int, default=2)
    parser.add_argument("--vocab-size", type=int, default=4096)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--eval-interval", type=int, default=50)
    parser.add_argument("--eval-batches", type=int, default=8)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    return parser.parse_args()


def main():
    args = parse_args()
    if args.steps < 1 or args.batch_size < 1 or args.eval_interval < 1:
        raise ValueError("steps, batch-size and eval-interval must be positive.")
    if args.threads < 1 or args.eval_batches < 1:
        raise ValueError("threads and eval-batches must be positive.")

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads)

    train_text = read_text(args.corpus_dir / "train.txt")
    validation_text = read_text(args.corpus_dir / "validation.txt")
    tokenizer = HybridTokenizer.train(train_text, vocab_size=args.vocab_size)
    train_data = encode_text(train_text, tokenizer)
    validation_data = encode_text(validation_text, tokenizer)

    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but no CUDA-enabled GPU is available.")
    device = torch.device(
        "cuda" if args.device == "cuda" or (args.device == "auto" and torch.cuda.is_available())
        else "cpu"
    )

    config = ModelConfig(
        vocab_size=len(tokenizer.tokens),
        block_size=args.block_size,
        n_embd=args.embedding_size,
        n_head=args.heads,
        n_layer=args.layers,
        dropout=0.1,
    )
    config.validate()
    model = Ari0LanguageModel(config).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate)

    print("[Ari-0] Training a new hybrid-token model from random initial weights.")
    print(f"[Ari-0] Device: {device}; parameters: {parameter_count(model):,}")
    print(f"[Ari-0] Vocabulary: {len(tokenizer.tokens):,} tokens")
    print(f"[Ari-0] Encoded tokens: training {train_data.numel():,}; validation {validation_data.numel():,}")
    print(f"[Ari-0] Context window: {args.block_size} tokens; frequent words are single tokens.")
    print("[Ari-0] This is still a small language-model experiment, not a capable assistant yet.")

    latest_losses = {}
    for step in range(1, args.steps + 1):
        model.train()
        inputs, targets = make_batch(train_data, args.batch_size, args.block_size, device)
        _, loss = model(inputs, targets)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
        optimizer.step()

        if step == 1 or step % args.eval_interval == 0 or step == args.steps:
            latest_losses = estimate_loss(model, train_data, validation_data, args, device)
            print(
                f"step {step:>5}/{args.steps} | "
                f"train loss {latest_losses['train']:.4f} | "
                f"validation loss {latest_losses['validation']:.4f}"
            )
            save_checkpoint(args.checkpoint, model, config, tokenizer, step, latest_losses)

    print(f"[Ari-0] Checkpoint saved to: {args.checkpoint}")


if __name__ == "__main__":
    try:
        main()
    except (FileNotFoundError, ValueError, RuntimeError) as error:
        raise SystemExit(f"[Ari-0] {error}") from error
