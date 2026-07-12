"""Module and lexical-scope bindings for conservative Python resolution."""

from __future__ import annotations

import ast

from inference import infer_value_type, params_to_types, type_ref_of
from project import ProjectIndex
from scope import ScopeBindings, clone_scope
from scope_flow import bind_body, bind_statement, function_start


FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)


class SymbolTable:
    def __init__(self, module_path: str, project: ProjectIndex) -> None:
        self.module_path = module_path
        self.project = project
        self.module_scope = ScopeBindings()
        self.class_attr_types: dict[str, dict[str, tuple[str, str]]] = {}

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
        attr_types: dict[str, tuple[str, str]] = {}
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
        attr_types: dict[str, tuple[str, str]],
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
        attr_types: dict[str, tuple[str, str]],
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

    def locate_type(self, type_ref: str, scope: ScopeBindings) -> tuple[str, str] | None:
        if type_ref.split(".", 1)[0] in scope.shadowed:
            return None
        definition = scope.definitions.get(type_ref)
        if definition and self.project.kind_of(self.module_path, definition) == "class":
            return self.module_path, definition
        if type_ref in scope.from_imports:
            return self.project.locate_symbol(*scope.from_imports[type_ref])
        parts = type_ref.split(".")
        if parts[0] in scope.module_imports:
            prefix = scope.module_imports[parts[0]]
            return locate_qualified_type(self.project, prefix, parts[1:])
        located = self.project.locate_symbol(self.module_path, type_ref)
        return located if located and self.project.kind_of(*located) == "class" else None


def walk_scope(body: list[ast.stmt]):
    stack: list[ast.AST] = list(reversed(body))
    while stack:
        node = stack.pop()
        yield node
        if isinstance(node, (*FUNCTIONS, ast.ClassDef, ast.Lambda)):
            continue
        stack.extend(reversed(list(ast.iter_child_nodes(node))))


def locate_qualified_type(project: ProjectIndex, prefix: str, rest: list[str]) -> tuple[str, str] | None:
    for split in range(len(rest), -1, -1):
        module = ".".join([prefix, *rest[:split]])
        actual = project.canonical_module(module)
        if actual and split < len(rest):
            located = project.locate_symbol(actual, ".".join(rest[split:]))
            if located and project.kind_of(*located) == "class":
                return located
    return None


def is_self_attr(node: ast.expr) -> bool:
    return isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in ("self", "cls")
