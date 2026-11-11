"""Tests for deterministic Ari-0 evaluation and checkpoint history."""

import csv
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import torch

from model import Ari0LanguageModel, ModelConfig
from train import append_history, estimate_loss, make_fixed_eval_batches


class Ari0EvaluationTests(unittest.TestCase):
    def setUp(self):
        self.data = torch.arange(4096, dtype=torch.long) % 16

    def test_fixed_batches_repeat_for_same_seed(self):
        first = make_fixed_eval_batches(self.data, 2, 16, 4, seed=20261108)
        second = make_fixed_eval_batches(self.data, 2, 16, 4, seed=20261108)
        self.assertEqual(len(first), 4)
        for (x1, y1), (x2, y2) in zip(first, second):
            self.assertTrue(torch.equal(x1, x2))
            self.assertTrue(torch.equal(y1, y2))

    def test_fixed_batches_change_for_different_seed(self):
        first = make_fixed_eval_batches(self.data, 2, 16, 4, seed=101)
        second = make_fixed_eval_batches(self.data, 2, 16, 4, seed=202)
        self.assertFalse(torch.equal(first[0][0], second[0][0]))

    def test_estimated_loss_is_repeatable_and_restores_training_mode(self):
        config = ModelConfig(
            vocab_size=16, block_size=16, n_embd=8, n_head=2, n_layer=1, dropout=0.0
        )
        model = Ari0LanguageModel(config)
        model.train()
        batches = {
            "train": make_fixed_eval_batches(self.data, 2, 16, 3, seed=1),
            "validation": make_fixed_eval_batches(self.data, 2, 16, 3, seed=2),
        }
        first = estimate_loss(model, batches, torch.device("cpu"))
        second = estimate_loss(model, batches, torch.device("cpu"))
        self.assertEqual(first, second)
        self.assertTrue(model.training)

    def test_history_records_and_replaces_same_last_step(self):
        args = SimpleNamespace(eval_batches=32, batch_size=4, eval_seed=20261108)
        losses = {"train": 2.4, "validation": 2.6}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "training-history.csv"
            append_history(path, 50000, losses, args, block_size=128)
            append_history(
                path, 50000,
                {"train": 2.3, "validation": 2.5},
                args, block_size=128,
            )
            append_history(
                path, 50100,
                {"train": 2.2, "validation": 2.4},
                args, block_size=128,
            )
            with path.open("r", encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["step"], "50000")
            self.assertEqual(rows[0]["validation_loss"], "2.50000000")
            self.assertEqual(rows[1]["step"], "50100")
            self.assertEqual(rows[1]["eval_batches"], "32")


if __name__ == "__main__":
    unittest.main()
