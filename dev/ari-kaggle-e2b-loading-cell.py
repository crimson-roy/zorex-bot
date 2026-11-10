"""Manual proposal only: inspect and paste into a NEW notebook cell only if E2B is unavailable.

This is intentionally not executed by either API cell. It uses local cached
weights only, keeps the existing MODEL/PROCESSOR and QWEN globals untouched,
and refuses to attempt a load unless every visible GPU has substantial free
VRAM. A successful load publishes the dedicated ARI_E2B_* globals expected by
the API cell.
"""

import gc
import torch
from transformers import AutoProcessor, AutoModelForMultimodalLM, BitsAndBytesConfig


def _ari_load_e2b_only_if_safe():
    if globals().get("ARI_E2B_MODEL") is not None and globals().get("ARI_E2B_PROCESSOR") is not None:
        print("Ari E2B is already loaded; leaving it unchanged.")
        return globals()["ARI_E2B_MODEL"], globals()["ARI_E2B_PROCESSOR"]
    if not torch.cuda.is_available() or torch.cuda.device_count() < 1:
        raise RuntimeError("No CUDA GPU is available; E2B was not loaded.")

    gpu_free = []
    for index in range(torch.cuda.device_count()):
        free_bytes, total_bytes = torch.cuda.mem_get_info(index)
        free_gib = free_bytes / (1024 ** 3)
        gpu_free.append((index, free_gib, total_bytes / (1024 ** 3)))
        print(f"GPU {index}: {free_gib:.2f} GiB free / {total_bytes / (1024 ** 3):.2f} GiB total")
    if len(gpu_free) < 2 or min(row[1] for row in gpu_free) < 6.0 or sum(row[1] for row in gpu_free) < 14.0:
        raise RuntimeError("Safety gate: require at least 6 GiB free on each of two GPUs and 14 GiB total. E2B was not loaded; keep the already-loaded models running.")

    model_id = "google/gemma-4-E2B-it"
    hf_kw = dict(globals().get("HF_KW", {}))
    hf_kw["local_files_only"] = True
    max_memory = {index: int(free_gib * 0.70 * (1024 ** 3)) for index, free_gib, _ in gpu_free}
    skip_modules = globals().get("SKIP_QUANT", ["lm_head", "model.vision_tower", "model.audio_tower", "model.embed_vision", "model.embed_audio"])
    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.float16,
        bnb_4bit_use_double_quant=True,
        llm_int8_skip_modules=skip_modules,
    )

    processor_candidate = AutoProcessor.from_pretrained(model_id, **hf_kw)
    model_candidate = AutoModelForMultimodalLM.from_pretrained(
        model_id,
        token=hf_kw.get("token"),
        local_files_only=True,
        device_map="auto",
        max_memory=max_memory,
        dtype=torch.float16,
        quantization_config=quantization,
    )
    model_candidate.eval()
    return model_candidate, processor_candidate


_ari_e2b_model_candidate, _ari_e2b_processor_candidate = _ari_load_e2b_only_if_safe()
ARI_E2B_MODEL = _ari_e2b_model_candidate
ARI_E2B_PROCESSOR = _ari_e2b_processor_candidate
del _ari_e2b_model_candidate, _ari_e2b_processor_candidate
gc.collect()
print("ARI_E2B_MODEL and ARI_E2B_PROCESSOR are ready. Existing Ultra and Qwen globals were not replaced.")
