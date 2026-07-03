"""Per-module symbol table: imports, module-level defs/classes, and class attr types.

Resolution leans on three facts we can read statically: what names a module imports
(and from where), which top-level functions/classes it defines, and the declared type
of each ``self`` attribute. The last one is what lets ``self._pricing.price(...)`` find
``PricingService.price`` in another module without a type checker.
"""

from __future__ import annotations

import ast


class SymbolTable:
    """The names visible inside one module, indexed for call/attribute resolution."""

    def __init__(self, module_path: str, in_project: frozenset[str]) -> None:
        self.module_path = module_path
        self.in_project = in_project
        self.from_imports: dict[str, tuple[str, str]] = {}  # alias -> (module, original)
        self.module_imports: dict[str, str] = {}  # alias -> dotted module
        self.local_funcs: set[str] = set()
        self.local_classes: set[str] = set()
        self.class_methods: dict[str, set[str]] = {}
        self.class_attr_types: dict[str, dict[str, str]] = {}

    def scan(self, tree: ast.Module) -> None:
        for stmt in tree.body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.local_funcs.add(stmt.name)
            elif isinstance(stmt, ast.ClassDef):
                self.local_classes.add(stmt.name)
                self._scan_class(stmt)
            elif isinstance(stmt, ast.ImportFrom):
                self._scan_import_from(stmt)
            elif isinstance(stmt, ast.Import):
                self._scan_import(stmt)

    def _scan_import_from(self, stmt: ast.ImportFrom) -> None:
        base = resolve_from_module(self.module_path, stmt)
        if base is None:
            return
        for alias in stmt.names:
            self.from_imports[alias.asname or alias.name] = (base, alias.name)

    def _scan_import(self, stmt: ast.Import) -> None:
        for alias in stmt.names:
            self.module_imports[alias.asname or alias.name] = alias.name

    def _scan_class(self, classdef: ast.ClassDef) -> None:
        methods: set[str] = set()
        attr_types: dict[str, str] = {}
        for stmt in classdef.body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                methods.add(stmt.name)
                if stmt.name == "__init__":
                    self._scan_init(stmt, attr_types)
            elif isinstance(stmt, ast.AnnAssign):
                record_annotation(stmt, attr_types)
        self.class_methods[classdef.name] = methods
        self.class_attr_types[classdef.name] = attr_types

    def _scan_init(self, init: ast.FunctionDef | ast.AsyncFunctionDef, attr_types: dict[str, str]) -> None:
        param_types = params_to_types(init.args)
        for stmt in ast.walk(init):
            if isinstance(stmt, ast.AnnAssign):
                record_annotation(stmt, attr_types)
            elif isinstance(stmt, ast.Assign):
                bind_self_attr(stmt, param_types, attr_types)


def resolve_from_module(module_path: str, stmt: ast.ImportFrom) -> str | None:
    """Resolve a ``from ... import`` to the dotted module the imported names live in.

    Relative imports ascend from the importing module's package: ``level==1`` stays in it,
    each extra dot climbs one more package, then the explicit ``from`` module is appended.
    """
    if stmt.level == 0:
        return stmt.module  # absolute; may well be an external/stdlib module
    package = module_path.split(".")[:-1]
    ascend = stmt.level - 1
    if ascend > len(package):
        return None  # the import escapes the project root; treat as unknown
    base = package[: len(package) - ascend]
    if stmt.module:
        base = base + stmt.module.split(".")
    return ".".join(base) if base else None


def params_to_types(args: ast.arguments) -> dict[str, str]:
    """Map each annotated parameter to its simple type name (for ``self._x = param``)."""
    result: dict[str, str] = {}
    for param in args.posonlyargs + args.args + args.kwonlyargs:
        type_name = type_name_of(param.annotation) if param.annotation else None
        if type_name:
            result[param.arg] = type_name
    return result


def bind_self_attr(assign: ast.Assign, param_types: dict[str, str], attr_types: dict[str, str]) -> None:
    """Learn ``self._x``'s type from ``self._x = param`` where ``param`` was annotated."""
    if len(assign.targets) != 1 or not is_self_attr(assign.targets[0]):
        return
    value = assign.value
    if isinstance(value, ast.Name) and value.id in param_types:
        attr_types[assign.targets[0].attr] = param_types[value.id]


def record_annotation(stmt: ast.AnnAssign, attr_types: dict[str, str]) -> None:
    """Record ``x: T`` (class-level) or ``self.x: T`` (in ``__init__``) attribute types."""
    type_name = type_name_of(stmt.annotation)
    if type_name is None:
        return
    if isinstance(stmt.target, ast.Name):
        attr_types[stmt.target.id] = type_name
    elif is_self_attr(stmt.target):
        attr_types[stmt.target.attr] = type_name


def type_name_of(annotation: ast.expr | None) -> str | None:
    """Best-effort simple type name: ``Name`` directly, or the base of a subscript."""
    if isinstance(annotation, ast.Name):
        return annotation.id
    if isinstance(annotation, ast.Subscript):
        return type_name_of(annotation.value)
    return None


def is_self_attr(node: ast.expr) -> bool:
    return (
        isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Name)
        and node.value.id in ("self", "cls")
    )
