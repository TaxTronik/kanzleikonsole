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
    monkeypatch.setattr(llm, "ENGINE_INVENTORY_SHA256", llm._inventory_digest(files))
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
    document["engine"]["files"] = llm._runtime_inventory(runtime)
    (tmp_path / "managed-llm.json").write_text(json.dumps(document))
    assert not llm.verify(tmp_path)


class Download(io.BytesIO):
    def __init__(self, data: bytes, status: int = 200, content_range: str = ""):
        super().__init__(data)
        self.status = status
        self.headers = {"Content-Range": content_range}


def test_download_repairs_readonly_model_and_resumes_partial(tmp_path: Path, monkeypatch):
    target = tmp_path / "model.gguf"
    target.write_bytes(b"old!")
    target.chmod(0o444)
    ranges = []
    responses = iter([Download(b"ne"), Download(b"w!", 206, "bytes 2-3/4")])

    def request(req, timeout):
        ranges.append(req.get_header("Range"))
        return next(responses)

    monkeypatch.setattr(llm.urllib.request, "urlopen", request)
    with pytest.raises(llm.ProvisionError, match="unvollstaendig"):
        llm._download_pinned("https://example.test/model", target, size=4, sha256=sha(b"new!"))
    assert target.read_bytes() == b"old!"
    llm._download_pinned("https://example.test/model", target, size=4, sha256=sha(b"new!"))
    assert target.read_bytes() == b"new!"
    assert not (tmp_path / "model.gguf.part").exists()
    assert ranges == [None, "bytes=2-"]


def test_download_keeps_previous_model_on_oversize_or_bad_digest(tmp_path: Path, monkeypatch):
    target = tmp_path / "model.gguf"
    target.write_bytes(b"old!")
    responses = iter([Download(b"too large"), Download(b"bad!")])
    monkeypatch.setattr(llm.urllib.request, "urlopen", lambda *a, **kw: next(responses))
    for reason in ["groesser", "Integritaetspruefung"]:
        with pytest.raises(llm.ProvisionError, match=reason):
            llm._download_pinned("https://example.test/model", target, size=4, sha256=sha(b"new!"))
        assert target.read_bytes() == b"old!"


def set_pins(monkeypatch, *, model=b"model", engine=b"new engine"):
    monkeypatch.setattr(llm, "MODEL_SIZE", len(model))
    monkeypatch.setattr(llm, "MODEL_SHA256", sha(model))
    engine_archive = io.BytesIO()
    with tarfile.open(fileobj=engine_archive, mode="w:gz") as archive:
        entry = tarfile.TarInfo("llama-server")
        entry.size = len(engine)
        archive.addfile(entry, io.BytesIO(engine))
    payload = engine_archive.getvalue()
    monkeypatch.setattr(llm, "ENGINE_SIZE", len(payload))
    monkeypatch.setattr(llm, "ENGINE_SHA256", sha(payload))
    monkeypatch.setattr(llm, "ENGINE_INVENTORY_SHA256", llm._inventory_digest({"llama-server": sha(engine)}))
    def download(req, timeout):
        return Download({llm.MODEL_URL: model, llm.ENGINE_URL: payload}[req.full_url])
    monkeypatch.setattr(llm.urllib.request, "urlopen", download)
    monkeypatch.setattr(llm, "_engine_smoke", lambda runtime: None)


def legacy_install(root, model=b"model", engine=b"old engine"):
    (root / llm.MODEL_FILE).write_bytes(model)
    runtime = root / "runtime"
    runtime.mkdir()
    (runtime / "llama-server").write_bytes(engine)
    document = llm._manifest(llm._runtime_inventory(runtime))
    (root / "managed-llm.json").write_text(json.dumps(document))


def public_bytes(root):
    return tuple((root / p).read_bytes() for p in (llm.MODEL_FILE, "runtime/llama-server", "managed-llm.json"))


def test_provision_installs_new_pinned_engine_when_previous_inventory_matches(tmp_path: Path, monkeypatch):
    set_pins(monkeypatch, engine=b"old engine")
    legacy_install(tmp_path)
    assert llm.verify(tmp_path)
    set_pins(monkeypatch)
    model_inode = (tmp_path / llm.MODEL_FILE).stat().st_ino
    llm.provision(tmp_path)
    assert (tmp_path / "runtime/llama-server").read_bytes() == b"new engine"
    assert (tmp_path / llm.MODEL_FILE).stat().st_ino == model_inode
    assert llm.verify(tmp_path)


def test_smoke_failure_keeps_previous_model_runtime_and_manifest_then_retries_offline(tmp_path, monkeypatch):
    set_pins(monkeypatch, model=b"old model", engine=b"old engine")
    legacy_install(tmp_path, model=b"old model")
    before = public_bytes(tmp_path)
    set_pins(monkeypatch)
    def failed_smoke(runtime):
        assert runtime.parent.name == llm.CANDIDATE
        assert llm.verify(runtime.parent)
        assert public_bytes(tmp_path) == before
        raise llm.ProvisionError("smoke failed")
    monkeypatch.setattr(llm, "_engine_smoke", failed_smoke)
    with pytest.raises(llm.ProvisionError, match="smoke failed"):
        llm.provision(tmp_path)
    assert public_bytes(tmp_path) == before
    assert not (tmp_path / llm.CURRENT).exists()
    monkeypatch.setattr(llm.urllib.request, "urlopen", lambda *a, **kw: pytest.fail("unexpected download"))
    monkeypatch.setattr(llm, "_engine_smoke", lambda runtime: None)
    llm.provision(tmp_path)
    assert public_bytes(tmp_path)[:2] == (b"model", b"new engine")
    assert llm.verify(tmp_path)
    assert public_bytes(tmp_path / llm.CANDIDATE) == before


