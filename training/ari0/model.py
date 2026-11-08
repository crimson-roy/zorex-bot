"""Small decoder-only Transformer used for the Ari-0 from-scratch experiment."""

from dataclasses import asdict, dataclass

import torch
from torch import nn
from torch.nn import functional as F


@dataclass
class ModelConfig:
    vocab_size: int
    block_size: int = 64
    n_embd: int = 64
    n_head: int = 2
    n_layer: int = 2
    dropout: float = 0.1

    def validate(self) -> None:
        if self.vocab_size < 2:
            raise ValueError("The vocabulary must contain at least two tokens.")
        if self.block_size < 2:
            raise ValueError("block_size must be at least 2.")
        if self.n_embd < 4 or self.n_head < 1 or self.n_embd % self.n_head:
            raise ValueError("n_embd must be >= 4 and divisible by n_head.")
        if self.n_layer < 1:
            raise ValueError("n_layer must be at least 1.")
        if not 0 <= self.dropout < 1:
            raise ValueError("dropout must be in the range [0, 1).")


class TransformerBlock(nn.Module):
    def __init__(self, config: ModelConfig):
        super().__init__()
        self.attention_norm = nn.LayerNorm(config.n_embd)
        self.attention = nn.MultiheadAttention(
            embed_dim=config.n_embd,
            num_heads=config.n_head,
            dropout=config.dropout,
            batch_first=True,
        )
        self.feed_forward_norm = nn.LayerNorm(config.n_embd)
        self.feed_forward = nn.Sequential(
            nn.Linear(config.n_embd, 4 * config.n_embd),
            nn.GELU(),
            nn.Linear(4 * config.n_embd, config.n_embd),
            nn.Dropout(config.dropout),
        )

    def forward(self, values: torch.Tensor) -> torch.Tensor:
        length = values.size(1)
        causal_mask = torch.triu(
            torch.ones(length, length, dtype=torch.bool, device=values.device),
            diagonal=1,
        )
        normalized = self.attention_norm(values)
        attended, _ = self.attention(
            normalized, normalized, normalized,
            attn_mask=causal_mask, need_weights=False,
        )
        values = values + attended
        return values + self.feed_forward(self.feed_forward_norm(values))


class Ari0LanguageModel(nn.Module):
    def __init__(self, config: ModelConfig):
        super().__init__()
        config.validate()
        self.config = config
        self.token_embedding = nn.Embedding(config.vocab_size, config.n_embd)
        self.position_embedding = nn.Embedding(config.block_size, config.n_embd)
        self.embedding_dropout = nn.Dropout(config.dropout)
        self.blocks = nn.Sequential(*(TransformerBlock(config) for _ in range(config.n_layer)))
        self.final_norm = nn.LayerNorm(config.n_embd)
        self.lm_head = nn.Linear(config.n_embd, config.vocab_size, bias=False)
        self.lm_head.weight = self.token_embedding.weight
        self.apply(self._initialize)

    @staticmethod
    def _initialize(module: nn.Module) -> None:
        if isinstance(module, (nn.Linear, nn.Embedding)):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if isinstance(module, nn.Linear) and module.bias is not None:
                nn.init.zeros_(module.bias)

    def forward(self, token_ids: torch.Tensor, targets: torch.Tensor | None = None):
        if token_ids.ndim != 2:
            raise ValueError("token_ids must have shape [batch, sequence].")
        batch_size, length = token_ids.shape
        if length > self.config.block_size:
            raise ValueError(
                f"Sequence length {length} exceeds block_size {self.config.block_size}."
            )
        positions = torch.arange(length, device=token_ids.device)
        values = self.token_embedding(token_ids) + self.position_embedding(positions)[None, :, :]
        values = self.embedding_dropout(values)
        values = self.final_norm(self.blocks(values))
        logits = self.lm_head(values)

        loss = None
        if targets is not None:
            loss = F.cross_entropy(
                logits.reshape(batch_size * length, self.config.vocab_size),
                targets.reshape(batch_size * length),
            )
        return logits, loss

    @torch.no_grad()
    def generate(self, token_ids, max_new_tokens=200, temperature=0.9, top_k=40):
        if temperature <= 0:
            raise ValueError("temperature must be greater than zero.")
        self.eval()
        for _ in range(max_new_tokens):
            context = token_ids[:, -self.config.block_size:]
            logits, _ = self(context)
            next_logits = logits[:, -1, :] / temperature
            if 0 < top_k < next_logits.size(-1):
                cutoff = torch.topk(next_logits, top_k, dim=-1).values[:, -1, None]
                next_logits = next_logits.masked_fill(next_logits < cutoff, float("-inf"))
            probabilities = torch.softmax(next_logits, dim=-1)
            next_token = torch.multinomial(probabilities, num_samples=1)
            token_ids = torch.cat((token_ids, next_token), dim=1)
        return token_ids


def parameter_count(model: nn.Module) -> int:
    return sum(parameter.numel() for parameter in model.parameters() if parameter.requires_grad)


def config_to_dict(config: ModelConfig) -> dict:
    return asdict(config)
