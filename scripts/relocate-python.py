"""Regenerate installed Windows console launchers with PyPA's ScriptMaker.

Moving pyvenv.cfg does not rewrite the absolute interpreter path embedded in
pip.exe, ipython.exe and Jupyter entry points. Preserve all installed packages;
regenerate their declared scripts rather than patching executable bytes.
"""
from __future__ import annotations

import importlib.metadata
import json
import pathlib
import re
import sys

from pip._vendor.distlib.scripts import ScriptMaker


def main() -> int:
    application = pathlib.Path(__file__).resolve().parent.parent
    environment = application / ".python"
    scripts = environment / "Scripts"
    executable = scripts / "python.exe"
    if pathlib.Path(sys.executable).resolve() != executable.resolve():
        raise RuntimeError("Run this installer with the bundled venv interpreter")
    maker = ScriptMaker(None, str(scripts))
    maker.executable = str(executable)
    maker.variants = {""}
    maker.clobber = True
    outputs: list[dict[str, object]] = []
    claimed: dict[str, str] = {}
    for distribution in importlib.metadata.distributions(path=[str(environment / "Lib" / "site-packages")]):
        for entry in distribution.entry_points:
            if entry.group not in {"console_scripts", "gui_scripts"}:
                continue
            if not re.fullmatch(r"[\w.-]+", entry.name):
                raise RuntimeError(f"Invalid script name in installed metadata: {entry.name!r}")
            identity = entry.name.casefold()
            if identity in claimed and claimed[identity] != entry.value:
                raise RuntimeError(f"Conflicting installed entry point: {entry.name}")
            claimed[identity] = entry.value
            files = maker.make(f"{entry.name} = {entry.value}", {"gui": entry.group == "gui_scripts"})
            outputs.append({"name": entry.name, "package": distribution.metadata["Name"], "files": files})
    for name in ("pip3", f"pip{sys.version_info.major}.{sys.version_info.minor}"):
        files = maker.make(f"{name} = pip._internal.cli.main:main")
        outputs.append({"name": name, "package": "pip", "files": files})
    print(json.dumps({"interpreter": str(executable), "python": sys.version,
                      "mechanism": "installed pip vendored PyPA distlib ScriptMaker",
                      "regenerated": outputs}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