@pytest.mark.parametrize("interrupt_exchange", [1, 2, 3, 4])
def test_migration_preserves_compose_paths_at_every_interruption(tmp_path, monkeypatch, interrupt_exchange):
    set_pins(monkeypatch, model=b"old model", engine=b"old engine")
    legacy_install(tmp_path, model=b"old model")
    before = public_bytes(tmp_path)
    set_pins(monkeypatch)
    exchange, calls = llm._exchange, []
    def interrupt(left, right):
        calls.append(left)
        if len(calls) == interrupt_exchange:
            raise InterruptedError
        exchange(left, right)
    monkeypatch.setattr(llm, "_exchange", interrupt)
    with pytest.raises(InterruptedError):
        llm.provision(tmp_path)
    assert public_bytes(tmp_path) == before
    monkeypatch.setattr(llm, "_exchange", exchange)
    llm.provision(tmp_path)
    assert llm.verify(tmp_path)


def test_repeated_model_updates_reuse_two_slots(tmp_path, monkeypatch):
    for version in range(4):
        set_pins(monkeypatch, model=bytes([version]))
        llm.provision(tmp_path)
        assert llm.verify(tmp_path)
    models = [path for path in tmp_path.rglob("*.gguf") if not path.is_symlink()]
    assert sorted(path.read_bytes() for path in models) == [bytes([2]), bytes([3])]


def test_compose_failure_restores_complete_previous_release_after_restart(tmp_path, monkeypatch):
    set_pins(monkeypatch, model=b"old model", engine=b"old engine")
    legacy_install(tmp_path, model=b"old model")
    before = public_bytes(tmp_path)
    set_pins(monkeypatch)
    llm.provision(tmp_path)
    receipt = (tmp_path / llm.CURRENT / llm.PENDING).read_text().strip()
    llm.provision(tmp_path)  # Normal retry after interrupted deploy.
    with pytest.raises(llm.ProvisionError, match="gehoert nicht"):
        llm.provision(tmp_path, rollback="outdated")
    assert llm.verify(tmp_path)
    llm.provision(tmp_path, rollback=receipt)
    assert public_bytes(tmp_path) == before
    llm.provision(tmp_path)
    llm.provision(tmp_path, confirm=(tmp_path / llm.CURRENT / llm.PENDING).read_text().strip())
    with pytest.raises(llm.ProvisionError, match="gehoert nicht"):
        llm.provision(tmp_path, rollback=receipt)
    assert llm.verify(tmp_path)


def test_rollback_rejects_damaged_previous_artifacts(tmp_path, monkeypatch):
    set_pins(monkeypatch, model=b"old model", engine=b"old engine")
    legacy_install(tmp_path, model=b"old model")
    set_pins(monkeypatch)
    llm.provision(tmp_path)
    receipt = (tmp_path / llm.CURRENT / llm.PENDING).read_text().strip()
    (tmp_path / llm.CANDIDATE / "runtime/llama-server").write_bytes(b"damaged")
    with pytest.raises(llm.ProvisionError, match="unvollstaendig"):
        llm.provision(tmp_path, rollback=receipt)
    assert llm.verify(tmp_path)


def test_interrupted_network_stream_can_resume(tmp_path, monkeypatch):
    class Interrupted(Download):
        def read(self, n):
            if self.tell():
                raise ConnectionResetError("disconnected")
            return super().read(n)

    responses = iter([Interrupted(b"first "), Download(b"part", 206, "bytes 6-9/10")])
    monkeypatch.setattr(llm.urllib.request, "urlopen", lambda *a, **kw: next(responses))
    target = tmp_path / "model"
    kwargs = {"size": 10, "sha256": sha(b"first part")}
    with pytest.raises(llm.ProvisionError, match="unterbrochen"):
        llm._download_pinned("https://example.test/model", target, **kwargs)
    assert target.with_suffix(".part").read_bytes() == b"first "
    llm._download_pinned("https://example.test/model", target, **kwargs)
    assert target.read_bytes() == b"first part"


def test_fresh_layout_resumes_legacy_partial_without_restarting_download(tmp_path, monkeypatch):
    set_pins(monkeypatch)
    legacy = tmp_path / (llm.MODEL_FILE + ".part")
    legacy.write_bytes(b"mod")
    original = llm.urllib.request.urlopen
    def download(req, timeout):
        if req.full_url == llm.MODEL_URL:
            assert req.get_header("Range") == "bytes=3-"
            return Download(b"el", 206, "bytes 3-4/5")
        return original(req, timeout)
    monkeypatch.setattr(llm.urllib.request, "urlopen", download)
    llm.provision(tmp_path)
    assert llm.verify(tmp_path)
    assert not legacy.exists()
