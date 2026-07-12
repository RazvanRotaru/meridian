"""Names bound by Python assignment-like syntax without executing the code."""

from __future__ import annotations

import ast


MATCH_AS = getattr(ast, "MatchAs", None)
MATCH_STAR = getattr(ast, "MatchStar", None)
MATCH_MAPPING = getattr(ast, "MatchMapping", None)
MATCH_SEQUENCE = getattr(ast, "MatchSequence", None)
MATCH_OR = getattr(ast, "MatchOr", None)
MATCH_CLASS = getattr(ast, "MatchClass", None)
MATCH_BINDINGS = tuple(
    node for node in (MATCH_AS, MATCH_STAR, MATCH_MAPPING, MATCH_SEQUENCE, MATCH_OR, MATCH_CLASS) if node
)


def statement_bound_names(node: ast.AST) -> set[str]:
    if isinstance(node, ast.Assign):
        return union_names(node.targets)
    if isinstance(node, (ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
        return bound_names(node.target)
    if isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
        return bound_names(node.target)
    if isinstance(node, (ast.With, ast.AsyncWith)):
        return union_names(item.optional_vars for item in node.items if item.optional_vars)
    if isinstance(node, ast.ExceptHandler):
        return {node.name} if node.name else set()
    if isinstance(node, ast.Delete):
        return union_names(node.targets)
    if MATCH_AS and isinstance(node, MATCH_AS):
        return ({node.name} if node.name else set()) | bound_names(node.pattern)
    if MATCH_STAR and isinstance(node, MATCH_STAR):
        return {node.name} if node.name else set()
    if MATCH_MAPPING and isinstance(node, MATCH_MAPPING):
        return ({node.rest} if node.rest else set()) | union_names(node.patterns)
    if (MATCH_SEQUENCE and isinstance(node, MATCH_SEQUENCE)) or (MATCH_OR and isinstance(node, MATCH_OR)):
        return union_names(node.patterns)
    if MATCH_CLASS and isinstance(node, MATCH_CLASS):
        return union_names([*node.patterns, *node.kwd_patterns])
    return set()


def bound_names(target: ast.AST | None) -> set[str]:
    if isinstance(target, ast.Name):
        return {target.id}
    if isinstance(target, ast.Starred):
        return bound_names(target.value)
    if isinstance(target, (ast.Tuple, ast.List)):
        return union_names(target.elts)
    if isinstance(target, MATCH_BINDINGS):
        return statement_bound_names(target)
    return set()


def union_names(nodes) -> set[str]:
    names: set[str] = set()
    for node in nodes:
        names.update(bound_names(node))
    return names
