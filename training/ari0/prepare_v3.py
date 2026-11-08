"""Streaming data preparation for Ari-0 v3 (WikiText pretraining + OASST1 masks)."""
from __future__ import annotations

import argparse
import json
import sys
from array import array
from pathlib import Path

PARQUET_FILES = {
    "train": ["train-00000-of-00002.parquet", "train-00001-of-00002.parquet"],
    "validation": ["validation-00000-of-00001.parquet"],
    "test": ["test-00000-of-00001.parquet"],
}
SPECIAL_TOKENS = ["<unk>", "<|pad|>", "<|doc|>", "<|user|>", "<|assistant|>", "<|end|>"]


def prepare_wikitext(parquet_dir: Path, output_dir: Path, batch_size: int = 4096) -> dict:
    try:
        import pyarrow.parquet as pq
    except ImportError as error:
        raise RuntimeError("PyArrow is required. Install training/ari0/requirements.txt.") from error
    parquet_dir, output_dir = Path(parquet_dir), Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    summary = {}
    for split, filenames in PARQUET_FILES.items():
        target = output_dir / f"{split}.txt"
        rows = chars = 0
        with target.open("w", encoding="utf-8", newline="\n") as output:
            for filename in filenames:
                source = parquet_dir / filename
                if not source.is_file():
                    raise FileNotFoundError(f"Missing {split} Parquet shard: {source}")
                parquet_file = pq.ParquetFile(source)
                if "text" not in parquet_file.schema_arrow.names:
                    raise ValueError(f"Expected a 'text' column in {source}; found {parquet_file.schema_arrow.names}")
                for batch in parquet_file.iter_batches(batch_size=batch_size, columns=["text"]):
                    for value in batch.column(0).to_pylist():
                        value = "" if value is None else value
                        if not isinstance(value, str):
                            raise ValueError(f"Non-text value in {source}: {type(value).__name__}")
                        output.write(value)
                        chars += len(value)
                        if not value.endswith("\n"):
                            output.write("\n")
                            chars += 1
                        rows += 1
        if not rows:
            raise ValueError(f"No rows found in {split} split.")
        summary[split] = {"path": str(target), "rows": rows, "characters": chars, "bytes": target.stat().st_size}
    return summary


