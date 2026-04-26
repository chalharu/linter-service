#!/usr/bin/env python3
"""
cargo-symbol-length scan script.

Runs inside a Docker container. For each workspace manifest path given as
an argument, enumerates the workspace default members' lib and bin targets,
compiles each to an object file with --emit=obj, then runs nm to extract
symbol names.  Writes structured per-target run-entry directories under
/run-entries.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

RUN_ENTRIES = Path("/run-entries")
CARGO_TARGET = "/cargo-target"
WORK_PREFIX = "/work/"
LIBRARY_TARGET_KINDS = {
    "lib",
    "rlib",
    "dylib",
    "cdylib",
    "staticlib",
    "proc-macro",
}


def strip_work_prefix(value: str) -> str:
    return value[len(WORK_PREFIX) :] if value.startswith(WORK_PREFIX) else value


def run_cargo_metadata(manifest_path: str) -> dict | None:
    result = subprocess.run(
        [
            "cargo",
            "metadata",
            "--format-version",
            "1",
            "--no-deps",
            "--manifest-path",
            manifest_path,
        ],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        text=True,
    )
    if result.returncode != 0:
        print(
            f"Warning: cargo metadata failed for {manifest_path}:\n{result.stderr}",
            file=sys.stderr,
        )
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        print(
            f"Warning: failed to parse cargo metadata JSON for {manifest_path}: {exc}",
            file=sys.stderr,
        )
        return None


def enumerate_default_targets(metadata: dict) -> list[dict]:
    """Return lib/bin targets for workspace default members."""
    default_ids = set(metadata.get("workspace_default_members", []))
    targets = []
    for pkg in metadata.get("packages", []):
        if pkg["id"] not in default_ids:
            continue
        pkg_manifest = pkg["manifest_path"]
        for tgt in pkg.get("targets", []):
            kinds = tgt.get("kind", [])
            if not kinds:
                continue
            kind = kinds[0]
            if kind == "bin":
                cargo_flag = "--bin"
            elif kind in LIBRARY_TARGET_KINDS:
                cargo_flag = "--lib"
            else:
                continue
            targets.append(
                {
                    "cargo_flag": cargo_flag,
                    "kind": kind,
                    "manifest": pkg_manifest,
                    "name": tgt["name"],
                    "src_path": tgt["src_path"],
                }
            )
    return targets


def resolve_emitted_object(output_hint: Path) -> Path | None:
    if output_hint.exists():
        return output_hint

    stem = output_hint.stem
    candidates = [
        *output_hint.parent.glob(f"{stem}-*.o"),
        *output_hint.parent.glob(f"{stem}-*.obj"),
    ]
    if not candidates:
        return None

    candidates.sort(key=lambda candidate: candidate.stat().st_mtime_ns, reverse=True)
    return candidates[0]


def append_run_stderr(run_dir: Path, text: str) -> None:
    existing = (run_dir / "stderr.txt").read_text(
        encoding="utf-8",
        errors="replace",
    )
    suffix = text.rstrip()
    if not suffix:
        return
    if existing and not existing.endswith("\n"):
        existing += "\n"
    (run_dir / "stderr.txt").write_text(
        f"{existing}{suffix}\n",
        encoding="utf-8",
    )


def scan_manifest(manifest_path: str, run_index_state: list[int]) -> bool:
    """Scan all default targets in the workspace.  Returns True on overall success."""
    metadata = run_cargo_metadata(manifest_path)
    if metadata is None:
        return False

    targets = enumerate_default_targets(metadata)
    if not targets:
        print(
            f"No default lib/bin targets found in {manifest_path}",
            file=sys.stderr,
        )
        return True

    overall_ok = True

    for tgt in targets:
        run_index_state[0] += 1
        idx = run_index_state[0]
        run_dir = RUN_ENTRIES / f"{idx:04d}"
        run_dir.mkdir(parents=True, exist_ok=True)

        tgt_manifest = tgt["manifest"]
        tgt_flag = tgt["cargo_flag"]
        tgt_kind = tgt["kind"]
        tgt_name = tgt["name"]
        tgt_src = strip_work_prefix(tgt["src_path"])
        obj_path = Path(CARGO_TARGET) / f"symbol-scan-{idx}.o"

        if tgt_flag == "--lib":
            cmd = [
                "cargo",
                "rustc",
                "--manifest-path",
                tgt_manifest,
                "--lib",
                "--",
                "--emit=obj",
                "-o",
                str(obj_path),
            ]
        else:
            cmd = [
                "cargo",
                "rustc",
                "--manifest-path",
                tgt_manifest,
                "--bin",
                tgt_name,
                "--",
                "--emit=obj",
                "-o",
                str(obj_path),
            ]

        cmd_str = " ".join(cmd)
        (run_dir / "manifest_path.txt").write_text(
            strip_work_prefix(tgt_manifest) + "\n",
            encoding="utf-8",
        )
        (run_dir / "target_name.txt").write_text(tgt_name + "\n", encoding="utf-8")
        (run_dir / "target_src_path.txt").write_text(
            tgt_src + "\n",
            encoding="utf-8",
        )
        (run_dir / "target_kind.txt").write_text(tgt_kind + "\n", encoding="utf-8")
        (run_dir / "command.txt").write_text(cmd_str + "\n", encoding="utf-8")

        compile = subprocess.run(
            cmd,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            text=True,
        )
        (run_dir / "exit_code.txt").write_text(
            str(compile.returncode) + "\n",
            encoding="utf-8",
        )
        (run_dir / "stdout.txt").write_text(compile.stdout, encoding="utf-8")
        (run_dir / "stderr.txt").write_text(compile.stderr, encoding="utf-8")

        if compile.returncode != 0:
            overall_ok = False
            (run_dir / "symbols.txt").write_text("", encoding="utf-8")
            continue

        emitted_object = resolve_emitted_object(obj_path)
        if emitted_object is None:
            overall_ok = False
            (run_dir / "symbols.txt").write_text("", encoding="utf-8")
            append_run_stderr(
                run_dir,
                f"error: cargo-symbol-length could not locate an emitted object file for {tgt_name}",
            )
            continue

        nm = subprocess.run(
            ["nm", "--defined-only", "-j", str(emitted_object)],
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            text=True,
        )

        if nm.returncode != 0:
            overall_ok = False
            (run_dir / "symbols.txt").write_text("", encoding="utf-8")
            append_run_stderr(
                run_dir,
                "\n".join(
                    part.strip()
                    for part in [nm.stdout, nm.stderr]
                    if isinstance(part, str) and part.strip()
                )
                or f"error: nm failed for {emitted_object}",
            )
            continue

        lines = []
        for sym in nm.stdout.splitlines():
            sym = sym.strip()
            if sym:
                lines.append(f"{len(sym)}\t{sym}")
        (run_dir / "symbols.txt").write_text(
            "\n".join(lines) + ("\n" if lines else ""),
            encoding="utf-8",
        )

    return overall_ok


def main() -> int:
    manifests = sys.argv[1:]
    if not manifests:
        print("Usage: scan.py <manifest_path>...", file=sys.stderr)
        return 1
    if shutil.which("nm") is None:
        print("error: nm not found in PATH; install binutils", file=sys.stderr)
        return 1

    run_index_state = [0]
    overall_ok = True

    for manifest_path in manifests:
        if not scan_manifest(manifest_path, run_index_state):
            overall_ok = False

    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main())
