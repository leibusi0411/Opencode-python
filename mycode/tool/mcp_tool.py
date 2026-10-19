"""Expose connected MCP server tools to the agent.

Each tool exposed by an MCP server is wrapped in a lightweight
:class:`ToolInfo` implementation and registered in the global tool registry
under ``<server>_<tool>`` (the same key the ``/mcp`` API reports). The
prompt builder calls :func:`sync_mcp_tools` before collecting tool
definitions, so the set stays in step with the live connections.
"""

from __future__ import annotations

from typing import Any

from mycode.mcp.runtime import get_manager
from mycode.tool.base import ToolContext, ToolError, ToolInfo, ToolOk, ToolResult
from mycode.util import log as logmod

logger = logmod.create(service="tool.mcp")

_registered: set[str] = set()


class McpTool(ToolInfo):
    """A tool backed by a connected MCP server."""

    def __init__(
        self,
        full_name: str,
        *,
        server: str,
        mcp_name: str,
        description: str,
        input_schema: dict[str, Any] | None,
    ) -> None:
        self.id = full_name
        self.description = description or f"MCP tool '{mcp_name}' from server '{server}'"
        self._server = server
        self._mcp_name = mcp_name
        self._schema = input_schema or {"type": "object", "properties": {}}

    def parameters_schema(self) -> dict[str, Any]:
        return self._schema

    def is_read_only(self, args: dict[str, Any] | None = None) -> bool:
        # MCP servers do not declare this; assume side effects so the
        # processor runs calls sequentially and permission rules still apply.
        return False

    def is_concurrency_safe(self, args: dict[str, Any] | None = None) -> bool:
        return False

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        manager = get_manager()
        if manager is None:
            return ToolError("MCP is not running in this process.", title=self.id)
        try:
            result = await manager.call_tool(self._server, self._mcp_name, args)
        except Exception as exc:  # noqa: BLE001 - surface any transport error to the model
            logger.warn("mcp tool failed", tool=self.id, error=str(exc))
            return ToolError(f"MCP tool '{self._mcp_name}' failed: {exc}", title=self.id)
        return ToolOk(_render_result(result), title=self.id)


def _render_result(result: Any) -> str:
    """Flatten an MCP CallToolResult into text for the model."""
    if result is None:
        return ""
    if isinstance(result, str):
        return result

    content = getattr(result, "content", None)
    if content is None and isinstance(result, dict):
        content = result.get("content")

    chunks: list[str] = []
    if isinstance(content, list):
        for item in content:
            text = getattr(item, "text", None)
            if text is None and isinstance(item, dict):
                text = item.get("text")
            if text:
                chunks.append(str(text))
            else:
                chunks.append(str(item))
    if chunks:
        return "\n".join(chunks)

    return str(result)


def sync_mcp_tools() -> None:
    """Register tools from connected MCP servers and drop stale ones."""
    from mycode.tool import registry

    manager = get_manager()
    current: set[str] = set()

    if manager is not None:
        for full_name, info in manager.tools().items():
            current.add(full_name)
            if registry.get(full_name) is None:
                registry.register(
                    McpTool(
                        full_name,
                        server=str(info.get("_server", "")),
                        mcp_name=str(info.get("name", "")),
                        description=str(info.get("description") or ""),
                        input_schema=info.get("inputSchema") or {},
                    )
                )

    for stale in _registered - current:
        registry.unregister(stale)

    _registered.clear()
    _registered.update(current)
