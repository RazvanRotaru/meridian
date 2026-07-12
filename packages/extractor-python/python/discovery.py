"""Python source discovery and import-path derivation.

Graph module names must follow Python's import identity, not the extraction root's
filesystem layout.  In particular, ``repo/src/backend/app.py`` is ``backend.app`` and
extracting ``.../src/backend`` still keeps the leading ``backend`` package.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass


_SKIP_DIRS = frozenset(
    {
        "__pycache__",
        "build",
        "coverage",
        "dist",
        "node_modules",
        "out",
        "site-packages",
        "venv",
        "worktrees",
    }
)


@dataclass(frozen=True)
class DiscoveredModule:
    abs_path: str
    module_path: str
    file: str
    is_package: bool


def discover_modules(
    root: str,
    include: Iterable[str] = (),
    exclude: Iterable[str] = (),
) -> Iterator[DiscoveredModule]:
    """Yield selected ``.py`` files with stable import-oriented module paths."""
    includes = compile_globs(root, include)
    excludes = compile_globs(root, exclude)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(name for name in dirnames if is_source_directory(name))
        for filename in sorted(filenames):
            if not filename.endswith(".py"):
                continue
            abs_path = os.path.join(dirpath, filename)
            rel = posix_relative(abs_path, root)
            if includes and not matches_any(rel, includes):
                continue
            if excludes and matches_any(rel, excludes):
                continue
            yield DiscoveredModule(abs_path, import_path(root, abs_path), rel, filename == "__init__.py")


def module_aliases(modules: Iterable[DiscoveredModule]) -> dict[str, str]:
    """Map runtime import names to emitted module names.

    Package initializers use an explicit ``.__init__`` graph module to avoid colliding
    with the structural package node, while imports continue to address the package name.
    """
    aliases: dict[str, str] = {}
    for module in modules:
        aliases.setdefault(module.module_path, module.module_path)
        if module.module_path.endswith(".__init__"):
            aliases[module.module_path[: -len(".__init__")]] = module.module_path
    return aliases


def is_source_directory(name: str) -> bool:
    return not name.startswith(".") and name not in _SKIP_DIRS


def import_path(root: str, abs_path: str) -> str:
    """Derive import identity from a conventional source root or selected package root.

    Namespace packages deliberately have no ``__init__.py``, so per-file package-chain
    walking truncates valid names such as ``backend.services.storage``.  The import anchor
    is instead stable for the whole selected tree.
    """
    anchor = source_anchor(root, abs_path)
    rel = os.path.relpath(abs_path, anchor)
    parts = rel.replace(os.sep, "/").split("/")
    parts[-1] = parts[-1][:-3]
    return ".".join(parts)


def source_anchor(root: str, abs_path: str) -> str:
    conventional = os.path.join(root, "src")
    if os.path.isdir(conventional) and is_within(abs_path, conventional):
        return conventional
    conventional = conventional_source_ancestor(root)
    if conventional:
        return conventional
    package_root = package_ancestor(root)
    return os.path.dirname(package_root) if package_root else root


def conventional_source_ancestor(root: str) -> str | None:
    current = os.path.abspath(root)
    while True:
        if os.path.basename(current) == "src":
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def package_ancestor(root: str) -> str | None:
    current = root
    if not os.path.isfile(os.path.join(current, "__init__.py")):
        parent = os.path.dirname(current)
        if not os.path.isfile(os.path.join(parent, "__init__.py")):
            return None
        current = parent
    outermost = current
    while os.path.isfile(os.path.join(os.path.dirname(outermost), "__init__.py")):
        outermost = os.path.dirname(outermost)
    return outermost


def is_within(path: str, root: str) -> bool:
    try:
        return os.path.commonpath((os.path.abspath(path), os.path.abspath(root))) == os.path.abspath(root)
    except ValueError:
        return False


def posix_relative(path: str, root: str) -> str:
    return os.path.relpath(path, root).replace(os.sep, "/")


def compile_globs(root: str, patterns: Iterable[str]) -> list[re.Pattern[str]]:
    return [re.compile(glob_regex(relative_pattern(root, pattern))) for pattern in patterns]


def relative_pattern(root: str, pattern: str) -> str:
    normalized = pattern.replace("\\", "/")
    if os.path.isabs(pattern):
        normalized = os.path.relpath(pattern, root).replace(os.sep, "/")
    return normalized.removeprefix("./")


def glob_regex(pattern: str) -> str:
    """Translate ``*``/``**`` globs with slash-aware semantics."""
    result: list[str] = ["^"]
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "*" and index + 1 < len(pattern) and pattern[index + 1] == "*":
            if index + 2 < len(pattern) and pattern[index + 2] == "/":
                result.append("(?:.*/)?")
                index += 3
            else:
                result.append(".*")
                index += 2
        elif char == "*":
            result.append("[^/]*")
            index += 1
        elif char == "?":
            result.append("[^/]")
            index += 1
        else:
            result.append(re.escape(char))
            index += 1
    result.append("$")
    return "".join(result)


def matches_any(path: str, patterns: Iterable[re.Pattern[str]]) -> bool:
    return any(pattern.match(path) for pattern in patterns)
