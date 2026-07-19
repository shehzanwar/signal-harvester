from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class Source(Protocol):
    def fetch(self) -> list[dict[str, Any]]:
        """Return a list of raw article dicts from this source."""
        ...
