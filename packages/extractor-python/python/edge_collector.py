"""AST traversal that emits calls, inheritance, imports, and value references."""

from __future__ import annotations

import ast

from bindings import bound_names
from definitions import FUNCTIONS, qualify
from project import resolve_from_module_path
from resolve import external, resolve_base, resolve_callee, resolved
from scope import ScopeBindings, bind_local, clone_scope
from scope_flow import bind_simple, bind_statement, function_start, merge_scopes
from symbols import SymbolTable


MATCH = getattr(ast, "Match", None)


class EdgeCollector:
    def __init__(self, table: SymbolTable, value_refs: bool) -> None:
        self.table = table
        self.value_refs = value_refs
        self.edges: list[dict] = []
        self.source_lines: dict[str, int] = {}

    def visit_module(self, tree: ast.Module) -> None:
        self.collect_imports(tree)
        self.visit_body(tree.body, None, None, ScopeBindings(), self.table.module_scope)

    def visit_body(
        self,
        body: list[ast.stmt],
        parent: str | None,
        method_class: str | None,
        scope: ScopeBindings,
        closure_scope: ScopeBindings,
        definition_owner: str | None = None,
    ) -> None:
        for statement in body:
            if isinstance(statement, (*FUNCTIONS, ast.ClassDef)):
                owner = definition_owner if isinstance(statement, FUNCTIONS) else None
                class_body_scope = closure_scope if definition_owner and isinstance(statement, ast.ClassDef) else scope
                self.visit_definition(
                    statement, parent, owner, scope, closure_scope, class_body_scope
                )
            else:
                self.visit_statement(
                    statement, parent, method_class, scope, closure_scope, definition_owner
                )
            bind_statement(statement, scope, self.table.module_path, parent)

    def visit_statement(
        self,
        statement: ast.stmt,
        source: str | None,
        method_class: str | None,
        scope: ScopeBindings,
        closure_scope: ScopeBindings,
        definition_owner: str | None,
    ) -> None:
        if isinstance(statement, ast.If):
            self.collect_calls(statement.test, source, method_class, scope)
            tested = clone_scope(scope)
            bind_simple(statement.test, tested)
            bodies = [statement.body, statement.orelse]
            for body in bodies:
                branch = clone_scope(tested)
                self.visit_body(body, source, method_class, branch, closure_scope, definition_owner)
            return
        if isinstance(statement, (ast.Try, getattr(ast, "TryStar", ast.Try))):
            normal = clone_scope(scope)
            self.visit_body(statement.body, source, method_class, normal, closure_scope, definition_owner)
            self.visit_body(statement.orelse, source, method_class, normal, closure_scope, definition_owner)
            outcomes = [normal]
            handler_entry = clone_scope(scope)
            prefix = clone_scope(scope)
            prefixes = [clone_scope(prefix)]
            for nested in statement.body:
                bind_statement(nested, prefix, self.table.module_path, source)
                prefixes.append(clone_scope(prefix))
            merge_scopes(handler_entry, prefixes)
            for handler in statement.handlers:
                branch = clone_scope(handler_entry)
                if handler.name:
                    bind_local(handler.name, None, branch)
                self.visit_body(handler.body, source, method_class, branch, closure_scope, definition_owner)
                outcomes.append(branch)
            joined = clone_scope(scope)
            merge_scopes(joined, outcomes)
            self.visit_body(statement.finalbody, source, method_class, joined, closure_scope, definition_owner)
            return
        if isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
            expression = statement.iter if isinstance(statement, (ast.For, ast.AsyncFor)) else statement.test
            self.collect_calls(expression, source, method_class, scope)
            tested = clone_scope(scope)
            bind_simple(expression, tested)
            branch = clone_scope(tested)
            if isinstance(statement, (ast.For, ast.AsyncFor)):
                for name in bound_names(statement.target):
                    bind_local(name, None, branch)
            self.visit_body(statement.body, source, method_class, branch, closure_scope, definition_owner)
            joined = clone_scope(tested)
            merge_scopes(joined, [tested, branch])
            self.visit_body(statement.orelse, source, method_class, joined, closure_scope, definition_owner)
            return
        if isinstance(statement, (ast.With, ast.AsyncWith)):
            branch = clone_scope(scope)
            for item in statement.items:
                self.collect_calls(item.context_expr, source, method_class, branch)
                for name in bound_names(item.optional_vars):
                    bind_local(name, None, branch)
            self.visit_body(statement.body, source, method_class, branch, closure_scope, definition_owner)
            return
        if MATCH and isinstance(statement, MATCH):
            self.collect_calls(statement.subject, source, method_class, scope)
            for case in statement.cases:
                branch = clone_scope(scope)
                for name in bound_names(case.pattern):
                    bind_local(name, None, branch)
                if case.guard:
                    self.collect_calls(case.guard, source, method_class, branch)
                    bind_simple(case.guard, branch)
                self.visit_body(
                    case.body, source, method_class, branch, closure_scope, definition_owner
                )
            return
        self.collect_calls(statement, source, method_class, scope)
        self.visit_nested_definitions(
            statement, source, definition_owner, scope, closure_scope
        )

    def visit_definition(
        self,
        definition: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef,
        parent: str | None,
        method_class: str | None,
        definition_scope: ScopeBindings,
        body_scope: ScopeBindings,
        class_body_scope: ScopeBindings | None = None,
    ) -> None:
        qualname = qualify(parent, definition.name)
        self.source_lines[qualname] = definition.lineno
        if isinstance(definition, FUNCTIONS):
            self.visit_callable(definition, qualname, method_class, definition_scope, body_scope)
        else:
            self.visit_class(
                definition, qualname, definition_scope, body_scope, class_body_scope or definition_scope
            )

    def visit_callable(
        self,
        function: ast.FunctionDef | ast.AsyncFunctionDef,
        qualname: str,
        method_class: str | None,
        definition_scope: ScopeBindings,
        enclosing_scope: ScopeBindings,
    ) -> None:
        self.collect_definition_time_calls(function, qualname, definition_scope)
        final_scope = self.table.scope_for(function, qualname, enclosing_scope, method_class)
        scope = function_start(
            function, enclosing_scope, method_class, self.table.module_scope
        )
        self.visit_body(function.body, qualname, method_class, scope, final_scope)

    def visit_class(
        self,
        classdef: ast.ClassDef,
        qualname: str,
        definition_scope: ScopeBindings,
        enclosing_scope: ScopeBindings,
        class_body_scope: ScopeBindings,
    ) -> None:
        for base in classdef.bases:
            self.append("extends", qualname, base, resolve_base(base, self.table, definition_scope))
        for expression in [*classdef.decorator_list, *classdef.keywords]:
            node = expression.value if isinstance(expression, ast.keyword) else expression
            self.collect_calls(node, qualname, None, definition_scope)
        self.visit_body(
            classdef.body, qualname, None, clone_scope(class_body_scope), enclosing_scope, qualname
        )

    def visit_nested_definitions(
        self,
        node: ast.AST,
        parent: str | None,
        method_class: str | None,
        scope: ScopeBindings,
        body_scope: ScopeBindings,
    ) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (*FUNCTIONS, ast.ClassDef)):
                owner = method_class if isinstance(child, FUNCTIONS) else None
                nested_body = body_scope if method_class and isinstance(child, ast.ClassDef) else scope
                self.visit_definition(child, parent, owner, scope, body_scope, nested_body)
            elif not isinstance(child, ast.Lambda):
                self.visit_nested_definitions(child, parent, method_class, scope, body_scope)

    def collect_definition_time_calls(
        self,
        function: ast.FunctionDef | ast.AsyncFunctionDef,
        source: str,
        scope: ScopeBindings,
    ) -> None:
        expressions: list[ast.expr] = [*function.decorator_list, *function.args.defaults]
        expressions.extend(default for default in function.args.kw_defaults if default is not None)
        for expression in expressions:
            self.collect_calls(expression, source, None, scope)

    def collect_calls(
        self,
        node: ast.AST,
        source: str | None,
        class_name: str | None,
        scope: ScopeBindings,
    ) -> None:
        if isinstance(node, (*FUNCTIONS, ast.ClassDef, ast.Lambda)):
            return
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            self.collect_comprehension(node, source, class_name, scope)
            return
        if isinstance(node, ast.Call):
            self.append("call", source, node, resolve_callee(node.func, self.table, scope, class_name))
            if self.value_refs:
                for argument in [*node.args, *(keyword.value for keyword in node.keywords)]:
                    self.collect_references(argument, source, class_name, scope)
        for child in ast.iter_child_nodes(node):
            self.collect_calls(child, source, class_name, scope)

    def collect_comprehension(self, node, source, class_name, scope) -> None:
        nested = clone_scope(scope)
        for generator in node.generators:
            self.collect_calls(generator.iter, source, class_name, nested)
            for name in bound_names(generator.target):
                bind_local(name, None, nested)
            for condition in generator.ifs:
                self.collect_calls(condition, source, class_name, nested)
        expressions = [node.key, node.value] if isinstance(node, ast.DictComp) else [node.elt]
        for expression in expressions:
            self.collect_calls(expression, source, class_name, nested)

    def collect_references(
        self,
        node: ast.AST,
        source: str | None,
        class_name: str | None,
        scope: ScopeBindings,
    ) -> None:
        if isinstance(node, ast.Call):
            return
        if isinstance(node, (ast.Name, ast.Attribute)):
            target = resolve_callee(node, self.table, scope, class_name)
            if is_callable_target(target, self.table):
                self.append("reference", source, node, target)
            if isinstance(node, ast.Attribute):
                return
        for child in ast.iter_child_nodes(node):
            self.collect_references(child, source, class_name, scope)

    def collect_imports(self, tree: ast.Module) -> None:
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.append("imports", None, node, module_target(alias.name, self.table))
            elif isinstance(node, ast.ImportFrom):
                module = resolve_from_module_path(self.table.module_path, node)
                if module:
                    self.append("imports", None, node, module_target(module, self.table))

    def append(self, kind: str, source: str | None, site: ast.AST, target: dict) -> None:
        self.edges.append(
            {
                "kind": kind,
                "sourceQualname": source,
                "sourceLine": self.source_lines.get(source) if source else None,
                **source_range(site),
                "target": target,
            }
        )


def collect_edges(tree: ast.Module, table: SymbolTable, value_refs: bool) -> list[dict]:
    collector = EdgeCollector(table, value_refs)
    collector.visit_module(tree)
    return collector.edges


def module_target(module: str, table: SymbolTable) -> dict:
    target = table.project.import_target(module)
    return resolved(target) if target else external(module)


def is_callable_target(target: dict, table: SymbolTable) -> bool:
    if target["resolution"] != "resolved" or not target.get("qualname"):
        return False
    return table.project.kind_of(target["modulePath"], target["qualname"]) in {"class", "function", "method"}


def source_range(node: ast.AST) -> dict:
    line = getattr(node, "lineno", 1)
    col = getattr(node, "col_offset", 0) + 1
    end_line = getattr(node, "end_lineno", line) or line
    end_col = getattr(node, "end_col_offset", col - 1) + 1
    return {"line": line, "col": col, "endLine": end_line, "endCol": end_col}
