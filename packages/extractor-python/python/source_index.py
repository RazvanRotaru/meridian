#!/usr/bin/env python3
"""Bounded syntax-only Python topology and symbol scanner for progressive review.

The scanner never imports project code and retains at most one source AST.  Filesystem discovery
and import identity reuse the production extractor's helpers so selected-file extraction observes
the same module names.  Semantic extraction remains the authority after a slice is selected.
"""

from __future__ import annotations

import ast
import json
import os
import sys
import tokenize

from definitions import collect_nodes
from discovery import DiscoveredModule, discover_modules, module_aliases
from project import resolve_from_module_path


ROOT_PACKAGE = "__root__"


class BoundedFailure(Exception):
    pass


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: source_index.py <root> <options-json>")
    root = os.path.abspath(sys.argv[1])
    options = read_options(sys.argv[2])
    discovered = discover_bounded(root, options)
    parsed = parse_bounded(discovered, options)
    parsed_paths = {item[0].file for item in parsed}
    # A changed file with invalid Python syntax has no semantic file node. Keep it in the exact PR
    # manifest, but exclude it from the graphable roots so preparation can land a manifest-only
    # empty side without inventing an ID that could perturb production package/module ordinals.
    seeds = sorted(set(options["seeds"]) & parsed_paths)

    file_ids, symbol_rows = allocate_ids(parsed, options["includeSymbols"])
    aliases = module_aliases(item[0] for item in parsed)
    module_by_path = {item[0].module_path: item[0] for item in parsed}
    adjacency: dict[str, set[str]] = {item[0].file: set() for item in parsed}
    adjacency_entries = 0
    for module, imports, _nodes, _size in parsed:
        for imported in imports:
            canonical = aliases.get(imported)
            target = module_by_path.get(canonical) if canonical else None
            if target is None or target.file == module.file:
                continue
            if target.file not in adjacency[module.file]:
                adjacency[module.file].add(target.file)
                adjacency[target.file].add(module.file)
                adjacency_entries += 2
                if adjacency_entries > options["maxAdjacencyEntries"]:
                    raise BoundedFailure("Python source index exceeded its adjacency limit")

    files = []
    for module, _imports, _nodes, _size in sorted(parsed, key=lambda item: item[0].file):
        files.append(
            {
                "path": module.file,
                "fileId": file_ids[module.file],
                "neighbors": sorted(file_ids[path] for path in adjacency[module.file]),
                "uncertain": False,
            }
        )
    symbol_rows.sort(key=lambda item: (item["displayName"], item["qualifiedName"], item["id"]))
    json.dump(
        {
            "seeds": seeds,
            "symbols": symbol_rows,
            "files": files,
            "sourceFileCount": len(parsed),
            "sourceBytes": sum(item[3] for item in parsed),
            "adjacencyEntries": adjacency_entries,
        },
        sys.stdout,
        separators=(",", ":"),
    )


def read_options(raw: str) -> dict:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise BoundedFailure("Python source-index options are invalid") from error
    if not isinstance(value, dict):
        raise BoundedFailure("Python source-index options are invalid")
    limits = (
        "maxFiles",
        "maxSourceBytes",
        "maxFileBytes",
        "maxSymbols",
        "maxAdjacencyEntries",
        "maxPathBytes",
    )
    for key in limits:
        if not isinstance(value.get(key), int) or value[key] <= 0:
            raise BoundedFailure("Python source-index limits are invalid")
    seeds = value.get("seeds")
    excludes = value.get("exclude")
    if (
        not isinstance(seeds, list)
        or not all(isinstance(item, str) and safe_path(item) for item in seeds)
        or not isinstance(excludes, list)
        or not all(isinstance(item, str) for item in excludes)
        or not isinstance(value.get("includeSymbols"), bool)
    ):
        raise BoundedFailure("Python source-index options are invalid")
    return {**value, "seeds": seeds, "exclude": excludes}


def discover_bounded(root: str, options: dict) -> list[DiscoveredModule]:
    result: list[DiscoveredModule] = []
    path_bytes = 0
    canonical_root = os.path.realpath(root)
    for module in discover_modules(root, (), options["exclude"]):
        if not safe_path(module.file):
            raise BoundedFailure("Python source index encountered an invalid source path")
        canonical_file = os.path.realpath(module.abs_path)
        try:
            confined = os.path.commonpath((canonical_root, canonical_file)) == canonical_root
        except ValueError:
            confined = False
        if not confined or canonical_file != os.path.join(canonical_root, *module.file.split("/")):
            raise BoundedFailure("Python source index encountered a source outside its exact workspace")
        result.append(module)
        if len(result) > options["maxFiles"]:
            raise BoundedFailure("Python source index exceeded its file limit")
        path_bytes += len(module.file.encode("utf-8"))
        if path_bytes > options["maxPathBytes"]:
            raise BoundedFailure("Python source index exceeded its path-byte limit")
    return result


