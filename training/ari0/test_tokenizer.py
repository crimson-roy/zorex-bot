"""Unit tests for the Ari-0 hybrid tokenizer (Python standard library only)."""

import unittest

from tokenizer import HybridTokenizer


class HybridTokenizerTests(unittest.TestCase):
    def setUp(self):
        extra_words = " ".join(f"aardvark{index}" for index in range(50))
        self.text = (
            "<|user|>\nhello hello hello hello\n"
            "<|assistant|>\nhello there!\n<|end|>\n"
            "quasar uncommonword " + extra_words
        )
        self.tokenizer = HybridTokenizer.train(self.text, vocab_size=64)

    def test_round_trip_preserves_all_text_and_markers(self):
        encoded = self.tokenizer.encode(self.text)
        self.assertEqual(self.tokenizer.decode(encoded, skip_special=False), self.text)

    def test_frequent_word_is_a_single_token(self):
        self.assertEqual(len(self.tokenizer.encode("hello")), 1)

    def test_special_markers_are_atomic(self):
        self.assertEqual(len(self.tokenizer.encode("<|assistant|>")), 1)
        self.assertEqual(
            self.tokenizer.decode(self.tokenizer.encode("<|end|>"), skip_special=False),
            "<|end|>",
        )

    def test_rare_word_falls_back_to_characters(self):
        encoded = self.tokenizer.encode("quasar")
        self.assertGreater(len(encoded), 1)
        self.assertEqual(self.tokenizer.decode(encoded), "quasar")

    def test_checkpoint_data_can_rebuild_tokenizer(self):
        restored = HybridTokenizer.from_dict(self.tokenizer.to_dict())
        self.assertEqual(restored.encode(self.text), self.tokenizer.encode(self.text))

    def test_unseen_character_uses_unknown_token(self):
        encoded = self.tokenizer.encode("🪐")
        self.assertEqual(encoded, [self.tokenizer.unknown_id])


if __name__ == "__main__":
    unittest.main()
