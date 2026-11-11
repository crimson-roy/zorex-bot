"""CPU-conscious, resumable Ari-0 v3 pretraining and assistant fine-tuning."""
from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path

import torch
import torch.nn.functional as F

from model import Ari0LanguageModel, ModelConfig, parameter_count

ROOT = Path(__file__).resolve().parents[2]
PRETRAIN_DIR = ROOT / "data" / "processed" / "wikitext103"
CHAT_DIR = ROOT / "data" / "processed" / "ari0-v3"
MODEL_DIR = ROOT / "models" / "ari" / "ari0-v3"
CHECKPOINT_FORMAT = "ari0-v3-bpe-transformer"


def load_token_stream(path: Path, mask: bool = False) -> torch.Tensor:
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"Token data not found: {path}")
    unit = 1 if mask else 2
    if path.stat().st_size % unit:
        raise ValueError(f"Invalid binary token file length: {path}")
    count = path.stat().st_size // unit
    if count < 258:
        raise ValueError(f"Token stream is too short for the 256-token context: {path}")
    dtype = torch.uint8 if mask else torch.int16
    return torch.from_file(str(path), shared=False, size=count, dtype=dtype)


def batch_from_starts(data, starts, block_size, device, mask_data=None):
    x = torch.stack([data[int(s):int(s) + block_size] for s in starts]).to(device=device, dtype=torch.long)
    y = torch.stack([data[int(s) + 1:int(s) + block_size + 1] for s in starts]).to(device=device, dtype=torch.long)
    mask = None
    if mask_data is not None:
        mask = torch.stack([mask_data[int(s) + 1:int(s) + block_size + 1] for s in starts]).to(device=device, dtype=torch.bool)
    return x, y, mask


def sample_batch(data, batch_size, block_size, device, mask_data=None, generator=None):
    maximum = data.numel() - block_size - 1
    if maximum < 1:
        raise ValueError("Token stream is shorter than the configured context window.")
    for _ in range(100):
        starts = torch.randint(0, maximum, (batch_size,), generator=generator)
        batch = batch_from_starts(data, starts, block_size, device, mask_data)
        if batch[2] is None or bool(batch[2].any()):
            return batch
    raise ValueError("Could not sample a conversation window containing assistant target tokens.")


def compute_loss(model, x, y, target_mask=None):
    logits, _ = model(x)
    per_token = F.cross_entropy(logits.reshape(-1, logits.size(-1)), y.reshape(-1), reduction="none")
    if target_mask is None:
        return per_token.mean()
    weights = target_mask.reshape(-1).to(dtype=per_token.dtype)
    denominator = weights.sum()
    if denominator.item() == 0:
        raise ValueError("This batch contains no assistant target tokens.")
    return (per_token * weights).sum() / denominator


def fixed_eval_batches(data, batch_size, block_size, batch_count, seed, device, mask_data=None):
    generator = torch.Generator(device="cpu")
    generator.manual_seed(seed)
    return [
        sample_batch(data, batch_size, block_size, device, mask_data, generator)
        for _ in range(batch_count)
    ]


@torch.no_grad()
def evaluate(model, batches):
    was_training = model.training
    model.eval()
    result = sum(float(compute_loss(model, x, y, mask).item()) for x, y, mask in batches) / len(batches)
    if was_training:
        model.train()
    return result


def append_history(path, row):
    path.parent.mkdir(parents=True, exist_ok=True)
    columns = ["mode", "step", "train_loss", "validation_loss", "eval_batches", "batch_size",
               "block_size", "learning_rate", "seed"]
    rows = []
    if path.is_file() and path.stat().st_size:
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames != columns:
                raise ValueError(f"History file has an unexpected format: {path}")
            rows = list(reader)
    if rows and rows[-1]["mode"] == row["mode"] and rows[-1]["step"] == str(row["step"]):
        rows[-1] = {key: str(value) for key, value in row.items()}
        temporary = path.with_suffix(path.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)
        temporary.replace(path)
    else:
        with path.open("a", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns)
            if not rows and path.stat().st_size == 0:
                writer.writeheader()
            writer.writerow(row)


def save_checkpoint(path, model, tokenizer_json, optimizer, mode, step, losses, args):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    torch.save({
        "format": CHECKPOINT_FORMAT, "mode": mode, "step": step,
        "config": model.config.__dict__, "tokenizer_json": tokenizer_json,
        "model_state_dict": model.state_dict(), "optimizer_state_dict": optimizer.state_dict(),
        "losses": losses,
        "training_settings": {"batch_size": args.batch_size, "block_size": model.config.block_size,
                              "eval_batches": args.eval_batches, "seed": args.seed,
                              "learning_rate": args.learning_rate},
    }, temporary)
    temporary.replace(path)


def cosine_learning_rate(base_lr, update, total_updates, warmup_steps, min_ratio):
    if warmup_steps and update <= warmup_steps:
        return base_lr * update / warmup_steps
    progress = min(1.0, max(0.0, (update - warmup_steps) / max(1, total_updates - warmup_steps)))
    return base_lr * (min_ratio + (1.0 - min_ratio) * 0.5 * (1.0 + math.cos(math.pi * progress)))


