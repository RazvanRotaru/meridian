"""Source-ordered scope construction without executing project code."""

from __future__ import annotations

import ast

from bindings import bound_names, statement_bound_names
from inference import infer_value_type, parameter_names, params_to_types, type_ref_of
from scope import (
    ScopeBindings,
    bind_definition,
    bind_from_import,
    bind_local,
    bind_module_import,
    clone_scope,
    scan_imports,
)


FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)
MATCH = getattr(ast, "Match", None)


def function_start(
    function: ast.FunctionDef | ast.AsyncFunctionDef,
    enclosing: ScopeBindings,
    receiver_class: str | None = None,
    module_scope: ScopeBindings | None = None,
) -> ScopeBindings:
    scope = clone_scope(enclosing)
    globals_, nonlocals = declaration_names(function)
    for name in globals_:
        copy_binding(name, module_scope or ScopeBindings(), scope)
    declared_elsewhere = globals_ | nonlocals
    for name in local_names(function) - declared_elsewhere:
        bind_local(name, None, scope)
    parameter_types = params_to_types(function.args)
    for name in parameter_names(function.args):
        bind_local(name, parameter_types.get(name), scope)
    receiver = receiver_name(function) if receiver_class else None
    if receiver:
        scope.receivers[receiver] = receiver_class  # type: ignore[assignment]
    return scope


def bind_statement(
    statement: ast.stmt,
    scope: ScopeBindings,
    module_path: str,
    parent: str | None,
) -> None:
    if isinstance(statement, (*FUNCTIONS, ast.ClassDef)):
        bind_definition(statement.name, qualify(parent, statement.name), scope, statement.lineno)
    elif isinstance(statement, (ast.Import, ast.ImportFrom)):
        scan_imports([statement], module_path, scope)
    elif isinstance(statement, ast.If):
        bind_conditional(statement, scope, module_path, parent)
    elif isinstance(statement, (ast.Try, getattr(ast, "TryStar", ast.Try))):
        bind_try(statement, scope, module_path, parent)
    elif isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
        bind_loop(statement, scope, module_path, parent)
    elif isinstance(statement, (ast.With, ast.AsyncWith)):
        for item in statement.items:
            for name in bound_names(item.optional_vars):
                bind_local(name, None, scope)
        bind_body(statement.body, scope, module_path, parent)
    elif MATCH and isinstance(statement, MATCH):
        bind_match(statement, scope, module_path, parent)
    else:
        bind_simple(statement, scope)


def bind_body(body: list[ast.stmt], scope: ScopeBindings, module_path: str, parent: str | None) -> None:
    for statement in body:
        bind_statement(statement, scope, module_path, parent)


def bind_conditional(node: ast.If, scope: ScopeBindings, module_path: str, parent: str | None) -> None:
    bind_simple(node.test, scope)
    constant = constant_truth(node.test)
    if constant is not None:
        bind_body(node.body if constant else node.orelse, scope, module_path, parent)
        return
    outcomes = [branch_scope(scope, node.body, module_path, parent)]
    outcomes.append(branch_scope(scope, node.orelse, module_path, parent) if node.orelse else clone_scope(scope))
    merge_scopes(scope, outcomes)


def bind_try(node, scope: ScopeBindings, module_path: str, parent: str | None) -> None:
    normal = branch_scope(scope, [*node.body, *node.orelse], module_path, parent)
    outcomes = [normal]
    for handler in node.handlers:
        branch = clone_scope(scope)
        if handler.name:
            bind_local(handler.name, None, branch)
        bind_body(handler.body, branch, module_path, parent)
        outcomes.append(branch)
    merge_scopes(scope, outcomes)
    bind_body(node.finalbody, scope, module_path, parent)


def bind_loop(node, scope: ScopeBindings, module_path: str, parent: str | None) -> None:
    expression = node.iter if isinstance(node, (ast.For, ast.AsyncFor)) else node.test
    bind_simple(expression, scope)
    branch = clone_scope(scope)
    if isinstance(node, (ast.For, ast.AsyncFor)):
        for name in bound_names(node.target):
            bind_local(name, None, branch)
    bind_body(node.body, branch, module_path, parent)
    merge_scopes(scope, [scope, branch])
    bind_body(node.orelse, scope, module_path, parent)


def bind_match(node, scope: ScopeBindings, module_path: str, parent: str | None) -> None:
    outcomes = [clone_scope(scope)]
    for case in node.cases:
        branch = clone_scope(scope)
        for name in bound_names(case.pattern):
            bind_local(name, None, branch)
        if case.guard:
            bind_simple(case.guard, branch)
        bind_body(case.body, branch, module_path, parent)
        outcomes.append(branch)
    merge_scopes(scope, outcomes)


