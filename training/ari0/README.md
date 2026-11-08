# Ari-0: the from-scratch language-model experiment

Ari-0 is a small, decoder-only Transformer whose weights begin from random initialization. It is separate from Ari's Node.js chat server and existing maths and WordNet tools.

The first character-level checkpoint proved that the training loop and generation path work. The next experiment uses a **hybrid word-and-character tokenizer**: frequent words are represented as one token, while less common words fall back to characters. This keeps the vocabulary manageable without making unseen words impossible to encode.

## Data source

The initial experiment can use the locally prepared English portion of OpenAssistant Conversations (OASST1). The dataset is published under Apache-2.0. Keep its licence and attribution with any redistribution:

- https://huggingface.co/datasets/OpenAssistant/oasst1
- https://arxiv.org/abs/2304.07327

The repository's `npm run ari:prepare-oasst` step filters the ready-for-export trees and creates train/validation JSONL files. The next step formats those conversations with explicit `<|user|>`, `<|assistant|>` and `<|end|>` markers. Do not put downloaded datasets or generated corpora into Git.

OASST1 is a relatively small conversational dataset, not a broad pretraining corpus. A model trained only on it is expected to have limited vocabulary, knowledge and coherence. The goal at this stage is to learn the mechanics of training our own weights and measure whether loss improves. Better corpora, tokenizer improvements, more training and later instruction tuning are separate milestones.

## Requirements

Use Python 3.14 or another Python version currently supported by PyTorch on Windows. Install the CPU build; this project does not require an NVIDIA GPU.

~~~powershell
py -m venv .venv-ari0
.\.venv-ari0\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r training\ari0\requirements.txt --index-url https://download.pytorch.org/whl/cpu
~~~

Install the small tokenizer test dependency-free; it uses only Python's standard library.

## Prepare the corpus

From the repository root:

~~~powershell
npm run ari:prepare-oasst
npm run ari:prepare-ari0-corpus
~~~

This writes local-only files to `data/processed/ari0/train.txt` and `validation.txt`. If the filtered OASST1 JSONL files already exist, rerun only `npm run ari:prepare-ari0-corpus` to rebuild the role-marked Ari-0 text.

## Run tokenizer tests

~~~powershell
npm run ari:test-tokenizer
~~~

This checks exact text round-tripping, common-word tokens, character fallback, special conversation markers, checkpoint serialization and unknown-character handling.

## Train from random weights

~~~powershell
python training\ari0\train.py --steps 20 --eval-interval 10 --batch-size 4 --threads 2
~~~

The default settings are intentionally small: two Transformer blocks, two attention heads, 64 hidden dimensions, a 128-token context, a vocabulary target of 4,096 tokens and a modest batch size. The default run performs 200 training steps.

The hybrid model saves to `models/ari/ari0/checkpoint-hybrid-v2.pt`. This is a separate file from the first character-level checkpoint, so the original experiment is preserved.

## Generate a sample

~~~powershell
python training\ari0\generate.py
~~~

The default prompt supplies a user message followed by the assistant marker. Generation stops at the assistant end-of-turn marker if the model produces one. Output may still be repetitive or incoherent after a short run: this is a tiny randomly initialized experiment, not a pretrained large language model.

## Important distinctions

- The model architecture is implemented here, and model weights are initialized randomly. We are not loading another model's weights.
- OASST1 is an existing dataset with its own licence; using it does not make the dataset our original work.
- This experiment does not reproduce the capabilities of a modern 2B/7B+ model, and it is not yet connected to Ari's browser playground.
- Future work can improve subword segmentation, expand properly licensed corpora, test longer training schedules, add instruction tuning and evaluation, implement checkpoint resume, and build a local inference bridge.
