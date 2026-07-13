"""Direct-file CLI entrypoint used by the TypeScript training worker."""

from __future__ import annotations

import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from rai_ml.cli import main
else:
    from .cli import main


if __name__ == "__main__":
    sys.exit(main())
