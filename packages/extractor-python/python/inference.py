"""Small, dependency-free helpers for annotation and assignment type hints."""

from __future__ import annotations

import ast


OPTIONAL_WRAPPERS = frozenset(
    {"Annotated", "ClassVar", "Final", "NotRequired", "Optional", "Required", "Union"}
)


def params_to_types(args: ast.arguments) -> dict[str, str]:
    result: dict[str, str] = {}
    for parameter in args.posonlyargs + args.args + args.kwonlyargs:
        type_ref = type_ref_of(parameter.annotation)
        if type_ref:
            result[parameter.arg] = type_ref
    if args.vararg and (type_ref := type_ref_of(args.vararg.annotation)):
        result[args.vararg.arg] = type_ref
    if args.kwarg and (type_ref := type_ref_of(args.kwarg.annotation)):
        result[args.kwarg.arg] = type_ref
    return result


def parameter_names(args: ast.arguments) -> set[str]:
    names = {arg.arg for arg in args.posonlyargs + args.args + args.kwonlyargs}
    if args.vararg:
        names.add(args.vararg.arg)
    if args.kwarg:
        names.add(args.kwarg.arg)
    return names


def infer_value_type(value: ast.expr, known: dict[str, str]) -> str | None:
    if isinstance(value, ast.Name):
        return known.get(value.id)
    if isinstance(value, ast.Call):
        return expression_name(value.func)
    if isinstance(value, ast.BoolOp):
        inferred = [infer_value_type(item, known) for item in value.values]
        return single_type(inferred) if all(ref is not None for ref in inferred) else None
    if isinstance(value, ast.IfExp):
        return single_type([infer_value_type(value.body, known), infer_value_type(value.orelse, known)])
    return None


def type_ref_of(annotation: ast.expr | None) -> str | None:
    if annotation is None or is_none_type(annotation):
        return None
    if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
        return parse_forward_reference(annotation.value)
    if isinstance(annotation, (ast.Name, ast.Attribute)):
        return expression_name(annotation)
    if isinstance(annotation, ast.BinOp) and isinstance(annotation.op, ast.BitOr):
        return single_type([type_ref_of(annotation.left), type_ref_of(annotation.right)])
    if isinstance(annotation, ast.Subscript):
        wrapper = expression_name(annotation.value)
        if wrapper and wrapper.split(".")[-1] in OPTIONAL_WRAPPERS:
            elements = annotation.slice.elts if isinstance(annotation.slice, ast.Tuple) else [annotation.slice]
            if wrapper.split(".")[-1] == "Union":
                return single_type([type_ref_of(element) for element in elements])
            return type_ref_of(elements[0])
        return wrapper
    return None


def type_refs_of(annotation: ast.expr | None) -> list[str]:
    """Return the named types present in an annotation, preserving source order."""
    if annotation is None:
        return []
    if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
        try:
            parsed = ast.parse(annotation.value, mode="eval")
        except SyntaxError:
            return [annotation.value]
        return type_refs_of(parsed.body)  # type: ignore[attr-defined]
    if isinstance(annotation, (ast.Name, ast.Attribute)):
        ref = expression_name(annotation)
        return [ref] if ref and ref != "None" else []
    if isinstance(annotation, ast.BinOp) and isinstance(annotation.op, ast.BitOr):
        return unique_refs([*type_refs_of(annotation.left), *type_refs_of(annotation.right)])
    if isinstance(annotation, ast.Subscript):
        wrapper = expression_name(annotation.value)
        elements = annotation.slice.elts if isinstance(annotation.slice, ast.Tuple) else [annotation.slice]
        # Literal values are metadata, not forward type references. Annotated's metadata is the
        # same; only its first argument is a type position.
        wrapper_name = wrapper.split(".")[-1] if wrapper else ""
        if wrapper_name == "Literal":
            nested: list[str] = []
        elif wrapper_name == "Annotated":
            nested = type_refs_of(elements[0]) if elements else []
        else:
            nested = [ref for element in elements for ref in type_refs_of(element)]
        return unique_refs(([wrapper] if wrapper else []) + nested)
    if isinstance(annotation, (ast.Tuple, ast.List)):
        return unique_refs([ref for element in annotation.elts for ref in type_refs_of(element)])
    return []


def parse_forward_reference(value: str) -> str:
    try:
        parsed = ast.parse(value, mode="eval")
    except SyntaxError:
        return value
    return type_ref_of(parsed.body) or value  # type: ignore[attr-defined]


def expression_name(expression: ast.expr) -> str | None:
    if isinstance(expression, ast.Name):
        return expression.id
    if isinstance(expression, ast.Attribute):
        prefix = expression_name(expression.value)
        return f"{prefix}.{expression.attr}" if prefix else None
    return None


def single_type(candidates: list[str | None]) -> str | None:
    concrete = {candidate for candidate in candidates if candidate is not None}
    return next(iter(concrete)) if len(concrete) == 1 else None


def unique_refs(refs: list[str]) -> list[str]:
    return list(dict.fromkeys(refs))


def is_none_type(node: ast.expr) -> bool:
    return (isinstance(node, ast.Constant) and node.value is None) or (
        isinstance(node, ast.Name) and node.id == "None"
    )