def parse_args():
    parser = argparse.ArgumentParser(description="Train Ari-0 v3 on WikiText, then fine-tune on OASST1.")
    parser.add_argument("--mode", choices=("pretrain", "finetune"), default="pretrain")
    parser.add_argument("--train-bin", type=Path, default=None)
    parser.add_argument("--validation-bin", type=Path, default=None)
    parser.add_argument("--train-mask", type=Path, default=None)
    parser.add_argument("--validation-mask", type=Path, default=None)
    parser.add_argument("--tokenizer", type=Path, default=CHAT_DIR / "tokenizer.json")
    parser.add_argument("--checkpoint", type=Path, default=None)
    parser.add_argument("--init-from", type=Path, default=None, help="Initialize fine-tuning from a pretraining checkpoint.")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--evaluate-only", action="store_true")
    parser.add_argument("--steps", type=int, default=1000, help="Additional optimizer updates.")
    parser.add_argument("--eval-interval", type=int, default=250)
    parser.add_argument("--eval-batches", type=int, default=32)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--block-size", type=int, default=256)
    parser.add_argument("--embedding-size", type=int, default=128)
    parser.add_argument("--heads", type=int, default=4)
    parser.add_argument("--layers", type=int, default=4)
    parser.add_argument("--dropout", type=float, default=0.1)
    parser.add_argument("--learning-rate", type=float, default=None)
    parser.add_argument("--warmup-steps", type=int, default=100)
    parser.add_argument("--min-lr-ratio", type=float, default=0.1)
    parser.add_argument("--weight-decay", type=float, default=0.1)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--seed", type=int, default=20261108)
    return parser.parse_args()


