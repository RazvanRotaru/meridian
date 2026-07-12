"""Control-flow-aware module export binding joins."""

from __future__ import annotations

import ast
from collections.abc import Callable

from bindings import bound_names, statement_bound_names
from exports import ExportBindings, merge_exports


FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)
MATCH = getattr(ast, "Match", None)
DefinitionCallback = Callable[[ast.AST, str, ExportBindings], None]


def scan_export_body(
    module_path: str,
    body: list[ast.stmt],
    bindings: ExportBindings,
    record: DefinitionCallback,
) -> None:
    for statement in body:
        scan_export_statement(module_path, statement, bindings, record)


def scan_export_statement(
    module_path: str,
    statement: ast.stmt,
    bindings: ExportBindings,
    record: DefinitionCallback,
) -> None:
    if isinstance(statement, FUNCTIONS):
        record(statement, "function", bindings.clone())
        bindings.bind_local(statement.name, statement.name, statement.lineno)
    elif isinstance(statement, ast.ClassDef):
        record(statement, "class", bindings.clone())
        bindings.bind_local(statement.name, statement.name, statement.lineno)
    elif isinstance(statement, ast.ImportFrom):
        bind_from_import(module_path, statement, bindings)
    elif isinstance(statement, ast.Import):
        for alias in statement.names:
            local_name = alias.asname or alias.name.split(".")[0]
            target = alias.name if alias.asname else alias.name.split(".")[0]
            bindings.bind_module(local_name, target)
    elif isinstance(statement, ast.If):
        scan_if(module_path, statement, bindings, record)
    elif isinstance(statement, (ast.Try, getattr(ast, "TryStar", ast.Try))):
        scan_try(module_path, statement, bindings, record)
    elif isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
        scan_loop(module_path, statement, bindings, record)
    elif isinstance(statement, (ast.With, ast.AsyncWith)):
        for item in statement.items:
            for name in bound_names(item.optional_vars):
                bindings.shadow(name)
        scan_export_body(module_path, statement.body, bindings, record)
    elif MATCH and isinstance(statement, MATCH):
        scan_match(module_path, statement, bindings, record)
    else:
        for name in statement_bound_names(statement):
            bindings.shadow(name)


def scan_if(module_path: str, node: ast.If, bindings: ExportBindings, record: DefinitionCallback) -> None:
    shadow_expression_bindings(node.test, bindings)
    constant = constant_truth(node.test)
    if constant is not None:
        scan_export_body(module_path, node.body if constant else node.orelse, bindings, record)
        return
    outcomes = [branch(module_path, node.body, bindings, record)]
    outcomes.append(branch(module_path, node.orelse, bindings, record) if node.orelse else bindings.clone())
    merge_exports(bindings, outcomes)


def scan_try(module_path: str, node, bindings: ExportBindings, record: DefinitionCallback) -> None:
    normal = branch(module_path, [*node.body, *node.orelse], bindings, record)
    outcomes = [normal]
    for handler in node.handlers:
        handled = bindings.clone()
        if handler.name:
            handled.shadow(handler.name)
        scan_export_body(module_path, handler.body, handled, record)
        outcomes.append(handled)
    merge_exports(bindings, outcomes)
    scan_export_body(module_path, node.finalbody, bindings, record)


def scan_loop(module_path: str, node, bindings: ExportBindings, record: DefinitionCallback) -> None:
    expression = node.iter if isinstance(node, (ast.For, ast.AsyncFor)) else node.test
    shadow_expression_bindings(expression, bindings)
    repeated = bindings.clone()
    if isinstance(node, (ast.For, ast.AsyncFor)):
        for name in bound_names(node.target):
            repeated.shadow(name)
    scan_export_body(module_path, node.body, repeated, record)
    merge_exports(bindings, [bindings.clone(), repeated])
    scan_export_body(module_path, node.orelse, bindings, record)


def scan_match(module_path: str, node, bindings: ExportBindings, record: DefinitionCallback) -> None:
    outcomes = [bindings.clone()]
    for case in node.cases:
        matched = bindings.clone()
        for name in bound_names(case.pattern):
            matched.shadow(name)
        if case.guard:
            shadow_expression_bindings(case.guard, matched)
        scan_export_body(module_path, case.body, matched, record)
        outcomes.append(matched)
    merge_exports(bindings, outcomes)


def branch(
    module_path: str,
    body: list[ast.stmt],
    base: ExportBindings,
    record: DefinitionCallback,
) -> ExportBindings:
    outcome = base.clone()
    scan_export_body(module_path, body, outcome, record)
    return outcome


def bind_from_import(module_path: str, node: ast.ImportFrom, bindings: ExportBindings) -> None:
    base = resolve_from_module_path(module_path, node)
    if base:
        for alias in node.names:
            if alias.name != "*":
                bindings.bind_reexport(alias.asname or alias.name, (base, alias.name))


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


def constant_truth(node: ast.expr) -> bool | None:
    return bool(node.value) if isinstance(node, ast.Constant) and isinstance(node.value, (bool, type(None))) else None


def shadow_expression_bindings(node: ast.AST, bindings: ExportBindings) -> None:
    for child in ast.walk(node):
        if isinstance(child, ast.NamedExpr):
            for name in bound_names(child.target):
                bindings.shadow(name)
