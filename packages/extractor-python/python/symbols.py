"""Module and lexical-scope bindings for conservative Python resolution."""

from __future__ import annotations

import ast
from dataclasses import dataclass

from inference import infer_value_type, params_to_types, type_ref_of
from project import ProjectIndex
from scope import ScopeBindings, clone_scope
from scope_flow import bind_body, bind_statement, function_start


FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)


@dataclass(frozen=True)
class TypeIdentity:
    """Stable identity for an annotated type, whether project-owned or external."""

    resolution: str
    module: str
    qualname: str
    target_line: int | None = None


class SymbolTable:
    def __init__(self, module_path: str, project: ProjectIndex) -> None:
        self.module_path = module_path
        self.project = project
        self.module_scope = ScopeBindings()
        self.class_attr_types: dict[str, dict[str, TypeIdentity]] = {}

    def scan(self, tree: ast.Module) -> None:
        scope = ScopeBindings()
        for statement in tree.body:
            if isinstance(statement, ast.ClassDef):
                self.scan_class(statement, statement.name, scope, scope)
            bind_statement(statement, scope, self.module_path, None)
        self.module_scope = scope

    def scan_class(
        self,
        classdef: ast.ClassDef,
        qualname: str,
        definition_scope: ScopeBindings,
        lexical_scope: ScopeBindings,
    ) -> None:
        attr_types: dict[str, TypeIdentity] = {}
        class_scope = clone_scope(lexical_scope)
        for statement in classdef.body:
            if isinstance(statement, FUNCTIONS) and statement.name == "__init__":
                self.scan_init(statement, attr_types, class_scope)
            elif isinstance(statement, ast.AnnAssign):
                self.record_class_annotation(statement, attr_types, class_scope)
            elif isinstance(statement, ast.ClassDef):
                self.scan_class(
                    statement, f"{qualname}.{statement.name}", class_scope, lexical_scope
                )
            bind_statement(statement, class_scope, self.module_path, qualname)
        self.class_attr_types[qualname] = attr_types

    def scan_init(
        self,
        init: ast.FunctionDef | ast.AsyncFunctionDef,
        attr_types: dict[str, TypeIdentity],
        definition_scope: ScopeBindings,
    ) -> None:
        param_refs = params_to_types(init.args)
        param_types = {
            name: located
            for name, ref in param_refs.items()
            if (located := self.locate_type(ref, definition_scope))
        }
        for node in walk_scope(init.body):
            if isinstance(node, ast.AnnAssign) and is_self_attr(node.target):
                located = self.locate_type(type_ref_of(node.annotation) or "", definition_scope)
                if located:
                    attr_types[node.target.attr] = located
            elif isinstance(node, ast.Assign) and len(node.targets) == 1 and is_self_attr(node.targets[0]):
                located = param_types.get(node.value.id) if isinstance(node.value, ast.Name) else None
                type_ref = infer_value_type(node.value, param_refs)
                located = located or (self.locate_type(type_ref, definition_scope) if type_ref else None)
                if located:
                    attr_types[node.targets[0].attr] = located

    def record_class_annotation(
        self,
        statement: ast.AnnAssign,
        attr_types: dict[str, TypeIdentity],
        scope: ScopeBindings,
    ) -> None:
        if isinstance(statement.target, ast.Name):
            located = self.locate_type(type_ref_of(statement.annotation) or "", scope)
            if located:
                attr_types[statement.target.id] = located

    def scope_for(
        self,
        function: ast.FunctionDef | ast.AsyncFunctionDef,
        qualname: str,
        enclosing: ScopeBindings,
        receiver_class: str | None = None,
    ) -> ScopeBindings:
        scope = function_start(function, enclosing, receiver_class, self.module_scope)
        nested_scope = clone_scope(scope)
        for statement in function.body:
            if isinstance(statement, ast.ClassDef):
                self.scan_class(
                    statement, f"{qualname}.{statement.name}", nested_scope, nested_scope
                )
            bind_statement(statement, nested_scope, self.module_path, qualname)
        bind_body(function.body, scope, self.module_path, qualname)
        return scope

    def locate_type(self, type_ref: str, scope: ScopeBindings) -> TypeIdentity | None:
        parts = type_ref.split(".")
        root = parts[0]
        if not type_ref or root in scope.shadowed:
            return None
        definition = scope.definitions.get(type_ref)
        if definition and self.project.kind_of(self.module_path, definition) == "class":
            origin = scope.definition_origins.get(type_ref)
            return TypeIdentity(
                "resolved",
                self.module_path,
                definition,
                origin if isinstance(origin, int) else self.project.unique_class_line(self.module_path, definition),
            )
        if root in scope.from_imports:
            module, imported_name = scope.from_imports[root]
            imported_qualname = ".".join([imported_name, *parts[1:]])
            located = locate_imported_type_target(self.project, module, imported_name, parts[1:])
            if located:
                return TypeIdentity("resolved", *located)
            if self.project.import_target(module) is None:
                return TypeIdentity("external", module, imported_qualname)
            return None
        if root in scope.module_imports:
            prefix = scope.module_imports[root]
            located = locate_qualified_type_target(self.project, prefix, parts[1:])
            if located:
                return TypeIdentity("resolved", *located)
            if parts[1:] and self.project.import_target(prefix) is None:
                return locate_external_qualified_type(
                    root,
                    prefix,
                    parts[1:],
                    scope.module_import_paths.get(root, {prefix}),
                )
            return None
        located = self.project.symbol_target(self.module_path, type_ref)
        if located and self.project.kind_of(located[0], located[1]) == "class":
            return TypeIdentity("resolved", *located)
        return None

    def locate_type_target(
        self,
        type_ref: str,
        scope: ScopeBindings,
    ) -> tuple[str, str, int | None] | None:
        located = self.locate_type(type_ref, scope)
        if not located or located.resolution != "resolved":
            return None
        return located.module, located.qualname, located.target_line