def main():
    args = parse_args()
    if min(args.steps, args.eval_interval, args.eval_batches, args.batch_size, args.threads) < 1:
        raise ValueError("steps, eval interval, eval batches, batch size and threads must be positive.")
    if args.warmup_steps < 0 or not 0 <= args.min_lr_ratio <= 1 or args.weight_decay < 0:
        raise ValueError("Invalid warmup, minimum learning-rate ratio or weight decay.")
    if args.resume and args.init_from:
        raise ValueError("Use --resume or --init-from, not both.")
    if args.evaluate_only and not args.resume:
        raise ValueError("--evaluate-only requires --resume.")
    if args.mode == "finetune" and not args.resume and not args.init_from:
        raise ValueError("A new fine-tuning run requires --init-from checkpoint-pretrain.pt.")
    if args.mode == "pretrain" and args.init_from:
        raise ValueError("--init-from is only used for fine-tuning.")
    args.learning_rate = args.learning_rate or (1e-4 if args.mode == "finetune" else 3e-4)
    if args.learning_rate <= 0:
        raise ValueError("learning-rate must be positive.")

    checkpoint_name = "checkpoint-pretrain.pt" if args.mode == "pretrain" else "checkpoint-finetune.pt"
    checkpoint_path = args.checkpoint or (MODEL_DIR / checkpoint_name)
    if not args.resume and checkpoint_path.exists():
        raise FileExistsError(f"Refusing to overwrite {checkpoint_path}; use --resume or choose another checkpoint.")

    if args.mode == "pretrain":
        args.train_bin = args.train_bin or PRETRAIN_DIR / "train.bin"
        args.validation_bin = args.validation_bin or PRETRAIN_DIR / "validation.bin"
    else:
        args.train_bin = args.train_bin or CHAT_DIR / "oasst1-train.bin"
        args.validation_bin = args.validation_bin or CHAT_DIR / "oasst1-validation.bin"
        args.train_mask = args.train_mask or CHAT_DIR / "oasst1-train.mask.bin"
        args.validation_mask = args.validation_mask or CHAT_DIR / "oasst1-validation.mask.bin"

    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads)
    device = torch.device("cpu")
    source = None
    start_step = 0
    if args.resume:
        if not checkpoint_path.is_file():
            raise FileNotFoundError(f"Checkpoint not found: {checkpoint_path}")
        source = torch.load(checkpoint_path, map_location=device, weights_only=True)
        if source.get("format") != CHECKPOINT_FORMAT or source.get("mode") != args.mode:
            raise ValueError("Checkpoint format or mode does not match this run.")
        tokenizer_json = source["tokenizer_json"]
    elif args.init_from:
        source = torch.load(args.init_from, map_location=device, weights_only=True)
        if source.get("format") != CHECKPOINT_FORMAT or source.get("mode") != "pretrain":
            raise ValueError("--init-from must be an Ari-0 v3 pretraining checkpoint.")
        tokenizer_json = source["tokenizer_json"]
    else:
        if not args.tokenizer.is_file():
            raise FileNotFoundError(f"Tokenizer not found: {args.tokenizer}. Run prepare_v3.py train-tokenizer first.")
        tokenizer_json = args.tokenizer.read_text(encoding="utf-8")

    try:
        from tokenizers import Tokenizer
    except ImportError as error:
        raise RuntimeError("Install the tokenizers package from training/ari0/requirements.txt.") from error
    tokenizer = Tokenizer.from_str(tokenizer_json)
    vocab_size = tokenizer.get_vocab_size()
    if source:
        config = ModelConfig(**source["config"])
    else:
        config = ModelConfig(vocab_size=vocab_size, block_size=args.block_size, n_embd=args.embedding_size,
                             n_head=args.heads, n_layer=args.layers, dropout=args.dropout)
    config.validate()
    if config.vocab_size != vocab_size:
        raise ValueError("Tokenizer vocabulary size does not match the checkpoint.")
    model = Ari0LanguageModel(config).to(device)
    if source:
        model.load_state_dict(source["model_state_dict"])
        if args.resume:
            start_step = int(source.get("step", 0))
        else:
            print(f"[Ari-0 v3] Initialized from {args.init_from}")

    train_data = load_token_stream(args.train_bin)
    validation_data = load_token_stream(args.validation_bin)
    train_mask = validation_mask = None
    if args.mode == "finetune":
        train_mask = load_token_stream(args.train_mask, mask=True)
        validation_mask = load_token_stream(args.validation_mask, mask=True)
        if train_mask.numel() != train_data.numel() or validation_mask.numel() != validation_data.numel():
            raise ValueError("Each conversation token file must match its assistant mask length.")
    if config.block_size < args.block_size:
        raise ValueError("Requested block-size exceeds the checkpoint context length.")

    train_eval = fixed_eval_batches(train_data, args.batch_size, config.block_size, args.eval_batches,
                                    args.seed + 1, device, train_mask)
    validation_eval = fixed_eval_batches(validation_data, args.batch_size, config.block_size, args.eval_batches,
                                         args.seed + 2, device, validation_mask)
    history_path = checkpoint_path.with_name(checkpoint_path.stem + "-history.csv")
    print(f"[Ari-0 v3] Mode: {args.mode}; device: CPU; parameters: {parameter_count(model):,}")
    print(f"[Ari-0 v3] Vocabulary: {vocab_size:,}; context: {config.block_size}; layers: {config.n_layer}; width: {config.n_embd}")
    print(f"[Ari-0 v3] Tokens: train {train_data.numel():,}; validation {validation_data.numel():,}")
    if train_mask is not None:
        print(f"[Ari-0 v3] Assistant target tokens: train {int(train_mask.sum()):,}; validation {int(validation_mask.sum()):,}")

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay)
    if args.resume and source.get("optimizer_state_dict"):
        optimizer.load_state_dict(source["optimizer_state_dict"])
        print("[Ari-0 v3] Optimizer state restored.")
    elif args.resume:
        print("[Ari-0 v3] No optimizer state found; starting a fresh optimizer.")

    losses = {"train": evaluate(model, train_eval), "validation": evaluate(model, validation_eval)}
    print(f"[Ari-0 v3] Fixed evaluation at step {start_step} | train {losses['train']:.4f} | validation {losses['validation']:.4f}")
    def record(step, lr):
        row = {"mode": args.mode, "step": step, "train_loss": f"{losses['train']:.8f}",
               "validation_loss": f"{losses['validation']:.8f}", "eval_batches": args.eval_batches,
               "batch_size": args.batch_size, "block_size": config.block_size,
               "learning_rate": f"{lr:.8g}", "seed": args.seed}
        append_history(history_path, row)
    record(start_step, args.learning_rate)
    if args.evaluate_only:
        print("[Ari-0 v3] Evaluation only; checkpoint weights were not changed.")
        return

    target_step = start_step + args.steps
    print(f"[Ari-0 v3] Planned updates: {start_step + 1} through {target_step}.")
    print("[Ari-0 v3] Start with a short CPU/temperature pilot before any long training run.")
    for local_step in range(1, args.steps + 1):
        global_step = start_step + local_step
        lr = cosine_learning_rate(args.learning_rate, local_step, args.steps, args.warmup_steps, args.min_lr_ratio)
        for group in optimizer.param_groups:
            group["lr"] = lr
        model.train()
        x, y, mask = sample_batch(train_data, args.batch_size, config.block_size, device, train_mask)
        loss = compute_loss(model, x, y, mask)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
        optimizer.step()
        if global_step % args.eval_interval == 0 or local_step == args.steps:
            losses = {"train": evaluate(model, train_eval), "validation": evaluate(model, validation_eval)}
            print(f"step {global_step:>7}/{target_step} | train {losses['train']:.4f} | validation {losses['validation']:.4f} | lr {lr:.2e}")
            record(global_step, lr)
            save_checkpoint(checkpoint_path, model, tokenizer_json, optimizer, args.mode,
                            global_step, losses, args)
    print(f"[Ari-0 v3] Checkpoint saved: {checkpoint_path}")
    print(f"[Ari-0 v3] History saved: {history_path}")


if __name__ == "__main__":
    try:
        main()
    except (FileNotFoundError, FileExistsError, ValueError, RuntimeError) as error:
        raise SystemExit(f"[Ari-0 v3] {error}") from error