def bind_simple(node: ast.AST, scope: ScopeBindings) -> None:
    if isinstance(node, ast.Assign):
        inferred = infer_value_type(node.value, scope.local_types)
        for target in node.targets:
            for name in bound_names(target):
                bind_local(name, inferred, scope)
        return
    if isinstance(node, ast.AnnAssign):
        inferred = type_ref_of(node.annotation) or (infer_value_type(node.value, scope.local_types) if node.value else None)
        for name in bound_names(node.target):
            bind_local(name, inferred, scope)
        return
    for child in walk_binding_nodes(node):
        if isinstance(child, ast.NamedExpr):
            inferred = infer_value_type(child.value, scope.local_types)
            for name in bound_names(child.target):
                bind_local(name, inferred, scope)
        else:
            for name in statement_bound_names(child):
                bind_local(name, None, scope)


def merge_scopes(target: ScopeBindings, outcomes: list[ScopeBindings]) -> None:
    names = set().union(*(binding_names(scope) for scope in outcomes))
    merged = clone_scope(outcomes[0])
    for name in names:
        facts = [binding_fact(scope, name) for scope in outcomes]
        if any(fact != facts[0] for fact in facts[1:]):
            bind_local(name, None, merged)
    replace_scope(target, merged)


def branch_scope(base: ScopeBindings, body: list[ast.stmt], module_path: str, parent: str | None) -> ScopeBindings:
    branch = clone_scope(base)
    bind_body(body, branch, module_path, parent)
    return branch


def binding_names(scope: ScopeBindings) -> set[str]:
    return set().union(
        scope.from_imports,
        scope.module_imports,
        scope.module_import_paths,
        scope.local_types,
        scope.definitions,
        scope.shadowed,
        scope.receivers,
    )


def binding_fact(scope: ScopeBindings, name: str):
    if name in scope.receivers:
        return "receiver", scope.receivers[name]
    if name in scope.local_types:
        return "type", scope.local_types[name]
    if name in scope.definitions:
        return "definition", scope.definitions[name], scope.definition_origins.get(name)
    if name in scope.from_imports:
        return "from", scope.from_imports[name]
    if name in scope.module_imports:
        return (
            "module",
            scope.module_imports[name],
            frozenset(scope.module_import_paths.get(name, ())),
        )
    return ("shadowed",) if name in scope.shadowed else ("missing",)


def replace_scope(target: ScopeBindings, source: ScopeBindings) -> None:
    for field in (
        "from_imports",
        "module_imports",
        "module_import_paths",
        "local_types",
        "definitions",
        "definition_origins",
        "shadowed",
        "receivers",
    ):
        setattr(target, field, getattr(source, field))


def local_names(function: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    names: set[str] = set()
    for node in walk_binding_nodes(function):
        if isinstance(node, (*FUNCTIONS, ast.ClassDef)) and node is not function:
            names.add(node.name)
        elif isinstance(node, ast.Import):
            names.update(alias.asname or alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            names.update(alias.asname or alias.name for alias in node.names if alias.name != "*")
        else:
            names.update(statement_bound_names(node))
    return names


def declaration_names(function: ast.FunctionDef | ast.AsyncFunctionDef) -> tuple[set[str], set[str]]:
    globals_: set[str] = set()
    nonlocals: set[str] = set()
    for node in walk_binding_nodes(function):
        if isinstance(node, ast.Global):
            globals_.update(node.names)
        elif isinstance(node, ast.Nonlocal):
            nonlocals.update(node.names)
    return globals_, nonlocals


def copy_binding(name: str, source: ScopeBindings, target: ScopeBindings) -> None:
    bind_local(name, None, target)
    if name in source.receivers:
        target.receivers[name] = source.receivers[name]
    elif name in source.local_types:
        bind_local(name, source.local_types[name], target)
    elif name in source.definitions:
        bind_definition(
            name, source.definitions[name], target, source.definition_origins.get(name)
        )
    elif name in source.from_imports:
        bind_from_import(name, source.from_imports[name], target)
    elif name in source.module_imports:
        bind_module_import(name, source.module_imports[name], target)
        target.module_import_paths[name] = set(
            source.module_import_paths.get(name, (source.module_imports[name],))
        )


def walk_binding_nodes(root: ast.AST):
    stack = [root]
    while stack:
        node = stack.pop()
        yield node
        if node is not root and isinstance(node, (*FUNCTIONS, ast.ClassDef, ast.Lambda)):
            continue
        stack.extend(reversed(list(ast.iter_child_nodes(node))))


def receiver_name(function: ast.FunctionDef | ast.AsyncFunctionDef) -> str | None:
    decorators = {decorator_name(item) for item in function.decorator_list}
    positional = [*function.args.posonlyargs, *function.args.args]
    return positional[0].arg if positional and "staticmethod" not in decorators else None


def decorator_name(node: ast.expr) -> str | None:
    target = node.func if isinstance(node, ast.Call) else node
    return target.id if isinstance(target, ast.Name) else target.attr if isinstance(target, ast.Attribute) else None


def constant_truth(node: ast.expr) -> bool | None:
    return bool(node.value) if isinstance(node, ast.Constant) and isinstance(node.value, (bool, type(None))) else None


def qualify(parent: str | None, name: str) -> str:
    return f"{parent}.{name}" if parent else name
