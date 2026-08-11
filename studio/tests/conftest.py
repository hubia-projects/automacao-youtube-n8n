"""conftest.py — bootstrap sys.path para imports de scripts/.

O pyproject.toml define hatch `packages = ["src/studio"]` apenas, então
`studio.scripts` NÃO é resolvido pela package "studio" (scripts/ fica em
studio/scripts/, NÃO em studio/src/studio/scripts/).

Fix: adicionar studio/ (root do projeto) + studio/scripts/ a sys.path,
para que `from benchmark_library_pipeline import ...` funcione nos testes
e o ficheiro seja executável como `python scripts/benchmark_library_pipeline.py`.
"""
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[1]   # studio/
sys.path.insert(0, str(_PROJECT_ROOT))
sys.path.insert(0, str(_PROJECT_ROOT / "scripts"))
