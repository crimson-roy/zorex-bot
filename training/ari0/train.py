"""Train or evaluate Ari-0's small hybrid-token Transformer."""

import argparse
import csv
import random
from pathlib import Path

import torch

from model import Ari0LanguageModel, ModelConfig, parameter_count
from tokenizer import HybridTokenizer


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS_DIR = ROOT / "data" / "processed" / "ari0"
DEFAULT_CHECKPOINT = ROOT / "models" / "ari" / "ari0" / "checkpoint-hybrid-v2.pt"
CHECKPOINT_FORMAT = "ari0-hybrid-transformer-v2"
EVALUATION_COLUMNS = [
    "step",
    "train_loss",
    "validation_loss",
    "eval_batches",
    "batch_size",
    "block_size",
    "eval_seed",
]


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


def make_fixed_eval_batches(
    data: torch.Tensor,
    batch_size: int,
    block_size: int,
    batch_count: int,
    seed: int,
):
    """Build a reproducible set of evaluation windows without changing training RNG."""
    if batch_count < 1:
        raise ValueError("eval-batches must be positive.")
    if data.numel() <= block_size + 1:
        raise ValueError("The selected corpus split is shorter than block_size + 2.")

    generator = torch.Generator(device="cpu")
    generator.manual_seed(seed)
    starts = torch.randint(
        0,
        data.numel() - block_size - 1,
        (batch_count, batch_size),
        generator=generator,
    )
    batches = []
    for row in starts:
        inputs = torch.stack([data[int(index):int(index) + block_size] for index in row])
        targets = torch.stack([
            data[int(index) + 1:int(index) + block_size + 1] for index in row
        ])
        batches.append((inputs, targets))
    return batches


@torch.no_grad()
def estimate_loss(model, evaluation_batches, device):
    was_training = model.training
    model.eval()
    results = {}
    for name, batches in evaluation_batches.items():
        losses = []
        for inputs, targets in batches:
            _, loss = model(inputs.to(device), targets.to(device))
            losses.append(float(loss.item()))
        results[name] = sum(losses) / len(losses)
    if was_training:
        model.train()
    return results


def append_history(path: Path, step: int, losses: dict, args, block_size: int):
    """Append one evaluation record; replace the last row if the same step is re-evaluated."""
    path.parent.mkdir(parents=True, exist_ok=True)
    row = {
        "step": step,
        "train_loss": f"{losses['train']:.8f}",
        "validation_loss": f"{losses['validation']:.8f}",
        "eval_batches": args.eval_batches,
        "batch_size": args.batch_size,
        "block_size": block_size,
        "eval_seed": args.eval_seed,
    }

    existing_rows = []
    if path.is_file() and path.stat().st_size:
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames != EVALUATION_COLUMNS:
                raise ValueError(
                    f"Evaluation history has an unexpected format: {path}. "
                    "Rename the old file before starting a new history."
                )
            existing_rows = list(reader)

    if existing_rows and existing_rows[-1].get("step") == str(step):
        existing_rows[-1] = {key: str(value) for key, value in row.items()}
        temporary = path.with_suffix(path.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=EVALUATION_COLUMNS)
            writer.writeheader()
            writer.writerows(existing_rows)
        temporary.replace(path)
        return

    write_header = not path.is_file() or path.stat().st_size == 0
    with path.open("a", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=EVALUATION_COLUMNS)
        if write_header:
            writer.writeheader()
        writer.writerow(row)


