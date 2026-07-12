"""Source-ordered module export bindings used by the project index."""

from __future__ import annotations


class ExportBindings:
    def __init__(self) -> None:
        self.top_names: dict[str, str] = {}
        self.local_origins: dict[str, int | str] = {}
        self.reexports: dict[str, tuple[str, str]] = {}
        self.from_imports: dict[str, tuple[str, str]] = {}
        self.module_imports: dict[str, str] = {}

    def bind_local(self, name: str, qualname: str, origin: int | str | None = None) -> None:
        self.top_names[name] = qualname
        self.local_origins[name] = origin if origin is not None else qualname
        self.reexports.pop(name, None)
        self.from_imports.pop(name, None)
        self.module_imports.pop(name, None)

    def bind_reexport(self, name: str, target: tuple[str, str]) -> None:
        self.top_names.pop(name, None)
        self.local_origins.pop(name, None)
        self.reexports[name] = target
        self.from_imports[name] = target
        self.module_imports.pop(name, None)

    def bind_module(self, name: str, target: str) -> None:
        self.top_names.pop(name, None)
        self.local_origins.pop(name, None)
        self.reexports.pop(name, None)
        self.from_imports.pop(name, None)
        self.module_imports[name] = target

    def shadow(self, name: str) -> None:
        self.top_names.pop(name, None)
        self.local_origins.pop(name, None)
        self.reexports.pop(name, None)
        self.from_imports.pop(name, None)
        self.module_imports.pop(name, None)

    def clone(self) -> "ExportBindings":
        cloned = ExportBindings()
        for field in ("top_names", "local_origins", "reexports", "from_imports", "module_imports"):
            setattr(cloned, field, dict(getattr(self, field)))
        return cloned

    def replace_with(self, other: "ExportBindings") -> None:
        for field in ("top_names", "local_origins", "reexports", "from_imports", "module_imports"):
            setattr(self, field, dict(getattr(other, field)))

    def names(self) -> set[str]:
        return set().union(self.top_names, self.reexports, self.from_imports, self.module_imports)

    def fact(self, name: str):
        if name in self.top_names:
            return "local", self.top_names[name], self.local_origins.get(name)
        if name in self.reexports:
            return "reexport", self.reexports[name]
        if name in self.module_imports:
            return "module", self.module_imports[name]
        return ("missing",)


def merge_exports(target: ExportBindings, outcomes: list[ExportBindings]) -> None:
    names = set().union(*(outcome.names() for outcome in outcomes))
    merged = outcomes[0].clone()
    for name in names:
        facts = [outcome.fact(name) for outcome in outcomes]
        if any(fact != facts[0] for fact in facts[1:]):
            merged.shadow(name)
    target.replace_with(merged)
