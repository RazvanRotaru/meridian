"""Structural node extraction for Python definitions at every lexical depth."""

from __future__ import annotations

import ast
import re


FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)


def collect_nodes(
    tree: ast.Module,
    interface_occurrences: set[tuple[str, int]] | None = None,
) -> list[dict]:
    nodes: list[dict] = []
    collect_body(
        tree.body,
        nodes,
        parent=None,
        direct_class=None,
        interface_occurrences=interface_occurrences or set(),
    )
    return nodes


def collect_body(
    body: list[ast.stmt],
    nodes: list[dict],
    parent: str | None,
    direct_class: str | None,
    interface_occurrences: set[tuple[str, int]],
) -> None:
    for statement in body:
        if isinstance(statement, FUNCTIONS):
            qualname = qualify(parent, statement.name)
            nodes.append(callable_node(statement, qualname, parent, direct_class is not None))
            collect_body(
                statement.body,
                nodes,
                parent=qualname,
                direct_class=None,
                interface_occurrences=interface_occurrences,
            )
        elif isinstance(statement, ast.ClassDef):
            qualname = qualify(parent, statement.name)
            is_interface = (qualname, statement.lineno) in interface_occurrences
            nodes.append(class_node(statement, qualname, parent, is_interface))
            collect_body(
                statement.body,
                nodes,
                parent=qualname,
                direct_class=qualname,
                interface_occurrences=interface_occurrences,
            )
        else:
            collect_nested(statement, nodes, parent, direct_class, interface_occurrences)


def collect_nested(
    node: ast.AST,
    nodes: list[dict],
    parent: str | None,
    direct_class: str | None,
    interface_occurrences: set[tuple[str, int]],
) -> None:
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.stmt,)):
            collect_body([child], nodes, parent, direct_class, interface_occurrences)
        else:
            collect_nested(child, nodes, parent, direct_class, interface_occurrences)


def class_node(
    classdef: ast.ClassDef,
    qualname: str,
    parent: str | None,
    is_interface: bool,
) -> dict:
    tags: list[str] = []
    if "dataclass" in decorator_names(classdef):
        tags.append("dataclass")
    if classdef.name.startswith("_"):
        tags.append("private")
    return base_node(
        classdef,
        "interface" if is_interface else "class",
        qualname,
        classdef.name,
        parent,
        tags,
        None,
    )


def callable_node(
    func: ast.FunctionDef | ast.AsyncFunctionDef,
    qualname: str,
    parent: str | None,
    is_method: bool,
) -> dict:
    return base_node(
        func,
        "method" if is_method else "function",
        qualname,
        func.name,
        parent,
        callable_tags(func),
        signature_of(func),
    )


def base_node(
    node: ast.AST,
    kind: str,
    qualname: str,
    name: str,
    parent: str | None,
    tags: list[str],
    signature: str | None,
) -> dict:
    return {
        "kind": kind,
        "qualname": qualname,
        "name": name,
        "parentQualname": parent,
        "startLine": node.lineno,  # type: ignore[attr-defined]
        "endLine": end_line(node),
        "startCol": node.col_offset + 1,  # type: ignore[attr-defined]
        "summary": docstring_summary(node),
        "signature": signature,
        "tags": tags,
    }


def callable_tags(func: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    tags: list[str] = []
    if isinstance(func, ast.AsyncFunctionDef):
        tags.append("async")
    decorators = decorator_names(func)
    tags.extend(name for name in ("staticmethod", "classmethod", "property") if name in decorators)
    if func.name.startswith("_"):
        tags.append("private")
    return tags


def decorator_names(node: ast.AST) -> list[str]:
    names: list[str] = []
    for decorator in node.decorator_list:  # type: ignore[attr-defined]
        target = decorator.func if isinstance(decorator, ast.Call) else decorator
        if isinstance(target, ast.Name):
            names.append(target.id)
        elif isinstance(target, ast.Attribute):
            names.append(target.attr)
    return names


def signature_of(func: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    suffix = f" -> {ast.unparse(func.returns)}" if func.returns else ""
    return f"{func.name}({ast.unparse(func.args)}){suffix}"


def docstring_summary(node: ast.AST) -> str | None:
    doc = ast.get_docstring(node)
    if not doc:
        return None
    match = re.match(r"^.*?[.!?](\s|$)", doc.strip(), re.DOTALL)
    return (match.group(0) if match else doc.strip()).strip()


def qualify(parent: str | None, name: str) -> str:
    return f"{parent}.{name}" if parent else name


def end_line(node: ast.AST) -> int:
    return getattr(node, "end_lineno", None) or node.lineno  # type: ignore[attr-defined]
