"""Conservative C3 linearization for internal Python classes."""

from __future__ import annotations


ClassKey = tuple[str, str]


def c3_mro(
    root: ClassKey,
    bases: dict[ClassKey, list[ClassKey]],
    complete: set[ClassKey],
) -> list[ClassKey] | None:
    return linearize(root, bases, complete, frozenset())


def linearize(
    key: ClassKey,
    bases: dict[ClassKey, list[ClassKey]],
    complete: set[ClassKey],
    seen: frozenset[ClassKey],
) -> list[ClassKey] | None:
    if key in seen or key not in complete:
        return None
    direct = bases.get(key, [])
    sequences: list[list[ClassKey]] = []
    for base in direct:
        base_mro = linearize(base, bases, complete, seen | {key})
        if base_mro is None:
            return None
        sequences.append(list(base_mro))
    sequences.append(list(direct))
    merged = merge_c3(sequences)
    return [key, *merged] if merged is not None else None


def merge_c3(sequences: list[list[ClassKey]]) -> list[ClassKey] | None:
    result: list[ClassKey] = []
    pending = [sequence for sequence in sequences if sequence]
    while pending:
        candidate = next(
            (
                sequence[0]
                for sequence in pending
                if all(sequence[0] not in other[1:] for other in pending)
            ),
            None,
        )
        if candidate is None:
            return None
        result.append(candidate)
        pending = [
            sequence[1:] if sequence and sequence[0] == candidate else sequence
            for sequence in pending
        ]
        pending = [sequence for sequence in pending if sequence]
    return result