def parse_bounded(
    discovered: list[DiscoveredModule],
    options: dict,
) -> list[tuple[DiscoveredModule, set[str], list[dict], int]]:
    result: list[tuple[DiscoveredModule, set[str], list[dict], int]] = []
    source_bytes = 0
    symbol_count = 0
    for module in discovered:
        size = os.path.getsize(module.abs_path)
        if size > options["maxFileBytes"]:
            raise BoundedFailure("Python source index encountered an oversized source file")
        source_bytes += size
        if source_bytes > options["maxSourceBytes"]:
            raise BoundedFailure("Python source index exceeded its source-byte limit")
        try:
            with tokenize.open(module.abs_path) as handle:
                tree = ast.parse(handle.read(), filename=module.file)
        except (OSError, SyntaxError, UnicodeError, ValueError):
            # The production analyzer omits the same unparseable source from its graph.
            continue
        imports = import_targets(module.module_path, tree)
        nodes = collect_nodes(tree) if options["includeSymbols"] else []
        if options["includeSymbols"]:
            symbol_count += len(nodes) + (0 if module.is_package else 1)
        if symbol_count > options["maxSymbols"]:
            raise BoundedFailure("Python source index exceeded its symbol limit")
        result.append((module, imports, nodes, size))
    return result


def import_targets(module_path: str, tree: ast.Module) -> set[str]:
    result: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            result.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            target = resolve_from_module_path(module_path, node)
            if target:
                result.add(target)
    return result


def allocate_ids(
    parsed: list[tuple[DiscoveredModule, set[str], list[dict], int]],
    include_symbols: bool,
) -> tuple[dict[str, str], list[dict]]:
    counts: dict[str, int] = {}

    def allocate(base: str) -> str:
        ordinal = counts.get(base, 0)
        counts[base] = ordinal + 1
        return base if ordinal == 0 else f"{base}~{ordinal}"

    prefixes = package_prefixes(item[0] for item in parsed)
    package_ids = {
        prefix: allocate(f"py:{prefix}")
        for prefix in sorted(prefixes, key=lambda value: (len(value.split(".")), value))
    }
    file_ids: dict[str, str] = {}
    symbols: list[dict] = []
    for module, _imports, nodes, _size in parsed:
        graph_path = graph_module_path(module)
        file_id = package_ids[graph_path] if module.is_package else allocate(f"py:{graph_path}")
        file_ids[module.file] = file_id
        if include_symbols and not module.is_package:
            symbols.append(
                symbol(file_id, file_id, graph_path.split(".")[-1], graph_path, "module", module.file)
            )
        for node in nodes:
            node_id = allocate(f"py:{graph_path}#{node['qualname']}")
            if include_symbols:
                symbols.append(
                    symbol(
                        node_id,
                        file_id,
                        node["name"],
                        node["qualname"],
                        node["kind"],
                        module.file,
                    )
                )
    return file_ids, symbols


def symbol(
    node_id: str,
    file_id: str,
    display_name: str,
    qualified_name: str,
    kind: str,
    file: str,
) -> dict:
    return {
        "id": node_id,
        "fileId": file_id,
        "displayName": display_name,
        "qualifiedName": qualified_name,
        "kind": kind,
        "file": file,
        "isPrivateMethod": kind == "method" and display_name.startswith("__"),
        "stepCount": None,
    }


def package_prefixes(modules) -> set[str]:
    prefixes: set[str] = set()
    count = 0
    for module in modules:
        count += 1
        graph_path = graph_module_path(module)
        segments = graph_path.split(".")
        for depth in range(1, len(segments)):
            prefixes.add(".".join(segments[:depth]))
        if module.is_package:
            prefixes.add(graph_path)
    if not prefixes and count:
        prefixes.add(ROOT_PACKAGE)
    return prefixes


def graph_module_path(module: DiscoveredModule) -> str:
    return module.module_path.removesuffix(".__init__") if module.is_package else module.module_path


def safe_path(value: str) -> bool:
    return (
        bool(value)
        and "\x00" not in value
        and "\\" not in value
        and not value.startswith("/")
        and value.endswith(".py")
        and all(part not in ("", ".", "..") for part in value.split("/"))
    )


if __name__ == "__main__":
    try:
        main()
    except BoundedFailure as error:
        sys.stderr.write(str(error))
        sys.exit(2)
