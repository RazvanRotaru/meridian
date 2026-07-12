"""Conservative static resolution for Python names and attribute chains."""

from __future__ import annotations

import ast
import builtins

from inference import expression_name
from scope import ScopeBindings
from symbols import SymbolTable


BUILTIN_NAMES = frozenset(dir(builtins))
UNRESOLVED = {"resolution": "unresolved"}


def resolved(module_path: str, qualname: str | None = None, target_line: int | None = None) -> dict:
    target = {"resolution": "resolved", "modulePath": module_path, "qualname": qualname}
    if target_line is not None:
        target["targetLine"] = target_line
    return target


def external(module: str, name: str | None = None) -> dict:
    return {"resolution": "external", "module": module, "name": name}


def resolve_callee(
    function: ast.expr,
    table: SymbolTable,
    scope: ScopeBindings,
    class_name: str | None,
) -> dict:
    if isinstance(function, ast.Name):
        return resolve_name(function.id, table, scope)
    if isinstance(function, ast.Attribute):
        return resolve_attribute(function, table, scope, class_name)
    return UNRESOLVED


def resolve_base(base: ast.expr, table: SymbolTable, scope: ScopeBindings) -> dict:
    expression = base.value if isinstance(base, ast.Subscript) else base
    return resolve_callee(expression, table, scope, None)


def resolve_name(name: str, table: SymbolTable, scope: ScopeBindings) -> dict:
    if name in scope.shadowed:
        return UNRESOLVED
    definition = scope.definitions.get(name)
    if definition:
        origin = scope.definition_origins.get(name)
        return resolved(table.module_path, definition, origin if isinstance(origin, int) else None)
    imported = scope.from_imports.get(name)
    if imported:
        located = table.project.symbol_target(*imported)
        if located:
            return resolved(*located)
        submodule = table.project.locate_submodule(*imported)
        if submodule:
            return resolved(submodule)
        return UNRESOLVED if table.project.import_target(imported[0]) else external(*imported)
    if name in scope.module_imports:
        module = scope.module_imports[name]
        target = table.project.import_target(module)
        return resolved(target) if target else external(module)
    if name in BUILTIN_NAMES:
        return external("builtins", name)
    return UNRESOLVED


def resolve_attribute(
    attribute: ast.Attribute,
    table: SymbolTable,
    scope: ScopeBindings,
    class_name: str | None,
) -> dict:
    value = attribute.value
    if isinstance(value, ast.Name) and value.id in scope.receivers:
        return resolve_receiver_method(attribute.attr, table, scope.receivers[value.id])
    if is_receiver_attr(value, scope):
        owner = scope.receivers[value.value.id]  # type: ignore[union-attr]
        return resolve_receiver_field(value.attr, attribute.attr, table, scope, owner)
    if isinstance(value, ast.Name) and value.id in scope.local_types:
        return resolve_typed_method(scope.local_types[value.id], attribute.attr, table, scope)
    if is_super_call(value):
        return resolve_super_method(attribute.attr, table, class_name)
    if isinstance(value, ast.Call):
        return resolve_return_method(value, attribute.attr, table, scope, class_name)
    chained = resolve_attribute_chain(attribute, table, scope)
    if chained["resolution"] != "unresolved":
        return chained
    return resolve_class_attribute(attribute, table, scope)


def resolve_receiver_method(method: str, table: SymbolTable, class_name: str) -> dict:
    target = table.project.method_target(table.module_path, class_name, method)
    return resolved(*target) if target else UNRESOLVED


def resolve_receiver_field(
    field: str,
    method: str,
    table: SymbolTable,
    scope: ScopeBindings,
    class_name: str,
) -> dict:
    type_ref = table.class_attr_types.get(class_name, {}).get(field)
    return resolve_typed_method(type_ref, method, table, scope)


def resolve_typed_method(
    type_ref: str | tuple[str, str] | None,
    method: str,
    table: SymbolTable,
    scope: ScopeBindings,
) -> dict:
    located = type_ref if isinstance(type_ref, tuple) else table.locate_type(type_ref, scope) if type_ref else None
    if not located:
        return UNRESOLVED
    target = table.project.method_target(*located, method)
    return resolved(*target) if target else UNRESOLVED


def resolve_super_method(method: str, table: SymbolTable, class_name: str | None) -> dict:
    if not class_name:
        return UNRESOLVED
    target = table.project.super_method_target(table.module_path, class_name, method)
    return resolved(*target) if target else UNRESOLVED


def resolve_return_method(
    call: ast.Call,
    method: str,
    table: SymbolTable,
    scope: ScopeBindings,
    class_name: str | None,
) -> dict:
    target = resolve_callee(call.func, table, scope, class_name)
    if target["resolution"] != "resolved" or not target.get("qualname"):
        return UNRESOLVED
    located = table.project.return_target(target["modulePath"], target["qualname"])
    method_target = table.project.method_target(*located, method) if located else None
    return resolved(*method_target) if method_target else UNRESOLVED


def resolve_attribute_chain(attribute: ast.Attribute, table: SymbolTable, scope: ScopeBindings) -> dict:
    parts = attribute_parts(attribute)
    if not parts or len(parts) < 2:
        return UNRESOLVED
    root, tail = parts[0], parts[1:]
    if root in scope.module_imports:
        return resolve_module_tail(scope.module_imports[root], tail, table)
    imported = scope.from_imports.get(root)
    if imported:
        submodule = table.project.locate_submodule(*imported)
        if submodule:
            return resolve_module_tail(submodule, tail, table)
        located = table.project.locate_symbol(*imported)
        if located and table.project.kind_of(*located) == "class" and len(tail) == 1:
            target = table.project.method_target(*located, tail[0])
            return resolved(*target) if target else UNRESOLVED
    return UNRESOLVED


def resolve_module_tail(module: str, tail: list[str], table: SymbolTable) -> dict:
    runtime = module.removesuffix(".__init__")
    for split in range(len(tail) - 1, -1, -1):
        candidate = ".".join([runtime, *tail[:split]])
        actual = table.project.canonical_module(candidate)
        if not actual:
            continue
        qualname = ".".join(tail[split:])
        located = table.project.symbol_target(actual, qualname)
        if located:
            return resolved(*located)
        if table.project.kind_of(actual, qualname):
            return resolved(actual, qualname)
        return UNRESOLVED
    return external(module, ".".join(tail)) if table.project.import_target(module) is None else UNRESOLVED


def resolve_class_attribute(attribute: ast.Attribute, table: SymbolTable, scope: ScopeBindings) -> dict:
    if not isinstance(attribute.value, ast.Name):
        return UNRESOLVED
    owner = resolve_name(attribute.value.id, table, scope)
    if owner["resolution"] != "resolved" or not owner.get("qualname"):
        return UNRESOLVED
    if table.project.kind_of(owner["modulePath"], owner["qualname"]) != "class":
        return UNRESOLVED
    target = table.project.method_target(owner["modulePath"], owner["qualname"], attribute.attr)
    return resolved(*target) if target else UNRESOLVED
def attribute_parts(expression: ast.expr) -> list[str] | None:
    name = expression_name(expression)
    return name.split(".") if name else None
def is_super_call(expression: ast.expr) -> bool:
    return isinstance(expression, ast.Call) and isinstance(expression.func, ast.Name) and expression.func.id == "super"


def is_receiver_attr(expression: ast.expr, scope: ScopeBindings) -> bool:
    return (
        isinstance(expression, ast.Attribute)
        and isinstance(expression.value, ast.Name)
        and expression.value.id in scope.receivers
    )