def walk_scope(body: list[ast.stmt]):
    stack: list[ast.AST] = list(reversed(body))
    while stack:
        node = stack.pop()
        yield node
        if isinstance(node, (*FUNCTIONS, ast.ClassDef, ast.Lambda)):
            continue
        stack.extend(reversed(list(ast.iter_child_nodes(node))))


def locate_qualified_type(project: ProjectIndex, prefix: str, rest: list[str]) -> tuple[str, str] | None:
    located = locate_qualified_type_target(project, prefix, rest)
    return (located[0], located[1]) if located else None


def locate_qualified_type_target(
    project: ProjectIndex,
    prefix: str,
    rest: list[str],
) -> tuple[str, str, int | None] | None:
    for split in range(len(rest), -1, -1):
        module = ".".join([prefix, *rest[:split]])
        actual = project.canonical_module(module)
        if actual and split < len(rest):
            located = project.symbol_target(actual, ".".join(rest[split:]))
            if located and project.kind_of(located[0], located[1]) == "class":
                return located
    return None


def locate_imported_type_target(
    project: ProjectIndex,
    module: str,
    imported_name: str,
    rest: list[str],
) -> tuple[str, str, int | None] | None:
    located = project.symbol_target(module, imported_name)
    if not located:
        return None
    qualname = ".".join([located[1], *rest])
    candidate = (located[0], qualname)
    if project.kind_of(*candidate) != "class":
        return None
    return (*candidate, located[2] if not rest else project.unique_class_line(*candidate))


def locate_external_qualified_type(
    binding: str,
    runtime_prefix: str,
    rest: list[str],
    imported_paths: set[str],
) -> TypeIdentity:
    if runtime_prefix != binding:
        return TypeIdentity("external", runtime_prefix, ".".join(rest))
    ordered_paths = sorted(
        imported_paths,
        key=lambda value: len(value.split(".")),
        reverse=True,
    )
    for imported_path in ordered_paths:
        module_parts = imported_path.split(".")
        suffix = module_parts[1:] if module_parts[0] == binding else []
        if suffix and rest[: len(suffix)] == suffix and len(rest) > len(suffix):
            return TypeIdentity(
                "external",
                imported_path,
                ".".join(rest[len(suffix) :]),
            )
    return TypeIdentity("external", runtime_prefix, ".".join(rest))


def is_self_attr(node: ast.expr) -> bool:
    return isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in ("self", "cls")
