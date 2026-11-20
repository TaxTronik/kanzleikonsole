#!/usr/bin/env python3
"""Provision the pinned CPU LLM used by managed Signal deployments.

The large GGUF stays outside the Signal OCI image so source updates can reuse
it. Both network artifacts are immutable and verified before they become the
read-only runtime mounted into the Signal container.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import http.client
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
# SHA-256 of the sorted compact JSON inventory of the archive's 62 files
# after dereferencing its library links, as installed by shutil.copytree.
ENGINE_INVENTORY_SHA256 = "1686c7baecbd0e713134ea99744532ed877b0ee3c13f46892c7049fe7fd30fe6"
ENGINE_URL = (
    f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_CPP_RELEASE}/"
    f"{ENGINE_FILE}"
)

DOWNLOAD_BLOCK_SIZE = 4 * 1024 * 1024
MIN_FREE_AFTER_DOWNLOAD = 2 * 1024 * 1024 * 1024
CURRENT = ".signal-llm.current"
CANDIDATE = ".signal-llm.candidate"
PENDING = ".activation-pending"


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
    partial = target.with_name(f"{target.name}.part")
    for path in (target, partial):
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ProvisionError(f"Unsicheres Downloadziel: {path}")
    existing = partial.stat().st_size if partial.exists() else 0
    if existing >= size:
        if _verified(partial, size=size, sha256=sha256):
            os.replace(partial, target)
            return
        partial.unlink()
        existing = 0
    _ensure_free_space(target.parent, size - existing)

    request = urllib.request.Request(url, headers={"User-Agent": "TaxTronik-managed-LLM/1"})
    if existing:
        request.add_header("Range", f"bytes={existing}-")

    try:
        response = urllib.request.urlopen(request, timeout=120)  # noqa: S310 - fixed pinned URLs
    except urllib.error.HTTPError as exc:
        if exc.code == 416:
            partial.unlink(missing_ok=True)
        raise ProvisionError(f"Download fehlgeschlagen ({exc.code}): {url}") from exc
    except OSError as exc:
        raise ProvisionError(f"Download fehlgeschlagen: {url}: {exc}") from exc

    status = getattr(response, "status", None)
    append = existing > 0 and status == 206
    if existing and not append:
        existing = 0
    with response:
        if existing and not response.headers.get("Content-Range", "").startswith(f"bytes {existing}-"):
            partial.unlink(missing_ok=True)
            raise ProvisionError(f"Unerwarteter Downloadbereich: {target.name}")
        try:
            with partial.open("ab" if append else "wb") as stream:
                while block := response.read(DOWNLOAD_BLOCK_SIZE):
                    if stream.tell() + len(block) > size:
                        partial.unlink(missing_ok=True)
                        raise ProvisionError(f"Download groesser als der gepinnte Stand: {target.name}")
                    stream.write(block)
        except (OSError, http.client.HTTPException) as exc:
            raise ProvisionError(f"Download unterbrochen: {target.name}: {exc}") from exc

    if partial.stat().st_size != size:
        raise ProvisionError(f"Download unvollstaendig: {target.name}")
    if not _verified(partial, size=size, sha256=sha256):
        partial.unlink(missing_ok=True)
        raise ProvisionError(f"Integritaetspruefung fehlgeschlagen: {target.name}")
    os.replace(partial, target)


def _safe_extract(archive: Path, target: Path) -> None:
    with tarfile.open(archive, mode="r:gz") as bundle:
        bundle.extractall(target, filter="data")


def _runtime_inventory(runtime: Path) -> dict[str, str]:
    inventory: dict[str, str] = {}
    if runtime.is_symlink():
        raise ProvisionError(f"Verlinktes Runtime-Verzeichnis: {runtime}")
    for path in sorted(runtime.rglob("*")):
        if path.is_symlink():
            raise ProvisionError(f"Unerwarteter Link in der Runtime: {path}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise ProvisionError(f"Unerwarteter Dateityp in der Runtime: {path}")
        inventory[path.relative_to(runtime).as_posix()] = _sha256(path)
    if "llama-server" not in inventory:
        raise ProvisionError("Das gepinnte llama.cpp-Archiv enthaelt kein erwartetes llama-server-Binary.")
    return inventory


def _inventory_digest(files: dict[str, str]) -> str:
    return hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _runtime_valid(runtime: Path, inventory: object) -> bool:
    if not isinstance(inventory, dict) or not inventory:
        return False
    try:
        actual = _runtime_inventory(runtime)
    except (OSError, ProvisionError):
        return False
    return actual == inventory and _inventory_digest(actual) == ENGINE_INVENTORY_SHA256


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


def _engine_contract_matches(engine: object) -> bool:
    return (
        isinstance(engine, dict)
        and engine.get("release") == LLAMA_CPP_RELEASE
        and engine.get("archive") == ENGINE_FILE
        and engine.get("size") == ENGINE_SIZE
        and engine.get("sha256") == ENGINE_SHA256
    )


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
        and _engine_contract_matches(engine)
    )


def _active_path(output: Path, name: str) -> Path:
    path = output / name
    if path.is_symlink():
        expected = Path(CURRENT) / name
        if path.readlink() != expected or (output / CURRENT).is_symlink() or (output / expected).is_symlink():
            raise ProvisionError(f"Unerwarteter Link im Signal-LLM-Verzeichnis: {path}")
        return output / expected
    return path


def verify(output: Path) -> bool:
    manifest = _load_manifest(_active_path(output, "managed-llm.json"))
    if not _manifest_contract_matches(manifest):
        return False
    assert manifest is not None
    model = _active_path(output, MODEL_FILE)
    engine = manifest["engine"]
    assert isinstance(engine, dict)
    return _verified(model, size=MODEL_SIZE, sha256=MODEL_SHA256) and _runtime_valid(
        _active_path(output, "runtime"), engine.get("files")
    )


def provision(output: Path, *, confirm: str | None = None, rollback: str | None = None) -> None:
    if output.is_symlink():
        raise ProvisionError(f"Unsicheres Ausgabeverzeichnis: {output}")
    output.mkdir(parents=True, exist_ok=True, mode=0o755)
    # Der Managed-Installer läuft auf Linux. Das Verzeichnis selbst sperren:
    # parallele Updates teilen sich Part-Dateien, Manifest und Runtime-Tausch.
    import fcntl
    descriptor = os.open(output, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        if confirm is not None or rollback is not None:
            _finish_activation(output.resolve(), confirm=confirm, rollback=rollback)
        else:
            _provision_locked(output.resolve())
    finally:
        os.close(descriptor)


def _manifest(runtime_files: dict[str, str]) -> dict[str, object]:
    return {
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


def _exchange(left: Path, right: Path) -> None:
    # Both names remain usable even if the installer dies during migration.
    # Python's os.replace cannot exchange populated directories on Linux.
    renameat2 = getattr(ctypes.CDLL(None, use_errno=True), "renameat2", None)
    if renameat2 is None:
        raise ProvisionError("Atomarer Verzeichnistausch (renameat2) nicht verfuegbar.")
    if renameat2(-100, os.fsencode(left), -100, os.fsencode(right), 2) != 0:
        raise ProvisionError(f"Atomarer Verzeichnistausch fehlgeschlagen: {os.strerror(ctypes.get_errno())}")


def _managed_directory(output: Path, name: str) -> Path:
    path = output / name
    if path.is_symlink():
        raise ProvisionError(f"Unerwarteter Link fuer Installationsverzeichnis: {path}")
    path.mkdir(exist_ok=True, mode=0o755)
    marker = path / ".managed-by-taxtronik"
    if marker.is_symlink() or (not marker.is_file() and any(path.iterdir())):
        raise ProvisionError(f"Belegtes Verzeichnis ohne Signal-Installationsmarker: {path}")
    if not marker.exists():
        marker.touch()
    path.chmod(0o755)
    return path


def _prepare_public_paths(output: Path) -> None:
    # The original compose bind always mounts output. Exchange each legacy
    # entry for the alias that points to its new location in the SAME syscall.
    # This preserves the old bytes through every intermediate/retry state.
    current = _managed_directory(output, CURRENT)
    for name in (MODEL_FILE, "runtime", "managed-llm.json"):
        public = output / name
        relative = Path(CURRENT) / name
        if public.is_symlink():
            _active_path(output, name)
            continue
        if not public.exists():
            public.symlink_to(relative)
            continue
        reserved = current / name
        if reserved.is_symlink() and reserved.readlink() == relative:
            pass  # interrupted after creating the placeholder below
        elif reserved.exists() or reserved.is_symlink():
            raise ProvisionError(f"Bereits belegtes Signal-Migrationsziel: {reserved}")
        else:
            reserved.symlink_to(relative)
        _exchange(public, reserved)


def _pinned_files(runtime: Path) -> dict[str, str] | None:
    try:
        files = _runtime_inventory(runtime)
    except (OSError, ProvisionError):
        return None
    return files if _inventory_digest(files) == ENGINE_INVENTORY_SHA256 else None


def _stage_runtime(candidate: Path, active: Path) -> dict[str, str]:
    runtime = candidate / "runtime"
    if runtime.is_symlink():
        raise ProvisionError(f"Unerwarteter Link im Kandidaten: {runtime}")
    if runtime.exists():
        files = _pinned_files(runtime)
        if files is not None:
            return files
        shutil.rmtree(runtime)
    files = _pinned_files(active)
    if files is not None:
        shutil.copytree(active, runtime, copy_function=os.link)
        return files
    archive = candidate / ".engine.tar.gz"
    _ensure_free_space(candidate, ENGINE_SIZE * 4)
    _download_pinned(ENGINE_URL, archive, size=ENGINE_SIZE, sha256=ENGINE_SHA256)
    # Fixed private extraction directory: a retry cleans an interrupted extraction.
    extracted = candidate / ".extract"
    if extracted.exists():
        shutil.rmtree(extracted)
    extracted.mkdir()
    try:
        _safe_extract(archive, extracted)
        binaries = [p for p in extracted.rglob("llama-server") if p.is_file() and not p.is_symlink()]
        if len(binaries) != 1:
            raise ProvisionError(f"Erwartet genau ein llama-server-Binary, gefunden: {len(binaries)}")
        shutil.copytree(binaries[0].parent, runtime, symlinks=False)
    finally:
        shutil.rmtree(extracted)
    files = _runtime_inventory(runtime)
    if _inventory_digest(files) != ENGINE_INVENTORY_SHA256:
        raise ProvisionError("Entpackte llama.cpp-Runtime entspricht nicht dem gepinnten Inventar.")
    archive.unlink()
    return files


def _provision_locked(output: Path) -> None:
    os.chmod(output, 0o755)
    model = _active_path(output, MODEL_FILE)
    runtime = _active_path(output, "runtime")
    current = _load_manifest(_active_path(output, "managed-llm.json"))
    model_valid = _verified(model, size=MODEL_SIZE, sha256=MODEL_SHA256)
    engine = current.get("engine") if current else None
    if (model_valid and _manifest_contract_matches(current) and isinstance(engine, dict)
            and _runtime_valid(runtime, engine.get("files"))):
        _make_runtime_readable(output)
        _engine_smoke(runtime)
        print(f"Signal CPU-LLM bereits verifiziert: {MODEL_KEY} ({MODEL_SIZE / 1024**3:.1f} GiB)")
        return

    candidate = _managed_directory(output, CANDIDATE)
    for path in candidate.glob("*.gguf*"):
        if path.name not in (MODEL_FILE, MODEL_FILE + ".part"):
            path.unlink()
    staged_model = candidate / MODEL_FILE
    staged_partial = candidate / (MODEL_FILE + ".part")
    legacy_partial = output / (MODEL_FILE + ".part")
    if (not model_valid and not staged_partial.exists() and not staged_partial.is_symlink()
            and legacy_partial.is_file() and not legacy_partial.is_symlink()):
        os.replace(legacy_partial, staged_partial)
    if model_valid:
        # Both directories live in the same bind mount. Engine-only updates
        # do not duplicate the multi-GiB model.
        staged_model.unlink(missing_ok=True)
        os.link(model, staged_model)
    elif not _verified(staged_model, size=MODEL_SIZE, sha256=MODEL_SHA256):
        staged_model.unlink(missing_ok=True)
        print(f"Lade {MODEL_KEY} fuer den CPU-Betrieb ({MODEL_SIZE / 1024**3:.1f} GiB) ...")
        _download_pinned(MODEL_URL, staged_model, size=MODEL_SIZE, sha256=MODEL_SHA256)
    staged_partial.unlink(missing_ok=True)
    files = _stage_runtime(candidate, runtime)
    _write_manifest(candidate / "managed-llm.json", _manifest(files))
    _make_runtime_readable(candidate)
    _engine_smoke(candidate / "runtime")
    receipt = candidate / PENDING
    receipt.unlink(missing_ok=True)
    if current and current.get("schema") == SCHEMA:
        old_hash = _sha256(_active_path(output, "managed-llm.json"))
        new_hash = _sha256(candidate / "managed-llm.json")
        receipt.write_text(f"{new_hash}:{old_hash}\n", encoding="ascii")
    _prepare_public_paths(output)
    _exchange(candidate, output / CURRENT)
    print(
        "Signal CPU-LLM ist einsatzbereit. Hinweis: CPU-Inferenz ist ein deutlicher "
        "Performance-Bottleneck und kann pro Analyse mehrere Minuten dauern."
    )


def _finish_activation(output: Path, *, confirm: str | None, rollback: str | None) -> None:
    current = output / CURRENT
    previous = output / CANDIDATE
    if current.is_symlink() or previous.is_symlink():
        raise ProvisionError("Verlinktes Signal-Installationsverzeichnis.")
    receipt = current / PENDING
    token = confirm if confirm is not None else rollback
    if (not token or not receipt.is_file() or receipt.is_symlink()
            or receipt.read_text(encoding="ascii").strip() != token):
        raise ProvisionError("Signal-Aktivierung gehoert nicht zu diesem Installationsstand.")
    new_hash, _, old_hash = token.partition(":")
    if _sha256(current / "managed-llm.json") != new_hash:
        raise ProvisionError("Der aktuelle Signal-Installationsstand hat sich geaendert.")
    if confirm is not None:
        receipt.unlink()
        return
    manifest_path = previous / "managed-llm.json"
    if not manifest_path.is_file() or manifest_path.is_symlink() or _sha256(manifest_path) != old_hash:
        raise ProvisionError("Das vorherige Signal-Manifest hat sich geaendert.")
    document = _load_manifest(manifest_path) or {}
    model, engine = document.get("model"), document.get("engine")
    if (document.get("schema") != SCHEMA or not isinstance(model, dict)
            or model.get("file") != MODEL_FILE or not isinstance(engine, dict)
            or not _verified(previous / MODEL_FILE, size=model.get("size"), sha256=model.get("sha256"))
            or _runtime_inventory(previous / "runtime") != engine.get("files")):
        raise ProvisionError("Der vorherige Signal-Installationsstand ist unvollstaendig.")
    (previous / PENDING).unlink(missing_ok=True)
    _exchange(previous, current)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument("--verify-only", action="store_true")
    operation.add_argument("--confirm", metavar="RECEIPT")
    operation.add_argument("--rollback", metavar="RECEIPT")
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
    provision(args.output, confirm=args.confirm, rollback=args.rollback)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ProvisionError as exc:
        raise SystemExit(f"FEHLER: {exc}") from exc
