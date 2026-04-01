#!/usr/bin/env python3

import argparse
import json
import os
import uuid
from pathlib import Path

MASK_PAIRS = (
    ("pr_owner", "pr_repo"),
    ("source_owner", "source_repo"),
)


def load_context(context_path: str) -> dict[str, object]:
    return json.loads(Path(context_path).read_text(encoding="utf-8"))


def write_multiline_output(name: str, value: object) -> None:
    output_path = Path(os.environ["GITHUB_OUTPUT"])
    delimiter = f"context_{uuid.uuid4().hex}"
    text_value = "" if value is None else str(value)

    with output_path.open("a", encoding="utf-8") as fh:
        fh.write(f"{name}<<{delimiter}\n{text_value}\n{delimiter}\n")


def mask_values(context: dict[str, object], keys: list[str]) -> None:
    for key in keys:
        value = context.get(key)
        if value:
            print(f"::add-mask::{value}")

    selected_keys = set(keys)
    for owner_key, repo_key in MASK_PAIRS:
        owner = context.get(owner_key)
        repo = context.get(repo_key)
        if owner and repo and owner_key in selected_keys and repo_key in selected_keys:
            print(f"::add-mask::{owner}/{repo}")


def emit_outputs(context: dict[str, object], mappings: list[str]) -> None:
    for mapping in mappings:
        source_key, output_key = mapping.split("=", 1)
        write_multiline_output(output_key, context.get(source_key))


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    mask_parser = subparsers.add_parser("mask")
    mask_parser.add_argument("context_path")
    mask_parser.add_argument("keys", nargs="+")

    outputs_parser = subparsers.add_parser("outputs")
    outputs_parser.add_argument("context_path")
    outputs_parser.add_argument("mappings", nargs="+")

    args = parser.parse_args()
    context = load_context(args.context_path)

    if args.command == "mask":
        mask_values(context, args.keys)
        return

    emit_outputs(context, args.mappings)


if __name__ == "__main__":
    main()
