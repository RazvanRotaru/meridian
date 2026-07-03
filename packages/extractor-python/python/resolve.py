"""Static call/inheritance resolution and the per-module edge walk.

Every callee is resolved into one of three honest verdicts the artifact understands:
``resolved`` (we know the target module + qualname), ``external`` (a builtin or an
out-of-project module), or ``unresolved`` (we genuinely cannot tell). We never guess a
target we are unsure of -- a dropped edge is cheaper than a wrong one.
"""

from __future__ import annotations

import ast
import builtins

from symbols import SymbolTable, is_self_attr

BUILTIN_NAMES = frozenset(dir(builtins))


def resolved(module_path: str, qualname: str) -> dict:
    return {"resolution": "resolved", "modulePath": module_path, "qualname": qualname}


def external(module: str, name: str) -> dict:
    return {"resolution": "external", "module": module, "name": name}


UNRESOLVED = {"resolution": "unresolved"}


def resolve_callee(func: ast.expr, table: SymbolTable, class_name: str | None) -> dict:
    if isinstance(func, ast.Name):
        return resolve_name(func.id, table)
    if isinstance(func, ast.Attribute):
        return resolve_attribute(func, table, class_name)
    return UNRESOLVED


def resolve_base(base: ast.expr, table: SymbolTable) -> dict:
    if isinstance(base, ast.Name):
        return resolve_name(base.id, table)
    if isinstance(base, ast.Attribute):
        return resolve_attribute(base, table, None)
    return UNRESOLVED


def resolve_name(name: str, table: SymbolTable) -> dict:
    if name in table.local_classes or name in table.local_funcs:
        return resolved(table.module_path, name)
    if name in table.from_imports:
        module_path, original = table.from_imports[name]
        return resolved(module_path, original)
    if name in BUILTIN_NAMES:
        return external("builtins", name)
    return UNRESOLVED


def resolve_attribute(attr: ast.Attribute, table: SymbolTable, class_name: str | None) -> dict:
    value = attr.value
    if isinstance(value, ast.Name) and value.id in ("self", "cls"):
        return resolve_self_method(attr.attr, table, class_name)
    if is_self_attr(value):
        return resolve_self_field(value.attr, attr.attr, table, class_name)
    if isinstance(value, ast.Name) and value.id in table.module_imports:
        return resolve_module_attr(value.id, attr.attr, table)
    return UNRESOLVED


def resolve_self_method(method: str, table: SymbolTable, class_name: str | None) -> dict:
    if class_name and method in table.class_methods.get(class_name, set()):
        return resolved(table.module_path, f"{class_name}.{method}")
    return UNRESOLVED


def resolve_self_field(field: str, method: str, table: SymbolTable, class_name: str | None) -> dict:
    type_name = table.class_attr_types.get(class_name or "", {}).get(field)
    located = locate_type(type_name, table) if type_name else None
    if located is None:
        return UNRESOLVED
    module_path, class_qualname = located
    return resolved(module_path, f"{class_qualname}.{method}")


def resolve_module_attr(alias: str, attr: str, table: SymbolTable) -> dict:
    module_path = table.module_imports[alias]
    if module_path in table.in_project:
        return resolved(module_path, attr)
    return external(module_path, attr)


def locate_type(type_name: str, table: SymbolTable) -> tuple[str, str] | None:
    """Map a type name to ``(module, class qualname)`` via locals or the import table."""
    if type_name in table.local_classes:
        return table.module_path, type_name
    if type_name in table.from_imports:
        return table.from_imports[type_name]
    return None


class EdgeCollector:
    """Walks a module, emitting one edge per call site and per class base."""

    def __init__(self, table: SymbolTable, diagnostics: list[str], rel: str) -> None:
        self.table = table
        self.diagnostics = diagnostics
        self.rel = rel
        self.edges: list[dict] = []

    def visit_module(self, tree: ast.Module) -> None:
        for stmt in tree.body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._visit_callable(stmt, stmt.name, None)
            elif isinstance(stmt, ast.ClassDef):
                self._visit_class(stmt)
            else:
                self._collect_calls(stmt, None, None)

    def _visit_class(self, classdef: ast.ClassDef) -> None:
        for base in classdef.bases:
            target = resolve_base(base, self.table)
            self._append("extends", classdef.name, getattr(base, "lineno", classdef.lineno), target)
        for member in classdef.body:
            if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._visit_callable(member, f"{classdef.name}.{member.name}", classdef.name)
            else:
                self._collect_calls(member, None, classdef.name)

    def _visit_callable(self, func: ast.AST, source: str, class_name: str | None) -> None:
        for stmt in func.body:  # type: ignore[attr-defined]
            self._collect_calls(stmt, source, class_name)

    def _collect_calls(self, node: ast.AST, source: str | None, class_name: str | None) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            self.diagnostics.append(f"{self.rel}: skipped nested {type(node).__name__} {node.name} (v1 scope)")
            return  # v1 does not descend into nested functions/classes
        if isinstance(node, ast.Call):
            target = resolve_callee(node.func, self.table, class_name)
            self._append("call", source, node.lineno, target)
        for child in ast.iter_child_nodes(node):
            self._collect_calls(child, source, class_name)

    def _append(self, kind: str, source: str | None, line: int, target: dict) -> None:
        self.edges.append({"kind": kind, "sourceQualname": source, "line": line, "target": target})


def collect_edges(tree: ast.Module, table: SymbolTable, diagnostics: list[str], rel: str) -> list[dict]:
    collector = EdgeCollector(table, diagnostics, rel)
    collector.visit_module(tree)
    return collector.edges
