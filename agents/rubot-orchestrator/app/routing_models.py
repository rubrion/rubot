from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


class RoutingSlice(BaseModel):
    id: str = Field(min_length=1)
    source_id: str = Field(min_length=1)
    instructions: str = Field(min_length=1)
    carry_over_context: dict[str, str] = Field(default_factory=dict)
    depends_on: list[str] = Field(default_factory=list)


class RoutingPlan(BaseModel):
    schema_version: Literal["1"] = "1"
    strategy: Literal["single", "multi"]
    selected_sources: list[str]
    slices: list[RoutingSlice]

    @model_validator(mode="after")
    def _validate_routing_plan(self) -> "RoutingPlan":
        if not self.slices:
            raise ValueError("plan.slices must not be empty")

        if len(self.slices) > 3:
            raise ValueError("plan.slices exceeds max of 3")

        unique_sources = sorted({s.source_id for s in self.slices})
        if sorted({s.strip().lower() for s in self.selected_sources}) != unique_sources:
            raise ValueError("plan.selected_sources must equal unique slice.source_id values")

        if self.strategy == "single" and len(unique_sources) != 1:
            raise ValueError("single strategy requires exactly 1 selected source")
        if self.strategy == "multi" and len(unique_sources) < 2:
            raise ValueError("multi strategy requires at least 2 selected sources")

        ids = [s.id for s in self.slices]
        if len(set(ids)) != len(ids):
            raise ValueError("slice ids must be unique")

        valid_ids = set(ids)
        for s in self.slices:
            for dep in s.depends_on:
                if dep not in valid_ids:
                    raise ValueError(f"slice depends_on references unknown id: {dep}")

        return self


def assert_plan_sources_known(plan: RoutingPlan, registry: dict[str, str]) -> None:
    unknown = [s for s in plan.selected_sources if s not in registry]
    if unknown:
        raise ValueError(f"plan references unknown sources: {unknown}")
