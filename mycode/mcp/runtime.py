"""Process-wide MCP manager handle.

The server creates one :class:`~mycode.mcp.mcp.McpManager` at startup and
publishes it here so other subsystems (tool registry, prompt builder) can
reach the connected servers without importing the FastAPI app.
"""

from __future__ import annotations

from typing import Any

_manager: Any = None


def set_manager(manager: Any) -> None:
    """Publish the active MCP manager (or ``None`` to clear it)."""
    global _manager
    _manager = manager


def get_manager() -> Any:
    """Return the active MCP manager, or ``None`` when MCP is not running."""
    return _manager
