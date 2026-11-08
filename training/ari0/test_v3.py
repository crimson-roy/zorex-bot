"""Unit tests for Ari-0 v3 token preparation and assistant-only loss."""
import tempfile
import unittest
from pathlib import Path

import torch
from model import Ari0LanguageModel, ModelConfig
from prepare_v3 import encode_conversation_file, encode_text_file, train_bpe_tokenizer
from train_v3 import compute_loss, load_token_stream, sample_batch


class Ari0V3Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def make_tokenizer(self):
        source = self.root / "small.txt"
        source.write_text(("The ocean contains life. Mathematics helps people reason.\n" * 120), encoding="utf-8")
        output = self.root / "tokenizer.json"
        result = train_bpe_tokenizer(source, output, vocab_size=512)
        self.assertIsNotNone(result["special_tokens"]["<|assistant|>"])
        return output

    def test_text_encoder_writes_memory_mappable_int16(self):
        tokenizer = self.make_tokenizer()
        source = self.root / "tiny.txt"
        source.write_text(("A tiny language model learns from text.\n\n" * 50), encoding="utf-8")
        output = self.root / "tiny.bin"
        result = encode_text_file(source, tokenizer, output)
        self.assertEqual(output.stat().st_size, result["tokens"] * 2)
        self.assertEqual(load_token_stream(output).numel(), result["tokens"])

    def test_conversation_encoder_masks_only_assistant_turn(self):
        tokenizer = self.make_tokenizer()
        source = self.root / "chat.txt"
        source.write_text(("<|user|>\nHello Ari.\n<|assistant|>\nHello there.\n<|end|>\n" * 20), encoding="utf-8")
        tokens, mask = self.root / "chat.bin", self.root / "chat.mask.bin"
        result = encode_conversation_file(source, tokenizer, tokens, mask)
        ids, flags = load_token_stream(tokens), load_token_stream(mask, mask=True)
        self.assertEqual(ids.numel(), flags.numel())
        self.assertGreater(result["assistant_target_tokens"], 0)
        self.assertLess(int(flags.sum()), flags.numel())

    def test_masked_loss_ignores_unselected_labels(self):
        torch.manual_seed(5)
        model = Ari0LanguageModel(ModelConfig(vocab_size=16, block_size=4, n_embd=8, n_head=2, n_layer=1, dropout=0.0))
        x = torch.tensor([[1, 2, 3]])
        mask = torch.tensor([[True, False, True]])
        first = compute_loss(model, x, torch.tensor([[4, 5, 6]]), mask)
        second = compute_loss(model, x, torch.tensor([[4, 9, 6]]), mask)
        self.assertTrue(torch.allclose(first, second))

    def test_masked_sampler_returns_assistant_positions(self):
        data = torch.arange(4096, dtype=torch.int16)
        mask = torch.zeros(4096, dtype=torch.uint8)
        mask[100:300] = 1
        x, y, targets = sample_batch(data, 2, 32, torch.device("cpu"), mask,
                                     torch.Generator().manual_seed(2))
        self.assertEqual(tuple(x.shape), (2, 32))
        self.assertEqual(tuple(y.shape), (2, 32))
        self.assertTrue(bool(targets.any()))


if __name__ == "__main__":
    unittest.main()
