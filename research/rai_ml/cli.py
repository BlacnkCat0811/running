from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import replace
from pathlib import Path

from .contract import ContractError, load_jsonl
from .pipeline import TrainingConfig, TrainingError, train_and_export


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(
        description="Train, walk-forward validate, and export the RAI CatBoost residual model."
    )
    value.add_argument("--input", required=True, help="Versioned JSONL training dataset")
    value.add_argument("--scope", choices=("population", "personal"), default="population")
    value.add_argument(
        "--output",
        "--output-dir",
        dest="output",
        required=True,
        help="New artifact output directory",
    )
    value.add_argument(
        "--generated-at",
        help="Deterministic manifest timestamp for reproducible builds (ISO 8601)",
    )
    value.add_argument(
        "--data-through-at",
        required=True,
        help="Dataset audit cutoff; every label must complete no later than this instant",
    )
    return value


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    config = TrainingConfig()
    if args.scope == "personal":
        config = replace(
            config,
            minimum_labels=config.minimum_training_labels,
            minimum_labels_per_distance=config.minimum_training_labels_per_distance,
        )
    try:
        samples = load_jsonl(args.input)
        input_file_sha256 = hashlib.sha256(Path(args.input).read_bytes()).hexdigest()
        result = train_and_export(
            samples,
            args.output,
            config=config,
            training_data_through_at=args.data_through_at,
            generated_at=args.generated_at,
            input_file_sha256=input_file_sha256,
            scope=args.scope,
        )
    except (ContractError, TrainingError, OSError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False))
        return 1
    print(
        json.dumps(
            {
                "status": result.status,
                "outputDirectory": str(result.output_directory),
                "modelVersion": result.manifest["modelVersion"],
                "labelCount": result.manifest["labelCount"],
                "rejectionReasons": result.evaluation["rejectionReasons"],
            },
            ensure_ascii=False,
        )
    )
    return 0 if result.status == "accepted" else 2


if __name__ == "__main__":
    sys.exit(main())
