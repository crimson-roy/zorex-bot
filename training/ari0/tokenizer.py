"""Hybrid whole-word plus character-fallback tokenizer for Ari-0."""

import re
from collections import Counter

SPECIAL_TOKENS = ("<unk>", "<|user|>", "<|assistant|>", "<|end|>")
TOKEN_PATTERN = re.compile(
    r"<\|(?:user|assistant|end)\|>|\w+(?:['’]\w+)*|\s+|[^\w\s]",
    re.UNICODE,
)
WORD_PATTERN = re.compile(r"\w+(?:['’]\w+)*\Z", re.UNICODE)


class HybridTokenizer:
    """Keep frequent words whole and fall back to characters for rare words."""

    def __init__(self, tokens):
        self.tokens = list(tokens)
        if self.tokens[:len(SPECIAL_TOKENS)] != list(SPECIAL_TOKENS):
            raise ValueError("Tokenizer is missing its required special tokens.")
        if len(set(self.tokens)) != len(self.tokens):
            raise ValueError("Tokenizer vocabulary contains duplicate tokens.")
        self.token_to_id = {token: index for index, token in enumerate(self.tokens)}
        self.word_tokens = {
            token for token in self.tokens if WORD_PATTERN.fullmatch(token)
        }
        self.unknown_id = self.token_to_id["<unk>"]
        self.end_id = self.token_to_id["<|end|>"]

    @classmethod
    def train(cls, text, vocab_size=4096):
        if not isinstance(text, str) or not text:
            raise ValueError("Tokenizer training text must be a non-empty string.")
        if vocab_size < len(SPECIAL_TOKENS) + 8:
            raise ValueError("vocab_size must leave room for special tokens and characters.")

        character_tokens = sorted(set(text))
        word_counts = Counter(
            match.group(0)
            for match in TOKEN_PATTERN.finditer(text)
            if WORD_PATTERN.fullmatch(match.group(0))
            and len(match.group(0)) > 1
        )

        remaining = max(0, vocab_size - len(SPECIAL_TOKENS) - len(character_tokens))
        frequent_words = [
            word for word, _ in sorted(
                word_counts.items(), key=lambda item: (-item[1], item[0])
            )[:remaining]
        ]
        return cls(list(SPECIAL_TOKENS) + character_tokens + frequent_words)

    @classmethod
    def from_dict(cls, data):
        if not isinstance(data, dict) or data.get("version") != 1:
            raise ValueError("Unsupported Ari-0 tokenizer format.")
        tokens = data.get("tokens")
        if not isinstance(tokens, list) or not all(isinstance(token, str) for token in tokens):
            raise ValueError("Checkpoint tokenizer vocabulary is invalid.")
        return cls(tokens)

    def to_dict(self):
        return {"version": 1, "tokens": self.tokens}

    def encode(self, text):
        if not isinstance(text, str):
            raise TypeError("Tokenizer input must be text.")
        encoded = []
        for match in TOKEN_PATTERN.finditer(text):
            piece = match.group(0)
            token_id = self.token_to_id.get(piece)
            if token_id is not None:
                encoded.append(token_id)
                continue
            for character in piece:
                encoded.append(self.token_to_id.get(character, self.unknown_id))
        return encoded

    def decode(self, token_ids, skip_special=True):
        parts = []
        special = set(SPECIAL_TOKENS)
        for token_id in token_ids:
            index = int(token_id)
            if index < 0 or index >= len(self.tokens):
                raise ValueError(f"Token ID out of range: {index}")
            token = self.tokens[index]
            if skip_special and token in special:
                continue
            parts.append(token)
        return "".join(parts)
