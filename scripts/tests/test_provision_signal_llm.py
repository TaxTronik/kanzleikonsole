from __future__ import annotations

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile

import pytest


SCRIPT = Path(__file__).parents[1] / "provision-signal-llm.py"
SPEC = importlib.util.spec_from_file_location("provision_signal_llm", SCRIPT)
assert SPEC and SPEC.loader
llm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(llm)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def test_artifacts_are_immutable_and_fully_pinned():
    assert llm.MODEL_REVISION == "865b82c2e7970d82e3731278c88c57ae7138359c"
    assert llm.MODEL_SIZE == 6_253_884_064
    assert len(llm.MODEL_SHA256) == 64
    assert llm.MODEL_REVISION in llm.MODEL_URL
    assert "/latest/" not in llm.MODEL_URL
    assert llm.LLAMA_CPP_RELEASE == "b9986"
    assert llm.ENGINE_SIZE == 15_846_818
    assert len(llm.ENGINE_SHA256) == 64
    assert f"/download/{llm.LLAMA_CPP_RELEASE}/" in llm.ENGINE_URL
    assert "/latest/" not in llm.ENGINE_URL


def test_safe_extract_rejects_parent_traversal(tmp_path: Path):
    archive = tmp_path / "unsafe.tar.gz"
    with tarfile.open(archive, "w:gz") as bundle:
        entry = tarfile.TarInfo("../escape")
        entry.size = 1
        bundle.addfile(entry, io.BytesIO(b"x"))

    with pytest.raises(tarfile.TarError):
        llm._safe_extract(archive, tmp_path / "extract")
    assert not (tmp_path.parent / "escape").exists()


def test_verify_checks_model_and_every_runtime_file(tmp_path: Path, monkeypatch):
    model_data = b"model"
    monkeypatch.setattr(llm, "MODEL_SIZE", len(model_data))
    monkeypatch.setattr(llm, "MODEL_SHA256", sha(model_data))

    (tmp_path / llm.MODEL_FILE).write_bytes(model_data)
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "llama-server").write_bytes(b"binary")
    (runtime / "libllama.so").write_bytes(b"library")
    files = llm._runtime_inventory(runtime)
    document = {
        "schema": llm.SCHEMA,
        "backend": "cpu",
        "performance_bottleneck": True,
        "model": {
            "key": llm.MODEL_KEY,
            "revision": llm.MODEL_REVISION,
            "file": llm.MODEL_FILE,
            "size": llm.MODEL_SIZE,
            "sha256": llm.MODEL_SHA256,
        },
        "engine": {
            "release": llm.LLAMA_CPP_RELEASE,
            "archive": llm.ENGINE_FILE,
            "size": llm.ENGINE_SIZE,
            "sha256": llm.ENGINE_SHA256,
            "binary": "runtime/llama-server",
            "files": files,
        },
    }
    (tmp_path / "managed-llm.json").write_text(json.dumps(document), encoding="utf-8")

    assert llm.verify(tmp_path)
    (runtime / "libllama.so").write_bytes(b"tampered")
    assert not llm.verify(tmp_path)
