"""Mutable lexical bindings shared by Python symbol and edge passes."""

from __future__ import annotations

import ast
from dataclasses import dataclass, field

from project import resolve_from_module_path


@dataclass
class ScopeBindings:
    from_imports: dict[str, tuple[str, str]] = field(default_factory=dict)
    module_imports: dict[str, str] = field(default_factory=dict)
    module_import_paths: dict[str, set[str]] = field(default_factory=dict)
    local_types: dict[str, str] = field(default_factory=dict)
    definitions: dict[str, str] = field(default_factory=dict)
    definition_origins: dict[str, int | str] = field(default_factory=dict)
    shadowed: set[str] = field(default_factory=set)
    receivers: dict[str, str] = field(default_factory=dict)


def scan_imports(nodes: list[ast.AST], module_path: str, scope: ScopeBindings) -> None:
    for node in nodes:
        if isinstance(node, ast.ImportFrom):
            base = resolve_from_module_path(module_path, node)
            if base:
                for alias in node.names:
                    if alias.name != "*":
                        bind_from_import(alias.asname or alias.name, (base, alias.name), scope)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.asname or alias.name.split(".")[0]
                target = alias.name if alias.asname else alias.name.split(".")[0]
                bind_module_import(name, target, scope, alias.name)


def bind_from_import(name: str, target: tuple[str, str], scope: ScopeBindings) -> None:
    scope.from_imports[name] = target
    scope.module_imports.pop(name, None)
    scope.module_import_paths.pop(name, None)
    scope.definitions.pop(name, None)
    scope.definition_origins.pop(name, None)
    scope.local_types.pop(name, None)
    scope.receivers.pop(name, None)
    scope.shadowed.discard(name)


def bind_module_import(
    name: str,
    target: str,
    scope: ScopeBindings,
    imported_path: str | None = None,
) -> None:
    paths = (
        set(scope.module_import_paths.get(name, ()))
        if scope.module_imports.get(name) == target
        else set()
    )
    paths.add(imported_path or target)
    scope.module_imports[name] = target
    scope.module_import_paths[name] = paths
    scope.from_imports.pop(name, None)
    scope.definitions.pop(name, None)
    scope.definition_origins.pop(name, None)
    scope.local_types.pop(name, None)
    scope.receivers.pop(name, None)
    scope.shadowed.discard(name)


def bind_local(name: str, type_ref: str | None, scope: ScopeBindings) -> None:
    scope.definitions.pop(name, None)
    scope.definition_origins.pop(name, None)
    scope.from_imports.pop(name, None)
    scope.module_imports.pop(name, None)
    scope.module_import_paths.pop(name, None)
    scope.receivers.pop(name, None)
    scope.shadowed.add(name)
    if type_ref:
        scope.local_types[name] = type_ref
    else:
        scope.local_types.pop(name, None)


def bind_definition(
    name: str,
    qualname: str,
    scope: ScopeBindings,
    origin: int | str | None = None,
) -> None:
    scope.definitions[name] = qualname
    scope.definition_origins[name] = origin if origin is not None else qualname
    scope.from_imports.pop(name, None)
    scope.module_imports.pop(name, None)
    scope.module_import_paths.pop(name, None)
    scope.local_types.pop(name, None)
    scope.receivers.pop(name, None)
    scope.shadowed.discard(name)


def clone_scope(scope: ScopeBindings) -> ScopeBindings:
    return ScopeBindings(
        from_imports=dict(scope.from_imports),
        module_imports=dict(scope.module_imports),
        module_import_paths={name: set(paths) for name, paths in scope.module_import_paths.items()},
        local_types=dict(scope.local_types),
        definitions=dict(scope.definitions),
        definition_origins=dict(scope.definition_origins),
        shadowed=set(scope.shadowed),
        receivers=dict(scope.receivers),
    )
