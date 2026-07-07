#!/usr/bin/env python3
"""Stdlib-only Python analyzer for blueprint's Python extractor.

Reads a Python source tree and prints one JSON object describing every module's nodes
(classes/functions/methods) and edges (calls/extends) with best-effort static resolution.
The TypeScript adapter consumes this JSON and maps it onto the language-agnostic graph
artifact. Per-file parsing is wrapped so a single bad file becomes a diagnostic, never a
crash. v1 scope: top-level functions, classes, and their direct methods; nested functions
are skipped (and noted in diagnostics).
"""

from __future__ import annotations

import ast
import json
import os
import re
import sys

from resolve import collect_edges
from symbols import SymbolTable


def main() -> None:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: analyze.py <root>\n")
        sys.exit(2)
    root = os.path.abspath(sys.argv[1])
    discovered = list(discover_modules(root))
    in_project = frozenset(dotted for _, dotted, _ in discovered)
    diagnostics: list[str] = []
    modules = []
    for abs_path, dotted, rel in discovered:
        module = analyze_file(abs_path, dotted, rel, in_project, diagnostics)
        if module is not None:
            modules.append(module)
    json.dump({"language": "python", "modules": modules, "diagnostics": diagnostics}, sys.stdout)


# Vendored/derived trees that must never enter the graph: caches, virtualenvs (hidden ones are
# covered by the dot rule), installed packages, and JS dependency trees living beside Python code.
# A real repo's .venv can hold 20k+ files — walking it overflows the analyzer's output pipe.
_SKIP_DIRS = frozenset({"__pycache__", "node_modules", "site-packages", "venv"})


def discover_modules(root: str):
    """Yield ``(abs_path, dotted_module, posix_relpath)`` for every non-package .py file."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in _SKIP_DIRS and not name.startswith(".")]
        for filename in sorted(filenames):
            if not filename.endswith(".py") or filename == "__init__.py":
                continue
            abs_path = os.path.join(dirpath, filename)
            rel = os.path.relpath(abs_path, root).replace(os.sep, "/")
            yield abs_path, rel[:-3].replace("/", "."), rel


def analyze_file(abs_path: str, dotted: str, rel: str, in_project: frozenset[str], diagnostics: list[str]):
    try:
        with open(abs_path, "r", encoding="utf-8") as handle:
            tree = ast.parse(handle.read(), filename=abs_path)
    except (OSError, SyntaxError, ValueError) as error:
        diagnostics.append(f"failed to parse {rel}: {error}")
        return None
    table = SymbolTable(dotted, in_project)
    table.scan(tree)
    return {
        "modulePath": dotted,
        "file": rel,
        "nodes": collect_nodes(tree),
        "edges": collect_edges(tree, table, diagnostics, rel),
    }


def collect_nodes(tree: ast.Module) -> list[dict]:
    nodes: list[dict] = []
    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            nodes.append(callable_node(stmt, parent=None))
        elif isinstance(stmt, ast.ClassDef):
            nodes.append(class_node(stmt))
            for member in stmt.body:
                if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    nodes.append(callable_node(member, parent=stmt.name))
    return nodes


def class_node(classdef: ast.ClassDef) -> dict:
    tags = []
    if "dataclass" in decorator_names(classdef):
        tags.append("dataclass")
    if classdef.name.startswith("_"):
        tags.append("private")
    return {
        "kind": "class",
        "qualname": classdef.name,
        "name": classdef.name,
        "parentQualname": None,
        "startLine": classdef.lineno,
        "endLine": end_line(classdef),
        "summary": docstring_summary(classdef),
        "signature": None,
        "tags": tags,
    }


def callable_node(func: ast.AST, parent: str | None) -> dict:
    name = func.name  # type: ignore[attr-defined]
    return {
        "kind": "method" if parent else "function",
        "qualname": f"{parent}.{name}" if parent else name,
        "name": name,
        "parentQualname": parent,
        "startLine": func.lineno,  # type: ignore[attr-defined]
        "endLine": end_line(func),
        "summary": docstring_summary(func),
        "signature": signature_of(func),
        "tags": callable_tags(func),
    }


def callable_tags(func: ast.AST) -> list[str]:
    tags: list[str] = []
    if isinstance(func, ast.AsyncFunctionDef):
        tags.append("async")
    decorators = decorator_names(func)
    tags.extend(name for name in ("staticmethod", "classmethod", "property") if name in decorators)
    if func.name.startswith("_"):  # type: ignore[attr-defined]
        tags.append("private")
    return tags


def decorator_names(node: ast.AST) -> list[str]:
    names: list[str] = []
    for decorator in node.decorator_list:  # type: ignore[attr-defined]
        target = decorator.func if isinstance(decorator, ast.Call) else decorator
        if isinstance(target, ast.Name):
            names.append(target.id)
        elif isinstance(target, ast.Attribute):
            names.append(target.attr)
    return names


def signature_of(func: ast.AST) -> str:
    arguments = ast.unparse(func.args)  # type: ignore[attr-defined]
    returns = func.returns  # type: ignore[attr-defined]
    suffix = f" -> {ast.unparse(returns)}" if returns else ""
    return f"{func.name}({arguments}){suffix}"  # type: ignore[attr-defined]


def docstring_summary(node: ast.AST) -> str | None:
    """The docstring's first sentence (mirrors the TS extractor's one-line summary)."""
    doc = ast.get_docstring(node)
    if not doc:
        return None
    match = re.match(r"^.*?[.!?](\s|$)", doc.strip(), re.DOTALL)
    return (match.group(0) if match else doc.strip()).strip()


def end_line(node: ast.AST) -> int:
    return getattr(node, "end_lineno", None) or node.lineno  # type: ignore[attr-defined]


if __name__ == "__main__":
    main()
