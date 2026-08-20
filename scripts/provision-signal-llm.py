#!/usr/bin/env python3
"""Provision the pinned CPU LLM used by managed Signal deployments.

The large GGUF stays outside the Signal OCI image so source updates can reuse
it. Both network artifacts are immutable and verified before they become the
read-only runtime mounted into the Signal container.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.request


SCHEMA = "taxtronik.signal-managed-llm/v1"
MODEL_KEY = "granite-4.1-8b"
MODEL_FILE = "granite-4.1-8b-Q5_K_M.gguf"
MODEL_REVISION = "865b82c2e7970d82e3731278c88c57ae7138359c"
MODEL_SIZE = 6_253_884_064
MODEL_SHA256 = "353a49390e56b9035d8211868c03ed7beae125b914c57668c818d590d43edaca"
MODEL_URL = (
    "https://huggingface.co/ibm-granite/granite-4.1-8b-GGUF/resolve/"
    f"{MODEL_REVISION}/{MODEL_FILE}"
)

LLAMA_CPP_RELEASE = "b9986"
ENGINE_FILE = "llama-b9986-bin-ubuntu-x64.tar.gz"
ENGINE_SIZE = 15_846_818
ENGINE_SHA256 = "0e94c66fabf6489569e67f0069ab34364b788bc4154763de2313a2318fe5c6cc"
ENGINE_URL = (
    f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_CPP_RELEASE}/"
    f"{ENGINE_FILE}"
)

DOWNLOAD_BLOCK_SIZE = 4 * 1024 * 1024
MIN_FREE_AFTER_DOWNLOAD = 2 * 1024 * 1024 * 1024


class ProvisionError(RuntimeError):
    """A pinned artifact could not be provisioned safely."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(DOWNLOAD_BLOCK_SIZE), b""):
            digest.update(block)
    return digest.hexdigest()


def _verified(path: Path, *, size: int, sha256: str) -> bool:
    return path.is_file() and not path.is_symlink() and path.stat().st_size == size and _sha256(path) == sha256


def _ensure_free_space(output: Path, required: int) -> None:
    free = shutil.disk_usage(output).free
    if free < required + MIN_FREE_AFTER_DOWNLOAD:
        needed_gib = (required + MIN_FREE_AFTER_DOWNLOAD) / (1024**3)
        free_gib = free / (1024**3)
        raise ProvisionError(
            f"Zu wenig freier Speicher fuer das lokale Signal-LLM: "
            f"mindestens {needed_gib:.1f} GiB benoetigt, {free_gib:.1f} GiB frei."
        )


def _download_pinned(url: str, target: Path, *, size: int, sha256: str) -> None:
    if _verified(target, size=size, sha256=sha256):
        return

    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and (target.is_symlink() or not target.is_file()):
        raise ProvisionError(f"Unsicheres Downloadziel: {target}")

    existing = target.stat().st_size if target.exists() else 0
    if existing > size:
        target.unlink()
        existing = 0

    request = urllib.request.Request(url, headers={"User-Agent": "TaxTronik-managed-LLM/1"})
    if existing:
        request.add_header("Range", f"bytes={existing}-")

    try:
        response = urllib.request.urlopen(request, timeout=120)  # noqa: S310 - fixed pinned URLs
    except urllib.error.HTTPError as exc:
        if exc.code == 416 and _verified(target, size=size, sha256=sha256):
            return
        raise ProvisionError(f"Download fehlgeschlagen ({exc.code}): {url}") from exc
    except OSError as exc:
        raise ProvisionError(f"Download fehlgeschlagen: {url}: {exc}") from exc

    status = getattr(response, "status", None)
    append = existing > 0 and status == 206
    if existing and not append:
        existing = 0
    mode = "ab" if append else "wb"
    with response, target.open(mode) as stream:
        while True:
            block = response.read(DOWNLOAD_BLOCK_SIZE)
            if not block:
                break
            stream.write(block)

    if not _verified(target, size=size, sha256=sha256):
        target.unlink(missing_ok=True)
        raise ProvisionError(f"Integritaetspruefung fehlgeschlagen: {target.name}")


