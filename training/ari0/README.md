# Ari-0: the from-scratch language-model experiment

Ari-0 is a small, decoder-only Transformer whose weights begin from random initialization. It is separate from Ari's Node.js chat server and existing maths and WordNet tools.

The first character-level checkpoint proved that the training loop and generation path work. The next experiment uses a **hybrid word-and-character tokenizer**: frequent words are represented as one token, while less common words fall back to characters. This keeps the vocabulary manageable without making unseen words impossible to encode.

## Data source

The initial experiment can use the locally prepared English portion of OpenAssistant Conversations (OASST1). The dataset is published under Apache-2.0. Keep its licence and attribution with any redistribution:

- https://huggingface.co/datasets/OpenAssistant/oasst1
- https://arxiv.org/abs/2304.07327

The repository's \`npm run ari:prepare-oasst\` step filters the ready-for-export trees and creates train/validation JSONL files. The next step formats those conversations with explicit \`<|user|>\`, \`<|assistant|>\` and \`<|end|>\` markers. Do not put downloaded datasets or generated corpora into Git.

OASST1 is a relatively small conversational dataset, not a broad pretraining corpus. A model trained only on it is expected to have limited vocabulary, knowledge and coherence. The goal at this stage is to learn the mechanics of training our own weights and measure whether loss improves. Better corpora, tokenizer improvements, more training and later instruction tuning are separate milestones.

## Requirements

Use Python 3.14 or another Python version currently supported by PyTorch on Windows. Install the CPU build; this project does not require an NVIDIA GPU.

~~~powershell
py -m venv .venv-ari0
.\.venv-ari0\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r training\ari0\requirements.txt --index-url https://download.pytorch.org/whl/cpu
~~~

Install the small tokenizer test dependency-free; the tokenizer tests use Python's standard library.

## Prepare the corpus

From the repository root:

~~~cmd
npm run ari:prepare-oasst
npm run ari:prepare-ari0-corpus
~~~

This writes local-only files to \`data/processed/ari0/train.txt\` and \`validation.txt\`. If the filtered OASST1 JSONL files already exist, rerun only \`npm run ari:prepare-ari0-corpus\` to rebuild the role-marked Ari-0 text.

## Run tests

~~~cmd
npm run ari:test-tokenizer
npm run ari:test-training
~~~

These test round-tripping, common-word tokens, character fallback, special conversation markers, checkpoint tokenizer serialization, fixed evaluation samples, repeatable loss calculation and local CSV history writing.

## Evaluation benchmark

The trainer now uses fixed training and validation samples. The same samples are reused every time, so loss comparisons are not distorted by drawing a different random set of validation batches at each evaluation. The default is 32 fixed batches per split, with a stable evaluation seed.

Evaluate the existing checkpoint without changing its weights:

~~~cmd
python training\ari0\train.py --resume --evaluate-only --eval-batches 32 --batch-size 4 --threads 2
~~~

This prints a fixed benchmark for the saved checkpoint and writes the result to \`models/ari/ari0/training-history.csv\`. The checkpoint itself is not modified.

## Train from random weights

~~~cmd
python training\ari0\train.py --steps 20 --eval-interval 100 --batch-size 4 --threads 2
~~~

The default settings are intentionally small: two Transformer blocks, two attention heads, 64 hidden dimensions, a 128-token context, a vocabulary target of 4,096 tokens and a modest batch size. The default run performs 200 optimizer updates.

The hybrid model saves to \`models/ari/ari0/checkpoint-hybrid-v2.pt\`. This is a separate file from the first character-level checkpoint, so the original experiment is preserved.

## Continue training from a checkpoint

The trainer starts from random weights unless \`--resume\` is supplied. The \`--steps\` value means **additional optimizer updates**, not a new total target.

~~~cmd
python training\ari0\train.py --resume --steps 1000 --eval-interval 100 --eval-batches 32 --batch-size 4 --threads 2
~~~

The trainer records fixed-sample training and validation loss to \`models/ari/ari0/training-history.csv\` at the initial checkpoint and each evaluation interval. This file is local-only and is not committed to Git.

The current first v2 checkpoint was created before optimizer-state saving was added. The first resumed run restores its model weights and starts a fresh AdamW optimizer. New checkpoints save both model and optimizer state, allowing later resume runs to continue with the saved optimizer state. Do not omit \`--resume\` when intending to continue; without it, a new random model is created and the hybrid checkpoint is replaced.

## Repeatable generation checks

Generation defaults to a fixed seed of 42. Use the same prompt, seed, token count and temperature when comparing checkpoints:

~~~cmd
python training\ari0\generate.py --prompt "<|user|> Hello Ari <|assistant|>" --new-tokens 100 --temperature 0.7 --seed 42
python training\ari0\generate.py --prompt "<|user|> What can you help me with? <|assistant|>" --new-tokens 100 --temperature 0.7 --seed 42
~~~

Generation remains a qualitative check; loss and generated samples should be considered together. Output may still be repetitive or incoherent after a short run: this is a tiny randomly initialized experiment, not a pretrained large language model.

## Important distinctions

- The model architecture is implemented here, and model weights are initialized randomly. We are not loading another model's weights.
- OASST1 is an existing dataset with its own licence; using it does not make the dataset our original work.
- This experiment does not reproduce the capabilities of a modern 2B/7B+ model, and it is not yet connected to Ari's browser playground.
- Future work can improve subword segmentation, expand properly licensed corpora, test longer training schedules, add instruction tuning and evaluation, and build a local inference bridge.
