"""Structured intra-procedural logic flows derived from Python's stdlib AST.

Call resolution is deliberately reused from ``edge_collector``: each call site joins to the
already-resolved call edge by owner and source range.  That keeps the dependency graph and the
logic-flow side channel from developing two subtly different Python name resolvers.
"""

from __future__ import annotations

import ast

from definitions import FUNCTIONS, qualify


MATCH = getattr(ast, "Match", None)
TRY_NODES = (ast.Try, getattr(ast, "TryStar", ast.Try))
MAX_LABEL = 120


def collect_flows(tree: ast.Module, edges: list[dict]) -> list[dict]:
    calls = {
        call_key(edge["sourceQualname"], edge): edge["target"]
        for edge in edges
        if edge["kind"] == "call"
    }
    collector = FlowCollector(calls)
    flows: list[dict] = []
    module_steps = collector.body(tree.body, None)
    if meaningful(module_steps):
        flows.append({"sourceQualname": None, "sourceLine": None, "steps": module_steps})
    collect_definition_flows(tree.body, None, collector, flows)
    return flows


def collect_definition_flows(
    body: list[ast.stmt],
    parent: str | None,
    collector: "FlowCollector",
    flows: list[dict],
) -> None:
    for statement in body:
        if isinstance(statement, FUNCTIONS):
            qualname = qualify(parent, statement.name)
            steps = collector.body(statement.body, qualname)
            if meaningful(steps):
                flows.append({
                    "sourceQualname": qualname,
                    "sourceLine": statement.lineno,
                    "steps": steps,
                })
            collect_definition_flows(statement.body, qualname, collector, flows)
        elif isinstance(statement, ast.ClassDef):
            qualname = qualify(parent, statement.name)
            collect_definition_flows(statement.body, qualname, collector, flows)
        else:
            collect_nested_definition_flows(statement, parent, collector, flows)


def collect_nested_definition_flows(
    node: ast.AST,
    parent: str | None,
    collector: "FlowCollector",
    flows: list[dict],
) -> None:
    for child in ast.iter_child_nodes(node):
        if isinstance(child, ast.stmt):
            collect_definition_flows([child], parent, collector, flows)
        else:
            collect_nested_definition_flows(child, parent, collector, flows)


def meaningful(steps: list[dict]) -> bool:
    return any(step["kind"] != "exit" for step in steps)


