"""AST traversal that emits calls, inheritance, imports, and type/value references."""

from __future__ import annotations

import ast

from bindings import bound_names
from definitions import FUNCTIONS, qualify
from inference import expression_name, infer_value_type, parameter_names
from project import resolve_from_module_path
from resolve import external, resolve_base, resolve_callee, resolve_type_reference, resolved
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
        if isinstance(statement, ast.AnnAssign):
            self.collect_annotation_references(statement.annotation, source, scope)
        self.collect_calls(statement, source, method_class, scope)
        if isinstance(statement, ast.Return):
            self.collect_protocol_implementation(statement, source, method_class, scope)
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
        for annotation in callable_annotations(function):
            self.collect_annotation_references(annotation, qualname, definition_scope)
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
            target = resolve_base(base, self.table, definition_scope)
            kind = (
                "implements"
                if self.is_concrete_protocol_base(qualname, classdef.lineno, target)
                else "extends"
            )
            self.append(kind, qualname, base, target, confidence=1 if kind == "implements" else None)
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

    def collect_protocol_implementation(
        self,
        statement: ast.Return,
        source: str | None,
        class_name: str | None,
        scope: ScopeBindings,
    ) -> None:
        """Infer declared conformance from the value returned under a Protocol annotation.

        The return expression is the evidence boundary: pairing the annotation with every class
        constructed in this function would incorrectly mark helpers as implementations. Python's
        stdlib AST cannot prove full structural assignability, so the emitted edge carries bounded
        confidence instead of masquerading as an explicit base declaration.
        """
        if source is None or statement.value is None:
            return
        contract = self.table.project.return_target_info(
            self.table.module_path,
            source,
            self.source_lines.get(source),
        )
        if contract is None or not self.table.project.is_protocol(*contract):
            return
        implementation = self.returned_class(statement.value, class_name, scope)
        if implementation is None:
            return
        implementation_key = (
            implementation["modulePath"],
            implementation["qualname"],
            implementation.get("targetLine"),
        )
        if implementation_key == contract or self.table.project.is_protocol(*implementation_key):
            return
        self.append_from_target(
            "implements",
            implementation,
            statement.value,
            resolved(*contract),
            confidence=0.8,
        )

    def returned_class(
        self,
        value: ast.expr,
        class_name: str | None,
        scope: ScopeBindings,
    ) -> dict | None:
        if isinstance(value, ast.Call):
            target = resolve_callee(value.func, self.table, scope, class_name)
            if self.is_class_target(target):
                return target
            if target["resolution"] == "resolved" and target.get("qualname"):
                returned = self.table.project.return_target_info(
                    target["modulePath"],
                    target["qualname"],
                    target.get("targetLine"),
                )
                if returned:
                    candidate = resolved(*returned)
                    return candidate if self.is_class_target(candidate) else None
        inferred = infer_value_type(value, scope.local_types)
        located = self.table.locate_type_target(inferred, scope) if inferred else None
        candidate = resolved(*located) if located else None
        return candidate if candidate and self.is_class_target(candidate) else None

    def is_class_target(self, target: dict) -> bool:
        return (
            target["resolution"] == "resolved"
            and bool(target.get("qualname"))
            and self.table.project.kind_of(target["modulePath"], target["qualname"]) == "class"
        )

    def is_concrete_protocol_base(self, qualname: str, line: int, target: dict) -> bool:
        return (
            target["resolution"] == "resolved"
            and bool(target.get("qualname"))
            and not self.table.project.is_protocol(self.table.module_path, qualname, line)
            and self.table.project.is_protocol(
                target["modulePath"],
                target["qualname"],
                target.get("targetLine"),
            )
        )

    def collect_calls(
        self,
        node: ast.AST,
        source: str | None,
        class_name: str | None,
        scope: ScopeBindings,
    ) -> None:
        if isinstance(node, (*FUNCTIONS, ast.ClassDef)):
            return
        if isinstance(node, ast.Lambda):
            nested = clone_scope(scope)
            for name in parameter_names(node.args):
                bind_local(name, None, nested)
            self.collect_calls(node.body, source, class_name, nested)
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

    def collect_annotation_references(
        self,
        annotation: ast.expr,
        source: str | None,
        scope: ScopeBindings,
    ) -> None:
        for type_ref, site in annotation_references(annotation):
            target = resolve_type_reference(type_ref, self.table, scope)
            if target["resolution"] != "unresolved":
                self.append("reference", source, site, target)

    def collect_imports(self, tree: ast.Module) -> None:
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.append("imports", None, node, module_target(alias.name, self.table))
            elif isinstance(node, ast.ImportFrom):
                module = resolve_from_module_path(self.table.module_path, node)
                if module:
                    target = module_target(module, self.table)
                    if target["resolution"] == "resolved":
                        self.append("imports", None, node, target)
                    else:
                        for alias in node.names:
                            name = None if alias.name == "*" else alias.name
                            self.append("imports", None, node, external(module, name))

    def append(
        self,
        kind: str,
        source: str | None,
        site: ast.AST,
        target: dict,
        confidence: float | None = None,
    ) -> None:
        edge = {
            "kind": kind,
            "sourceQualname": source,
            "sourceLine": self.source_lines.get(source) if source else None,
            **source_range(site),
            "target": target,
        }
        if confidence is not None:
            edge["confidence"] = confidence
        self.edges.append(edge)

    def append_from_target(
        self,
        kind: str,
        source: dict,
        site: ast.AST,
        target: dict,
        confidence: float | None = None,
    ) -> None:
        """Append a relationship whose source may be declared in a different module."""
        edge = {
            "kind": kind,
            "sourceModulePath": source["modulePath"],
            "sourceQualname": source["qualname"],
            "sourceLine": source.get("targetLine"),
            **source_range(site),
            "target": target,
        }
        if confidence is not None:
            edge["confidence"] = confidence
        self.edges.append(edge)


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


