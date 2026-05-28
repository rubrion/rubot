"""OpenAI-compatible request/response models + AgentCapabilities.

These are the wire contract with the rubot orchestrator. Keep them
as-is — only edit the prompt, deps, tools, and the _CAPABILITIES
constant in main.py.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: str
    content: Optional[Any] = None
    name: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None
    tool_call_id: Optional[str] = None


class ChatCompletionRequest(BaseModel):
    model: Optional[str] = None
    messages: List[ChatMessage]
    stream: Optional[bool] = False
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None


class ChatChoice(BaseModel):
    index: int
    message: ChatMessage
    finish_reason: str


class TokenUsage(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class ChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: List[ChatChoice]
    usage: TokenUsage


class AgentCapabilities(BaseModel):
    """Document returned by /v1/capabilities. The orchestrator reads it
    to decide whether to route to this agent. Keep schema_version="1".
    """

    schema_version: str = Field(default="1")
    source_id: str = Field(..., description="Stable id matching the router registry.")
    name: str = Field(..., description="Short human-readable service name.")
    summary: str = Field(
        ...,
        description="Natural-language routing hints: what questions this agent answers.",
    )