def save_checkpoint(path, model, tokenizer, optimizer, step, losses, evaluation_settings):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    torch.save(
        {
            "format": CHECKPOINT_FORMAT,
            "step": step,
            "config": model.config.__dict__,
            "tokenizer": tokenizer.to_dict(),
            "model_state_dict": model.state_dict(),
            "optimizer_state_dict": optimizer.state_dict(),
            "losses": losses,
            "evaluation_settings": evaluation_settings,
        },
        temporary_path,
    )
    temporary_path.replace(path)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Train, continue, or evaluate Ari-0's hybrid-token model."
    )
    parser.add_argument("--corpus-dir", type=Path, default=DEFAULT_CORPUS_DIR)
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--history", type=Path, default=None)
    parser.add_argument(
        "--steps", type=int, default=200,
        help="Number of additional optimizer updates to perform (default: 200).",
    )
    parser.add_argument(
        "--resume", action="store_true",
        help="Continue from the checkpoint instead of starting with random weights.",
    )
    parser.add_argument(
        "--evaluate-only", action="store_true",
        help="Evaluate the saved checkpoint on fixed samples without changing its weights.",
    )
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--block-size", type=int, default=128)
    parser.add_argument("--embedding-size", type=int, default=64)
    parser.add_argument("--heads", type=int, default=2)
    parser.add_argument("--layers", type=int, default=2)
    parser.add_argument("--vocab-size", type=int, default=4096)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--eval-interval", type=int, default=100)
    parser.add_argument("--eval-batches", type=int, default=32)
    parser.add_argument("--eval-seed", type=int, default=20261108)
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
    if args.evaluate_only and not args.resume:
        raise ValueError("--evaluate-only requires --resume to load an existing checkpoint.")

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads)

    train_text = read_text(args.corpus_dir / "train.txt")
    validation_text = read_text(args.corpus_dir / "validation.txt")

    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but no CUDA-enabled GPU is available.")
    device = torch.device(
        "cuda" if args.device == "cuda" or (args.device == "auto" and torch.cuda.is_available())
        else "cpu"
    )

    checkpoint = None
    start_step = 0
    if args.resume:
        if not args.checkpoint.is_file():
            raise FileNotFoundError(
                f"Cannot load checkpoint: {args.checkpoint}. "
                "Run training without --resume first."
            )
        checkpoint = torch.load(args.checkpoint, map_location=device, weights_only=True)
        if checkpoint.get("format") != CHECKPOINT_FORMAT:
            raise ValueError("Resume requires an Ari-0 hybrid-token v2 checkpoint.")
        tokenizer = HybridTokenizer.from_dict(checkpoint["tokenizer"])
        config = ModelConfig(**checkpoint["config"])
        config.validate()
        model = Ari0LanguageModel(config).to(device)
        model.load_state_dict(checkpoint["model_state_dict"])
        start_step = int(checkpoint.get("step", 0))
        print(f"[Ari-0] Loaded hybrid checkpoint from step {start_step}.")
    else:
        tokenizer = HybridTokenizer.train(train_text, vocab_size=args.vocab_size)
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
        print("[Ari-0] Training a new hybrid-token model from random initial weights.")

    train_data = encode_text(train_text, tokenizer)
    validation_data = encode_text(validation_text, tokenizer)

    evaluation_batches = {
        "train": make_fixed_eval_batches(
            train_data, args.batch_size, model.config.block_size,
            args.eval_batches, args.eval_seed,
        ),
        "validation": make_fixed_eval_batches(
            validation_data, args.batch_size, model.config.block_size,
            args.eval_batches, args.eval_seed + 1,
        ),
    }
    history_path = args.history or args.checkpoint.with_name("training-history.csv")

    print(f"[Ari-0] Device: {device}; parameters: {parameter_count(model):,}")
    print(f"[Ari-0] Vocabulary: {len(tokenizer.tokens):,} tokens")
    print(f"[Ari-0] Encoded tokens: training {train_data.numel():,}; validation {validation_data.numel():,}")
    print(f"[Ari-0] Fixed evaluation: {args.eval_batches} batches per split; seed {args.eval_seed}.")
    print(f"[Ari-0] Evaluation history: {history_path}")

    if args.evaluate_only:
        losses = estimate_loss(model, evaluation_batches, device)
        print(
            f"[Ari-0] Fixed benchmark at step {start_step} | "
            f"train loss {losses['train']:.4f} | "
            f"validation loss {losses['validation']:.4f}"
        )
        append_history(history_path, start_step, losses, args, model.config.block_size)
        print("[Ari-0] Evaluation complete. Model weights and checkpoint were not changed.")
        return

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate)
    if args.resume:
        optimizer_state = checkpoint.get("optimizer_state_dict")
        if optimizer_state:
            optimizer.load_state_dict(optimizer_state)
            for group in optimizer.param_groups:
                group["lr"] = args.learning_rate
            print("[Ari-0] Optimizer state restored.")
        else:
            print(
                "[Ari-0] This checkpoint has no optimizer state. "
                "Model weights are restored; AdamW starts with fresh optimizer state."
            )

    baseline_losses = estimate_loss(model, evaluation_batches, device)
    append_history(
        history_path, start_step, baseline_losses, args, model.config.block_size
    )
    print(
        f"[Ari-0] Fixed benchmark at step {start_step} | "
        f"train loss {baseline_losses['train']:.4f} | "
        f"validation loss {baseline_losses['validation']:.4f}"
    )

    target_step = start_step + args.steps
    print(f"[Ari-0] Planned updates: {start_step + 1} through {target_step}.")
    print("[Ari-0] This is still a small language-model experiment, not a capable assistant yet.")

    latest_losses = baseline_losses
    evaluation_settings = {
        "eval_batches": args.eval_batches,
        "batch_size": args.batch_size,
        "eval_seed": args.eval_seed,
        "block_size": model.config.block_size,
    }
    for update in range(1, args.steps + 1):
        global_step = start_step + update
        model.train()
        inputs, targets = make_batch(
            train_data, args.batch_size, model.config.block_size, device
        )
        _, loss = model(inputs, targets)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
        optimizer.step()

        if global_step % args.eval_interval == 0 or update == args.steps:
            latest_losses = estimate_loss(model, evaluation_batches, device)
            print(
                f"step {global_step:>7}/{target_step} | "
                f"train loss {latest_losses['train']:.4f} | "
                f"validation loss {latest_losses['validation']:.4f}"
            )
            append_history(
                history_path, global_step, latest_losses, args, model.config.block_size
            )
            save_checkpoint(
                args.checkpoint, model, tokenizer, optimizer,
                global_step, latest_losses, evaluation_settings,
            )

    print(f"[Ari-0] Checkpoint saved to: {args.checkpoint}")
    print(f"[Ari-0] Evaluation history saved to: {history_path}")


if __name__ == "__main__":
    try:
        main()
    except (FileNotFoundError, ValueError, RuntimeError) as error:
        raise SystemExit(f"[Ari-0] {error}") from error