class FlowCollector:
    def __init__(self, calls: dict[tuple, dict]) -> None:
        self.calls = calls

    def body(self, body: list[ast.stmt], owner: str | None) -> list[dict]:
        return [step for statement in body for step in self.statement(statement, owner)]

    def statement(self, statement: ast.stmt, owner: str | None) -> list[dict]:
        if isinstance(statement, FUNCTIONS) or isinstance(statement, ast.ClassDef):
            return []
        if isinstance(statement, ast.If):
            before = self.expression(statement.test, owner)
            paths = [path("then", "then", self.body(statement.body, owner))]
            if statement.orelse:
                paths.append(path("else", "else", self.body(statement.orelse, owner)))
            return [*before, {
                "kind": "branch",
                "label": label("if", statement.test),
                "branchKind": "if",
                "paths": paths,
                **source_range(statement),
            }]
        if isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
            expression = statement.iter if isinstance(statement, (ast.For, ast.AsyncFor)) else statement.test
            before = self.expression(expression, owner)
            loop = {
                "kind": "loop",
                "label": loop_label(statement),
                "body": self.body(statement.body, owner),
                **source_range(statement),
            }
            return [*before, loop, *self.body(statement.orelse, owner)]
        if isinstance(statement, TRY_NODES):
            try_body = [*self.body(statement.body, owner), *self.body(statement.orelse, owner)]
            paths = [path("try", "try", try_body)]
            for index, handler in enumerate(statement.handlers):
                name = ast.unparse(handler.type) if handler.type else "exception"
                paths.append(path(
                    f"catch {name}",
                    "catch",
                    self.body(handler.body, owner),
                    f"catch-{index}",
                    handler,
                ))
            if statement.finalbody:
                paths.append(path("finally", "finally", self.body(statement.finalbody, owner)))
            return [{
                "kind": "branch",
                "label": "try/catch",
                "branchKind": "try",
                "paths": paths,
                **source_range(statement),
            }]
        if MATCH and isinstance(statement, MATCH):
            before = self.expression(statement.subject, owner)
            paths = []
            for index, case in enumerate(statement.cases):
                case_label = truncate(ast.unparse(case.pattern))
                role = "default" if is_default_case(case) else "case"
                body = [*(self.expression(case.guard, owner) if case.guard else []), *self.body(case.body, owner)]
                paths.append(path(case_label, role, body, f"case-{index}"))
            return [*before, {
                "kind": "branch",
                "label": label("match", statement.subject),
                "branchKind": "switch",
                "paths": paths,
                **source_range(statement),
            }]
        if isinstance(statement, (ast.With, ast.AsyncWith)):
            before = [
                step
                for item in statement.items
                for step in self.expression(item.context_expr, owner)
            ]
            return [*before, *self.body(statement.body, owner)]
        if isinstance(statement, ast.Return):
            before = self.expression(statement.value, owner) if statement.value else []
            return [*before, {
                "kind": "exit",
                "variant": "return",
                "label": truncate(ast.unparse(statement.value)) if statement.value else None,
                **source_range(statement),
            }]
        if isinstance(statement, ast.Raise):
            before = self.expression(statement.exc, owner) if statement.exc else []
            return [*before, {
                "kind": "exit",
                "variant": "throw",
                "label": truncate(ast.unparse(statement.exc)) if statement.exc else None,
                **source_range(statement),
            }]
        return self.generic(statement, owner)

    def generic(self, node: ast.AST, owner: str | None) -> list[dict]:
        steps: list[dict] = []
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.stmt, *FUNCTIONS, ast.ClassDef)):
                continue
            steps.extend(self.expression(child, owner))
        return steps

    def expression(self, expression: ast.AST | None, owner: str | None, awaited: bool = False) -> list[dict]:
        if expression is None or isinstance(expression, (*FUNCTIONS, ast.ClassDef, ast.Lambda)):
            return []
        if isinstance(expression, ast.Await):
            if isinstance(expression.value, ast.Call):
                return self.expression(expression.value, owner, awaited=True)
            nested = self.expression(expression.value, owner)
            return [*nested, {
                "kind": "await",
                "label": truncate(ast.unparse(expression.value)),
                "mode": "single",
                "inputs": [{"label": truncate(ast.unparse(expression.value))}],
                **source_range(expression),
            }]
        if isinstance(expression, ast.Call):
            before = self.expression(expression.func, owner)
            callbacks: list[dict] = []
            for argument in expression.args:
                if isinstance(argument, ast.Lambda):
                    callback = self.callback(argument, expression, owner)
                    if callback:
                        callbacks.append(callback)
                else:
                    before.extend(self.expression(argument, owner))
            for keyword in expression.keywords:
                if isinstance(keyword.value, ast.Lambda):
                    callback = self.callback(keyword.value, expression, owner)
                    if callback:
                        callbacks.append(callback)
                else:
                    before.extend(self.expression(keyword.value, owner))
            target = self.calls.get(call_key(owner, source_range(expression)))
            step = {
                "kind": "call",
                "label": truncate(ast.unparse(expression.func)),
                "target": target or {"resolution": "unresolved"},
                **source_range(expression),
            }
            if awaited:
                step["awaited"] = True
            return [*before, step, *callbacks]
        if isinstance(expression, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            return self.comprehension(expression, owner)
        return [
            step
            for child in ast.iter_child_nodes(expression)
            for step in self.expression(child, owner, awaited)
        ]

    def callback(self, callback: ast.Lambda, receiver: ast.Call, owner: str | None) -> dict | None:
        body = self.expression(callback.body, owner)
        if not body:
            return None
        return {
            "kind": "callback",
            "label": f"callback → {truncate(ast.unparse(receiver.func))}",
            "body": body,
            **source_range(callback),
        }

    def comprehension(self, expression, owner: str | None) -> list[dict]:
        steps: list[dict] = []
        for generator in expression.generators:
            steps.extend(self.expression(generator.iter, owner))
            for condition in generator.ifs:
                steps.extend(self.expression(condition, owner))
        values = [expression.key, expression.value] if isinstance(expression, ast.DictComp) else [expression.elt]
        for value in values:
            steps.extend(self.expression(value, owner))
        return steps


def path(
    label_value: str,
    role: str,
    body: list[dict],
    path_id: str | None = None,
    source: ast.AST | None = None,
) -> dict:
    result = {"label": label_value, "role": role, "body": body, "pathId": path_id or role}
    if source is not None:
        result["source"] = source_range(source)
    return result


def loop_label(node: ast.For | ast.AsyncFor | ast.While) -> str:
    if isinstance(node, (ast.For, ast.AsyncFor)):
        prefix = "async for" if isinstance(node, ast.AsyncFor) else "for"
        return truncate(f"{prefix} {ast.unparse(node.target)} in {ast.unparse(node.iter)}")
    return label("while", node.test)


def label(prefix: str, expression: ast.AST) -> str:
    return truncate(f"{prefix} {ast.unparse(expression)}")


def truncate(value: str) -> str:
    compact = " ".join(value.split())
    return compact if len(compact) <= MAX_LABEL else f"{compact[:MAX_LABEL - 1]}…"


def is_default_case(case) -> bool:
    pattern = case.pattern
    return isinstance(pattern, ast.MatchAs) and pattern.pattern is None and pattern.name is None


def call_key(owner: str | None, ranged: dict) -> tuple:
    return (
        owner,
        ranged["line"],
        ranged["col"],
        ranged["endLine"],
        ranged["endCol"],
    )


def source_range(node: ast.AST) -> dict:
    line = getattr(node, "lineno", 1)
    col = getattr(node, "col_offset", 0) + 1
    end_line = getattr(node, "end_lineno", line) or line
    end_col = getattr(node, "end_col_offset", col - 1) + 1
    return {"line": line, "col": col, "endLine": end_line, "endCol": end_col}
