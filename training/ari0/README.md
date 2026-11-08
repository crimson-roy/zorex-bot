# Ari-0: the from-scratch language-model experiment

Ari-0 is a small, decoder-only Transformer whose weights begin from random initialization. It is separate from Ari's Node.js chat server and existing maths and WordNet tools.

This first version is a **character-level learning experiment**, not a useful general-purpose chatbot. It demonstrates the basic loop: prepare permitted conversation text, tokenize it, train a causal language model, save its own weights, and generate text.

## Data source

The initial experiment can use the locally prepared English portion of OpenAssistant Conversations (OASST1). The dataset is published under Apache-2.0. Keep its licence and attribution with any redistribution:

- https://huggingface.co/datasets/OpenAssistant/oasst1
- https://arxiv.org/abs/2304.07327

The repository's existing npm run ari:prepare-oasst step filters the ready-for-export trees and creates train/validation JSONL files. The next step formats those conversations as text. Do not put downloaded datasets or generated corpora into Git.

OASST1 is a relatively small conversational dataset, not a broad pretraining corpus. A model trained only on it is expected to have limited vocabulary, knowledge and coherence. The first goal is to prove that our own weights learn from data and that training/validation loss can be measured. Better corpora, tokenization and later instruction tuning are separate milestones.

## Requirements

Use Python 3.14 or another Python version currently supported by PyTorch on Windows. Install the CPU build; this project does not require an NVIDIA GPU.

~~~powershell
py -m venv .venv-ari0
.\.venv-ari0\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r training\ari0\requirements.txt --index-url https://download.pytorch.org/whl/cpu
~~~

PyTorch's current Windows installation guide lists Python 3.10–3.14 support: https://pytorch.org/get-started/locally/

## Prepare the corpus

From the repository root:

~~~powershell
npm run ari:prepare-oasst
npm run ari:prepare-ari0-corpus
~~~

This writes local-only files to data/processed/ari0/train.txt and validation.txt.

## Train from random weights

~~~powershell
python training\ari0\train.py
~~~

The default settings are intentionally small: two Transformer blocks, two attention heads, 64 hidden dimensions, a 64-character context and a modest batch size. The default run performs 200 training steps and saves a checkpoint under models/ari/ari0/.

For a lighter first smoke run:

~~~powershell
python training\ari0\train.py --steps 20 --eval-interval 10 --batch-size 4 --threads 2
~~~

## Generate a sample

~~~powershell
python training\ari0\generate.py --prompt "User: Hello Ari Assistant:"
~~~

Generated output may be repetitive or incoherent at this stage. That is expected: this is a tiny character-level model trained on a small conversation corpus, not a pretrained large language model.

## Important distinctions

- The model architecture is implemented here, and model weights are initialized randomly. We are not loading another model's weights.
- OASST1 is an existing dataset with its own licence; using it does not make the dataset our original work.
- This is a first learning milestone. It does not reproduce the capabilities of a modern 2B/7B+ model, and it will not replace an Ollama-backed conversational model.
- Future work can add a subword tokenizer, larger properly licensed corpora, instruction tuning, evaluation, checkpoints/resume, and a local inference bridge.