def callable_annotations(
    function: ast.FunctionDef | ast.AsyncFunctionDef,
) -> list[ast.expr]:
    positional = [*function.args.posonlyargs, *function.args.args, *function.args.kwonlyargs]
    annotations = [parameter.annotation for parameter in positional if parameter.annotation]
    if function.args.vararg and function.args.vararg.annotation:
        annotations.append(function.args.vararg.annotation)
    if function.args.kwarg and function.args.kwarg.annotation:
        annotations.append(function.args.kwarg.annotation)
    if function.returns:
        annotations.append(function.returns)
    return annotations


def annotation_references(
    annotation: ast.expr,
    anchor: ast.AST | None = None,
) -> list[tuple[str, ast.AST]]:
    site = anchor or annotation
    if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
        try:
            parsed = ast.parse(annotation.value, mode="eval")
        except SyntaxError:
            return []
        return annotation_references(parsed.body, site)  # type: ignore[attr-defined]
    if isinstance(annotation, (ast.Name, ast.Attribute)):
        name = expression_name(annotation)
        return [(name, site)] if name else []
    if isinstance(annotation, ast.BinOp) and isinstance(annotation.op, ast.BitOr):
        return [
            *annotation_references(annotation.left, anchor),
            *annotation_references(annotation.right, anchor),
        ]
    if isinstance(annotation, ast.Subscript):
        references = annotation_references(annotation.value, anchor)
        wrapper = expression_name(annotation.value)
        wrapper_name = wrapper.split(".")[-1] if wrapper else ""
        if wrapper_name == "Literal":
            return references
        elements = annotation.slice.elts if isinstance(annotation.slice, ast.Tuple) else [annotation.slice]
        if wrapper_name == "Annotated":
            elements = elements[:1]
        for element in elements:
            references.extend(annotation_references(element, anchor))
        return references
    if isinstance(annotation, (ast.Tuple, ast.List)):
        return [
            reference
            for element in annotation.elts
            for reference in annotation_references(element, anchor)
        ]
    if isinstance(annotation, ast.Starred):
        return annotation_references(annotation.value, anchor)
    return []


def source_range(node: ast.AST) -> dict:
    line = getattr(node, "lineno", 1)
    col = getattr(node, "col_offset", 0) + 1
    end_line = getattr(node, "end_lineno", line) or line
    end_col = getattr(node, "end_col_offset", col - 1) + 1
    return {"line": line, "col": col, "endLine": end_line, "endCol": end_col}