def _safe_extract(archive: Path, target: Path) -> None:
    with tarfile.open(archive, mode="r:gz") as bundle:
        bundle.extractall(target, filter="data")


def _runtime_inventory(runtime: Path) -> dict[str, str]:
    inventory: dict[str, str] = {}
    for path in sorted(runtime.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        inventory[path.relative_to(runtime).as_posix()] = _sha256(path)
    if "llama-server" not in inventory:
        raise ProvisionError("Das gepinnte llama.cpp-Archiv enthaelt kein erwartetes llama-server-Binary.")
    return inventory


def _runtime_valid(runtime: Path, inventory: object) -> bool:
    if not isinstance(inventory, dict) or not inventory:
        return False
    expected = {str(key): value for key, value in inventory.items() if isinstance(value, str)}
    try:
        actual = _runtime_inventory(runtime)
    except (OSError, ProvisionError):
        return False
    return actual == expected


def _engine_smoke(runtime: Path) -> None:
    binary = runtime / "llama-server"
    try:
        result = subprocess.run(
            [str(binary), "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ProvisionError(f"llama-server ist auf diesem Host nicht startbar: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        suffix = f": {detail[-1]}" if detail else ""
        raise ProvisionError(f"llama-server-Selbsttest fehlgeschlagen{suffix}")


def _make_runtime_readable(output: Path) -> None:
    os.chmod(output, 0o755)
    os.chmod(output / MODEL_FILE, 0o444)
    runtime = output / "runtime"
    for directory in [runtime, *(path for path in runtime.rglob("*") if path.is_dir())]:
        os.chmod(directory, 0o755)
    for path in runtime.rglob("*"):
        if path.is_file() and not path.is_symlink():
            os.chmod(path, 0o555 if path.name == "llama-server" else 0o444)


def _write_manifest(path: Path, document: dict[str, object]) -> None:
    data = (json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
    descriptor, temporary = tempfile.mkstemp(prefix=".managed-llm.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _load_manifest(path: Path) -> dict[str, object] | None:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return document if isinstance(document, dict) else None


def _manifest_contract_matches(document: dict[str, object] | None) -> bool:
    if not document:
        return False
    model = document.get("model")
    engine = document.get("engine")
    return (
        document.get("schema") == SCHEMA
        and isinstance(model, dict)
        and model.get("key") == MODEL_KEY
        and model.get("revision") == MODEL_REVISION
        and model.get("file") == MODEL_FILE
        and model.get("size") == MODEL_SIZE
        and model.get("sha256") == MODEL_SHA256
        and isinstance(engine, dict)
        and engine.get("release") == LLAMA_CPP_RELEASE
        and engine.get("archive") == ENGINE_FILE
        and engine.get("size") == ENGINE_SIZE
        and engine.get("sha256") == ENGINE_SHA256
    )


def verify(output: Path) -> bool:
    manifest = _load_manifest(output / "managed-llm.json")
    if not _manifest_contract_matches(manifest):
        return False
    assert manifest is not None
    model = output / MODEL_FILE
    engine = manifest["engine"]
    assert isinstance(engine, dict)
    return _verified(model, size=MODEL_SIZE, sha256=MODEL_SHA256) and _runtime_valid(
        output / "runtime", engine.get("files")
    )


def provision(output: Path) -> None:
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o755)
    if output.is_symlink() or not output.is_dir():
        raise ProvisionError(f"Unsicheres Ausgabeverzeichnis: {output}")
    os.chmod(output, 0o755)

    if verify(output):
        _make_runtime_readable(output)
        _engine_smoke(output / "runtime")
        print(f"Signal CPU-LLM bereits verifiziert: {MODEL_KEY} ({MODEL_SIZE / 1024**3:.1f} GiB)")
        return

    model = output / MODEL_FILE
    if not _verified(model, size=MODEL_SIZE, sha256=MODEL_SHA256):
        remaining = max(MODEL_SIZE - (model.stat().st_size if model.is_file() else 0), 0)
        _ensure_free_space(output, remaining)
        print(f"Lade {MODEL_KEY} fuer den CPU-Betrieb ({MODEL_SIZE / 1024**3:.1f} GiB) ...")
        _download_pinned(MODEL_URL, model, size=MODEL_SIZE, sha256=MODEL_SHA256)

    runtime = output / "runtime"
    current = _load_manifest(output / "managed-llm.json")
    current_engine = current.get("engine") if isinstance(current, dict) else None
    current_files = current_engine.get("files") if isinstance(current_engine, dict) else None
    if not _runtime_valid(runtime, current_files):
        _ensure_free_space(output, ENGINE_SIZE * 4)
        archive = output / f".{ENGINE_FILE}"
        print(f"Lade hash-gepinnte llama.cpp-CPU-Engine {LLAMA_CPP_RELEASE} ...")
        _download_pinned(ENGINE_URL, archive, size=ENGINE_SIZE, sha256=ENGINE_SHA256)
        with tempfile.TemporaryDirectory(prefix=".llama-extract-", dir=output) as extraction:
            extracted = Path(extraction)
            _safe_extract(archive, extracted)
            binaries = [
                path
                for path in extracted.rglob("llama-server")
                if path.is_file() and not path.is_symlink()
            ]
            if len(binaries) != 1:
                raise ProvisionError(
                    f"Erwartet genau ein llama-server-Binary, gefunden: {len(binaries)}"
                )
            staged = output / ".runtime.new"
            if staged.exists():
                shutil.rmtree(staged)
            shutil.copytree(binaries[0].parent, staged, symlinks=False)
            os.chmod(staged / "llama-server", 0o755)
            previous = output / ".runtime.previous"
            if previous.exists():
                shutil.rmtree(previous)
            if runtime.exists():
                os.replace(runtime, previous)
            os.replace(staged, runtime)
            if previous.exists():
                shutil.rmtree(previous)
        archive.unlink(missing_ok=True)

    runtime_files = _runtime_inventory(runtime)
    manifest = {
        "schema": SCHEMA,
        "backend": "cpu",
        "performance_bottleneck": True,
        "model": {
            "key": MODEL_KEY,
            "repository": "ibm-granite/granite-4.1-8b-GGUF",
            "revision": MODEL_REVISION,
            "file": MODEL_FILE,
            "size": MODEL_SIZE,
            "sha256": MODEL_SHA256,
        },
        "engine": {
            "release": LLAMA_CPP_RELEASE,
            "archive": ENGINE_FILE,
            "size": ENGINE_SIZE,
            "sha256": ENGINE_SHA256,
            "binary": "runtime/llama-server",
            "files": runtime_files,
        },
    }
    _write_manifest(output / "managed-llm.json", manifest)
    if not verify(output):
        raise ProvisionError("Abschliessende Signal-LLM-Pruefung fehlgeschlagen.")
    _make_runtime_readable(output)
    _engine_smoke(runtime)
    print(
        "Signal CPU-LLM ist einsatzbereit. Hinweis: CPU-Inferenz ist ein deutlicher "
        "Performance-Bottleneck und kann pro Analyse mehrere Minuten dauern."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    if platform.system() != "Linux" or platform.machine().lower() not in {"x86_64", "amd64"}:
        raise ProvisionError(
            "Das verwaltete CPU-LLM ist derzeit fuer Linux x86_64 gepinnt; "
            "andere Plattformen brauchen ein separat gebautes llama.cpp."
        )
    if args.verify_only:
        if not verify(args.output.resolve()):
            raise ProvisionError("Signal CPU-LLM fehlt oder ist nicht integer.")
        print("Signal CPU-LLM verifiziert.")
        return 0
    provision(args.output)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ProvisionError as exc:
        raise SystemExit(f"FEHLER: {exc}") from exc
