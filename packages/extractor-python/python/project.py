"""Whole-project symbol facts used by the per-module resolver."""

from __future__ import annotations

import ast
from collections.abc import Iterable

from export_flow import scan_export_body
from exports import ExportBindings
from inheritance import ClassKey, c3_mro
from inference import type_ref_of

FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)


class ProjectIndex:
    def __init__(self, aliases: dict[str, str], parsed: Iterable[tuple[str, ast.Module]]) -> None:
        self.module_aliases = aliases
        self.packages = package_names(aliases)
        self.kinds: dict[tuple[str, str], str] = {}
        self.top_names: dict[str, dict[str, str]] = {}
        self.top_origins: dict[str, dict[str, int | str]] = {}
        self.reexports: dict[str, dict[str, tuple[str, str]]] = {}
        self.class_methods: dict[ClassKey, dict[str, int]] = {}
        self.class_bases: dict[tuple[str, str], list[ast.expr]] = {}
        self.resolved_bases: dict[ClassKey, list[ClassKey]] = {}
        self.complete_bases: set[ClassKey] = set()
        self.base_contexts: dict[ClassKey, ExportBindings | None] = {}
        self.returns: dict[tuple[str, str], ast.expr] = {}
        self.return_contexts: dict[tuple[str, str], ExportBindings | None] = {}
        self.return_types: dict[tuple[str, str], ClassKey] = {}
        self.from_imports: dict[str, dict[str, tuple[str, str]]] = {}
        self.module_imports: dict[str, dict[str, str]] = {}
        parsed_modules = list(parsed)
        for module_path, tree in parsed_modules:
            self.scan_module(module_path, tree)
        self.resolve_class_bases()
        self.resolve_return_types()

    def canonical_module(self, module_path: str) -> str | None:
        return self.module_aliases.get(module_path)

    def import_target(self, module_path: str) -> str | None:
        return self.canonical_module(module_path) or (module_path if module_path in self.packages else None)

    def locate_symbol(
        self,
        module_path: str,
        name: str,
        seen: frozenset[tuple[str, str]] = frozenset(),
    ) -> tuple[str, str] | None:
        target = self.symbol_target(module_path, name, seen)
        return (target[0], target[1]) if target else None

    def symbol_target(
        self,
        module_path: str,
        name: str,
        seen: frozenset[tuple[str, str]] = frozenset(),
    ) -> tuple[str, str, int | None] | None:
        actual = self.canonical_module(module_path)
        if actual is None:
            return None
        key = (actual, name)
        if key in seen:
            return None
        qualname = self.top_names.get(actual, {}).get(name)
        if qualname:
            origin = self.top_origins.get(actual, {}).get(name)
            return actual, qualname, origin if isinstance(origin, int) else None
        exported = self.reexports.get(actual, {}).get(name)
        if exported:
            return self.symbol_target(*exported, seen | {key})
        return None

    def locate_submodule(self, module_path: str, name: str) -> str | None:
        runtime = module_path.removesuffix(".__init__")
        return self.canonical_module(f"{runtime}.{name}")

    def kind_of(self, module_path: str, qualname: str) -> str | None:
        return self.kinds.get((module_path, qualname))

    def has_method(self, module_path: str, class_qualname: str, method: str) -> bool:
        return method in self.class_methods.get((module_path, class_qualname), {})

    def method_target(
        self,
        module_path: str,
        class_qualname: str,
        method: str,
    ) -> tuple[str, str, int] | None:
        key = (module_path, class_qualname)
        order = c3_mro(key, self.resolved_bases, self.complete_bases)
        if order is None:
            return self.own_method_target(key, method)
        for owner in order:
            target = self.own_method_target(owner, method)
            if target:
                return target
        return None

    def own_method_target(self, key: ClassKey, method: str) -> tuple[str, str, int] | None:
        line = self.class_methods.get(key, {}).get(method)
        return (key[0], f"{key[1]}.{method}", line) if line else None

    def super_method_target(
        self,
        module_path: str,
        class_qualname: str,
        method: str,
    ) -> tuple[str, str, int] | None:
        key = (module_path, class_qualname)
        order = c3_mro(key, self.resolved_bases, self.complete_bases)
        if order is None:
            return None
        for owner in order[1:]:
            target = self.own_method_target(owner, method)
            if target:
                return target
        return None

    def locate_type(self, module_path: str, type_ref: str | None) -> tuple[str, str] | None:
        if not type_ref:
            return None
        actual = self.canonical_module(module_path) or module_path
        imported = self.from_imports.get(actual, {}).get(type_ref)
        located = self.locate_symbol(*(imported or (actual, type_ref)))
        if located and self.kind_of(*located) == "class":
            return located
        parts = type_ref.split(".")
        prefix = self.module_imports.get(actual, {}).get(parts[0], parts[0])
        for split in range(len(parts), 0, -1):
            candidate = ".".join([prefix, *parts[1:split]])
            target_module = self.canonical_module(candidate)
            if target_module and split < len(parts):
                located = self.locate_symbol(target_module, ".".join(parts[split:]))
                if located and self.kind_of(*located) == "class":
                    return located
        return None

    def return_target(self, module_path: str, qualname: str) -> ClassKey | None:
        return self.return_types.get((module_path, qualname))

    def scan_module(self, module_path: str, tree: ast.Module) -> None:
        bindings = ExportBindings()
        def record(statement: ast.AST, kind: str, context: ExportBindings) -> None:
            if isinstance(statement, FUNCTIONS):
                self.scan_function(module_path, statement, statement.name, kind, context)
            elif isinstance(statement, ast.ClassDef):
                self.scan_class(module_path, statement, statement.name, context)

        scan_export_body(module_path, tree.body, bindings, record)
        self.top_names[module_path] = bindings.top_names
        self.top_origins[module_path] = bindings.local_origins
        self.reexports[module_path] = bindings.reexports
        self.from_imports[module_path] = bindings.from_imports
        self.module_imports[module_path] = bindings.module_imports

    def scan_class(
        self,
        module_path: str,
        classdef: ast.ClassDef,
        qualname: str,
        context: ExportBindings | None = None,
    ) -> None:
        key = (module_path, qualname)
        self.kinds[key] = "class"
        self.class_bases[key] = list(classdef.bases)
        self.base_contexts[key] = context.clone() if context else None
        methods = ExportBindings()

        def record(statement: ast.AST, kind: str, child_context: ExportBindings) -> None:
            child = f"{qualname}.{statement.name}"  # type: ignore[attr-defined]
            if isinstance(statement, FUNCTIONS):
                self.scan_function(module_path, statement, child, "method", context)
            elif isinstance(statement, ast.ClassDef):
                self.scan_class(module_path, statement, child, child_context)

        scan_export_body(module_path, classdef.body, methods, record)
        self.class_methods[key] = {
            name: int(methods.local_origins[name])
            for name in methods.top_names
            if self.kind_of(module_path, f"{qualname}.{name}") == "method"
            and isinstance(methods.local_origins.get(name), int)
        }

    def scan_function(
        self,
        module_path: str,
        function: ast.FunctionDef | ast.AsyncFunctionDef,
        qualname: str,
        kind: str,
        context: ExportBindings | None = None,
    ) -> None:
        self.kinds[(module_path, qualname)] = kind
        if function.returns:
            self.returns[(module_path, qualname)] = function.returns
            self.return_contexts[(module_path, qualname)] = context.clone() if context else None
        for statement in walk_scope(function.body):
            if isinstance(statement, FUNCTIONS):
                self.scan_function(module_path, statement, f"{qualname}.{statement.name}", "function")
            elif isinstance(statement, ast.ClassDef):
                self.scan_class(module_path, statement, f"{qualname}.{statement.name}")

    def resolve_class_bases(self) -> None:
        for key, expressions in self.class_bases.items():
            context = self.base_contexts.get(key)
            targets = [self.locate_type_in_context(key[0], type_ref_of(base), context) for base in expressions]
            if all(target is not None for target in targets):
                self.resolved_bases[key] = [target for target in targets if target]
                self.complete_bases.add(key)

    def resolve_return_types(self) -> None:
        for key, annotation in self.returns.items():
            located = self.locate_type_in_context(
                key[0], type_ref_of(annotation), self.return_contexts.get(key)
            )
            if located:
                self.return_types[key] = located

    def locate_type_in_context(
        self,
        module_path: str,
        type_ref: str | None,
        context: ExportBindings | None,
    ) -> ClassKey | None:
        if not type_ref or context is None:
            return None
        parts = type_ref.split(".")
        imported = context.from_imports.get(parts[0])
        if imported:
            located = self.locate_symbol(imported[0], ".".join([imported[1], *parts[1:]]))
            return located if located and self.kind_of(*located) == "class" else None
        local = context.top_names.get(parts[0])
        if local:
            located = (module_path, ".".join([local, *parts[1:]]))
            return located if self.kind_of(*located) == "class" else None
        imported_module = context.module_imports.get(parts[0])
        return self.locate_qualified_type(imported_module, parts[1:]) if imported_module else None

    def locate_qualified_type(self, prefix: str, rest: list[str]) -> ClassKey | None:
        for split in range(len(rest), 0, -1):
            module = ".".join([prefix, *rest[:split]])
            actual = self.canonical_module(module)
            if actual and split < len(rest):
                located = self.locate_symbol(actual, ".".join(rest[split:]))
                if located and self.kind_of(*located) == "class":
                    return located
        actual = self.canonical_module(prefix)
        located = self.locate_symbol(actual, ".".join(rest)) if actual and rest else None
        return located if located and self.kind_of(*located) == "class" else None

def resolve_from_module_path(module_path: str, statement: ast.ImportFrom) -> str | None:
    if statement.level == 0:
        return statement.module
    package = module_path.removesuffix(".__init__").split(".")
    if not module_path.endswith(".__init__"):
        package = package[:-1]
    ascend = statement.level - 1
    if ascend > len(package):
        return None
    base = package[: len(package) - ascend]
    if statement.module:
        base.extend(statement.module.split("."))
    return ".".join(base) if base else None


def package_names(aliases: dict[str, str]) -> set[str]:
    packages: set[str] = set()
    for runtime_name in aliases:
        parts = runtime_name.split(".")
        for depth in range(1, len(parts)):
            packages.add(".".join(parts[:depth]))
    return packages


def walk_scope(body: list[ast.stmt]):
    stack: list[ast.AST] = list(reversed(body))
    while stack:
        node = stack.pop()
        yield node
        if isinstance(node, (*FUNCTIONS, ast.ClassDef, ast.Lambda)):
            continue
        stack.extend(reversed(list(ast.iter_child_nodes(node))))
