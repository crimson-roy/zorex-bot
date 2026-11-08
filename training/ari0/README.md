# Ari-0: the from-scratch language-model experiment

Ari-0 is a small, decoder-only Transformer whose weights begin from random initialization. It is separate from Ari's Node.js chat server and existing maths and WordNet tools.

The first character-level checkpoint proved that the training loop and generation path work. The next experiment uses a **hybrid word-and-character tokenizer**: frequent words are represented as one token, while less common words fall back to characters. This keeps the vocabulary manageable without making unseen words impossible to encode.


## Connect Ari-0 to the local HTML playground

The HTML playground now uses the locally trained Ari-0 hybrid checkpoint for open-ended messages. No Ollama model or external inference API is required for this connection.

The normal startup command launches both processes:

~~~cmd
npm run ari:dev
~~~

- Node serves the browser UI at \`http://127.0.0.1:4173\`.
- Node starts the Python inference bridge automatically.
- Python loads \`models/ari/ari0/checkpoint-hybrid-v2.pt\` once and listens only on \`127.0.0.1:4174\`.
- The header shows whether Ari-0 is connected and which training step is loaded.
- The browser sends the recent conversation turns so the model receives short chat context.
- Maths, WordNet definitions and word-list lookups continue to use their deterministic local tools.

The checkpoint is local-only and ignored by Git. Make sure the trained checkpoint exists at the path above before starting the playground. The Python environment used by \`npm run ari:dev\` must have PyTorch installed. By default Node launches \`python\`; to choose another interpreter, set \`ARI_PYTHON\` to the full path of its executable before starting the server.

Stop the playground with Ctrl+C. This also stops its Python inference child process.

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
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
python -m pip install pyarrow tokenizers
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
npm run ari:test-serve
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
- This experiment does not reproduce the capabilities of a modern 2B/7B+ model. It is connected to the browser playground for early local generation tests, but its replies are not expected to be reliable yet.
- Future work can improve subword segmentation, expand properly licensed corpora, test longer training schedules, add instruction tuning and evaluation, improve generation stopping and context management, and connect the same bridge to richer chat memory.


## Ari-0 v3: broader pretraining and assistant fine-tuning

V3 is deliberately separate from the v2 checkpoint and playground. It keeps v2's 104K checkpoint untouched. V3 uses a byte-level BPE tokenizer, a 4-layer/128-wide decoder (about 1.9M parameters at an 8,192-token vocabulary), a 256-token context, memory-mapped int16 token files, warmup/cosine learning-rate decay, gradient clipping, atomic checkpoints and fixed evaluation windows. It is still a small experimental model; greater capacity and better data do not guarantee coherent chat.

### Install v3 preparation dependencies

Install the CPU PyTorch build separately, then the data libraries:

~~~cmd
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
python -m pip install pyarrow tokenizers
~~~

The packages are also listed in `training/ari0/requirements.txt`. Do not pass the PyTorch index URL when installing all requirements, because PyArrow and Tokenizers are hosted on the normal Python package index.

### Prepare WikiText-103

Place the four downloaded Parquet files in `data/datasets/wikitext103/`. Convert them to three isolated text splits:

~~~cmd
python training\ari0\prepare_v3.py prepare-wikitext
~~~

Train the byte-level BPE tokenizer using **training text only**, then encode each split to memory-mappable binary tokens:

~~~cmd
python training\ari0\prepare_v3.py train-tokenizer --vocab-size 8192
python training\ari0\prepare_v3.py encode-text --text data\processed\wikitext103\train.txt --output data\processed\wikitext103\train.bin
python training\ari0\prepare_v3.py encode-text --text data\processed\wikitext103\validation.txt --output data\processed\wikitext103\validation.bin
python training\ari0\prepare_v3.py encode-text --text data\processed\wikitext103\test.txt --output data\processed\wikitext103\test.bin
~~~

The binary token files use 16-bit IDs and can be memory-mapped by the trainer. The test split is not used by training or validation.

### Run a short pretraining pilot

First run a small pilot and check temperatures, speed and loss before deciding on a longer session:

~~~cmd
python training\ari0\train_v3.py --mode pretrain --steps 500 --eval-interval 100 --eval-batches 16 --batch-size 2 --threads 2
~~~

V3 writes to `models/ari/ari0-v3/checkpoint-pretrain.pt`, not the v2 checkpoint. It refuses to overwrite an existing v3 checkpoint unless `--resume` is supplied. Continue from a saved v3 pretraining checkpoint with:

~~~cmd
python training\ari0\train_v3.py --mode pretrain --resume --steps 1000 --eval-interval 250 --eval-batches 32 --batch-size 2 --threads 2
~~~

### Prepare and fine-tune on OASST1

After pretraining, encode the already prepared role-marked OASST1 text. The parallel mask marks assistant response tokens as targets while leaving user-message tokens as context only:

~~~cmd
python training\ari0\prepare_v3.py encode-conversations --text data\processed\ari0\train.txt --output data\processed\ari0-v3\oasst1-train.bin --mask data\processed\ari0-v3\oasst1-train.mask.bin
python training\ari0\prepare_v3.py encode-conversations --text data\processed\ari0\validation.txt --output data\processed\ari0-v3\oasst1-validation.bin --mask data\processed\ari0-v3\oasst1-validation.mask.bin
python training\ari0\train_v3.py --mode finetune --init-from models\ari\ari0-v3\checkpoint-pretrain.pt --steps 500 --eval-interval 100 --eval-batches 16 --batch-size 2 --threads 2 --learning-rate 0.0001
~~~

Fine-tuning writes a separate `checkpoint-finetune.pt`. Resume it with `--mode finetune --resume` and omit `--init-from`. The v3 model is not yet connected to the HTML playground; the existing playground continues to use Ari-0 v2 until a separate v3 inference adapter is implemented and tested.

### V3 tests and safety notes

~~~cmd
python -m unittest discover -s training/ari0 -p test_v3.py -v
~~~

- The WikiText validation and test splits must never be appended to the training text or used to train the tokenizer.
- Pretraining loss covers all next-token targets. Conversation fine-tuning masks loss to assistant turns only.
- V3 uses CPU training by default. Start with a short pilot, inspect temperatures and throughput, and only then consider longer runs. A cooling fan does not replace temperature monitoring.
- Dataset files, encoded token streams, tokenizers and checkpoints remain local and are ignored by Git.
- WikiText-103 and OASST1 are third-party datasets; retain their licence and attribution when redistributing data.
