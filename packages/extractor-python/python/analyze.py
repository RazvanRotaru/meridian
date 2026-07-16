#!/usr/bin/env python3
"""Stdlib-only Python analyzer used by ``@meridian/extractor-python``.

The analyzer parses source without importing or executing project code.  It emits a compact
JSON wire model; the TypeScript adapter owns graph IDs, policy, aggregation, and depth collapse.
"""

from __future__ import annotations

import ast
import json
import os
import sys
import tokenize
from dataclasses import dataclass

from definitions import collect_nodes
from discovery import DiscoveredModule, discover_modules, module_aliases
from edge_collector import collect_edges
from flow_collector import collect_flows
from project import ProjectIndex
from symbols import SymbolTable


@dataclass(frozen=True)
class ParsedModule:
    discovered: DiscoveredModule
    tree: ast.Module


def main() -> None:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: analyze.py <root> [options-json]\n")
        sys.exit(2)
    root = os.path.abspath(sys.argv[1])
    options = read_options(sys.argv[2] if len(sys.argv) > 2 else None)
    diagnostics: list[str] = []
    discovered = list(discover_modules(root, options["include"], options["exclude"]))
    parsed = parse_modules(discovered, diagnostics)
    aliases = module_aliases(module.discovered for module in parsed)
    project = ProjectIndex(aliases, ((item.discovered.module_path, item.tree) for item in parsed))
    modules = [analyze_module(item, project, options["valueRefs"]) for item in parsed]
    diagnose_module_collisions(modules, diagnostics)
    json.dump({"language": "python", "modules": modules, "diagnostics": diagnostics}, sys.stdout)


def read_options(raw: str | None) -> dict:
    if raw is None:
        return {"include": [], "exclude": [], "valueRefs": False}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise SystemExit(f"invalid analyzer options JSON: {error}") from error
    return {
        "include": list(parsed.get("include") or []),
        "exclude": list(parsed.get("exclude") or []),
        "valueRefs": bool(parsed.get("valueRefs")),
    }


def parse_modules(modules: list[DiscoveredModule], diagnostics: list[str]) -> list[ParsedModule]:
    parsed: list[ParsedModule] = []
    for module in modules:
        tree = parse_file(module, diagnostics)
        if tree is not None:
            parsed.append(ParsedModule(module, tree))
    return parsed


def parse_file(module: DiscoveredModule, diagnostics: list[str]) -> ast.Module | None:
    try:
        with tokenize.open(module.abs_path) as handle:
            # SyntaxError.__str__ includes the parser filename. Keep diagnostics safe for cache and
            # web responses by using the already-normalized repository-relative path here.
            return ast.parse(handle.read(), filename=module.file)
    except (OSError, SyntaxError, UnicodeError, ValueError) as error:
        detail = str(error).replace(module.abs_path, module.file)
        diagnostics.append(f"failed to parse {module.file}: {detail}")
        return None


def analyze_module(module: ParsedModule, project: ProjectIndex, value_refs: bool) -> dict:
    table = SymbolTable(module.discovered.module_path, project)
    table.scan(module.tree)
    edges = collect_edges(module.tree, table, value_refs)
    return {
        "modulePath": module.discovered.module_path,
        "file": module.discovered.file,
        "isPackage": module.discovered.is_package,
        "endLine": module_end_line(module.tree),
        "nodes": collect_nodes(module.tree),
        "edges": edges,
        "flows": collect_flows(module.tree, edges),
    }


def module_end_line(tree: ast.Module) -> int:
    return max((getattr(node, "end_lineno", 1) or 1 for node in tree.body), default=1)


def diagnose_module_collisions(modules: list[dict], diagnostics: list[str]) -> None:
    files_by_path: dict[str, list[str]] = {}
    for module in modules:
        files_by_path.setdefault(module["modulePath"], []).append(module["file"])
    for module_path, files in files_by_path.items():
        if len(files) > 1:
            diagnostics.append(f"module path {module_path} is shared by: {', '.join(files)}")


if __name__ == "__main__":
    main()