def train_bpe_tokenizer(train_text: Path, output_path: Path, vocab_size: int = 8192, min_frequency: int = 2) -> dict:
    try:
        from tokenizers import Tokenizer, decoders, models, pre_tokenizers, trainers
    except ImportError as error:
        raise RuntimeError("The tokenizers package is required. Install training/ari0/requirements.txt.") from error
    train_text, output_path = Path(train_text), Path(output_path)
    if not train_text.is_file():
        raise FileNotFoundError(f"Training text not found: {train_text}")
    if not 512 <= vocab_size <= 32767:
        raise ValueError("vocab-size must be between 512 and 32767 (the trainer stores IDs as int16).")
    tokenizer = Tokenizer(models.BPE(unk_token="<unk>"))
    tokenizer.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    tokenizer.decoder = decoders.ByteLevel()
    trainer = trainers.BpeTrainer(
        vocab_size=vocab_size, min_frequency=min_frequency, special_tokens=SPECIAL_TOKENS,
        initial_alphabet=pre_tokenizers.ByteLevel.alphabet(), show_progress=True,
    )
    tokenizer.train(files=[str(train_text)], trainer=trainer)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tokenizer.save(str(output_path))
    result = {
        "tokenizer_path": str(output_path),
        "vocab_size": tokenizer.get_vocab_size(),
        "special_tokens": {token: tokenizer.token_to_id(token) for token in SPECIAL_TOKENS},
    }
    output_path.with_suffix(output_path.suffix + ".json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def _write_ids(handle, ids: list[int]) -> None:
    values = array("H", ids)
    if values.itemsize != 2:
        raise RuntimeError("This platform does not support 16-bit unsigned arrays.")
    if sys.byteorder != "little":
        values.byteswap()
    values.tofile(handle)


def encode_text_file(text_path: Path, tokenizer_path: Path, output_path: Path) -> dict:
    try:
        from tokenizers import Tokenizer
    except ImportError as error:
        raise RuntimeError("The tokenizers package is required. Install training/ari0/requirements.txt.") from error
    text_path, tokenizer_path, output_path = map(Path, (text_path, tokenizer_path, output_path))
    if not text_path.is_file() or not tokenizer_path.is_file():
        raise FileNotFoundError("Both text input and tokenizer JSON must exist.")
    tokenizer = Tokenizer.from_file(str(tokenizer_path))
    if tokenizer.get_vocab_size() > 32767:
        raise ValueError("Tokenizer vocabulary exceeds the int16 token-ID limit.")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    doc_id = tokenizer.token_to_id("<|doc|>")
    with text_path.open("r", encoding="utf-8") as source, output_path.open("wb") as target:
        for line in source:
            ids = tokenizer.encode(line, add_special_tokens=False).ids
            if not line.strip() and doc_id is not None:
                ids.append(doc_id)
            _write_ids(target, ids)
            total += len(ids)
    if total < 258:
        raise ValueError(f"Not enough tokens in {text_path}; need at least 258 for the v3 context.")
    return {"input": str(text_path), "output": str(output_path), "tokens": total, "bytes": output_path.stat().st_size}


def encode_conversation_file(text_path: Path, tokenizer_path: Path, output_path: Path, mask_path: Path) -> dict:
    """Write token IDs plus a byte mask; only assistant-turn targets receive loss."""
    try:
        from tokenizers import Tokenizer
    except ImportError as error:
        raise RuntimeError("The tokenizers package is required. Install training/ari0/requirements.txt.") from error
    tokenizer = Tokenizer.from_file(str(Path(tokenizer_path)))
    output_path, mask_path = Path(output_path), Path(mask_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    mask_path.parent.mkdir(parents=True, exist_ok=True)
    total = assistant_total = 0
    train_assistant = False
    with Path(text_path).open("r", encoding="utf-8") as source, output_path.open("wb") as token_file, mask_path.open("wb") as mask_file:
        for line in source:
            marker = line.strip()
            if marker == "<|user|>":
                train_assistant = False
            elif marker == "<|assistant|>":
                train_assistant = True
            ids = tokenizer.encode(line, add_special_tokens=False).ids
            _write_ids(token_file, ids)
            mask_file.write(bytes([1 if train_assistant else 0]) * len(ids))
            total += len(ids)
            if train_assistant:
                assistant_total += len(ids)
            if marker == "<|end|>":
                train_assistant = False
    if total < 258 or not assistant_total:
        raise ValueError("Conversation corpus is too short or contains no assistant target tokens.")
    if output_path.stat().st_size != total * 2 or mask_path.stat().st_size != total:
        raise RuntimeError("Token and assistant-mask files are not aligned.")
    return {"tokens": total, "assistant_target_tokens": assistant_total,
            "token_file": str(output_path), "mask_file": str(mask_path)}


def main():
    parser = argparse.ArgumentParser(description="Prepare WikiText and OASST1 data for Ari-0 v3.")
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("prepare-wikitext")
    p.add_argument("--parquet-dir", type=Path, default=Path("data/datasets/wikitext103"))
    p.add_argument("--output-dir", type=Path, default=Path("data/processed/wikitext103"))
    p.add_argument("--batch-size", type=int, default=4096)
    p = commands.add_parser("train-tokenizer")
    p.add_argument("--train-text", type=Path, default=Path("data/processed/wikitext103/train.txt"))
    p.add_argument("--output", type=Path, default=Path("data/processed/ari0-v3/tokenizer.json"))
    p.add_argument("--vocab-size", type=int, default=8192)
    p.add_argument("--min-frequency", type=int, default=2)
    p = commands.add_parser("encode-text")
    p.add_argument("--text", type=Path, required=True)
    p.add_argument("--tokenizer", type=Path, default=Path("data/processed/ari0-v3/tokenizer.json"))
    p.add_argument("--output", type=Path, required=True)
    p = commands.add_parser("encode-conversations")
    p.add_argument("--text", type=Path, default=Path("data/processed/ari0/train.txt"))
    p.add_argument("--tokenizer", type=Path, default=Path("data/processed/ari0-v3/tokenizer.json"))
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--mask", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "prepare-wikitext":
        result = prepare_wikitext(args.parquet_dir, args.output_dir, args.batch_size)
    elif args.command == "train-tokenizer":
        result = train_bpe_tokenizer(args.train_text, args.output, args.vocab_size, args.min_frequency)
    elif args.command == "encode-text":
        result = encode_text_file(args.text, args.tokenizer, args.output)
    else:
        result = encode_conversation_file(args.text, args.tokenizer, args.output, args.mask)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (FileNotFoundError, ValueError, RuntimeError) as error:
        raise SystemExit(f"[Ari-0 v3 preparation] {error}") from error
