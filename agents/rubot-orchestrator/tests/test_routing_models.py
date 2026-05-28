import pytest

from app.routing_models import RoutingPlan, assert_plan_sources_known


def test_plan_rejects_unknown_source():
    plan = RoutingPlan(
        strategy="single",
        selected_sources=["unknown"],
        slices=[{"id": "s1", "source_id": "unknown", "instructions": "hi"}],
    )
    with pytest.raises(ValueError):
        assert_plan_sources_known(plan, {"example-provider": "http://x"})


def test_plan_caps_slice_count():
    with pytest.raises(ValueError):
        RoutingPlan(
            strategy="multi",
            selected_sources=["a", "b", "c", "d"],
            slices=[
                {"id": "s1", "source_id": "a", "instructions": "1"},
                {"id": "s2", "source_id": "b", "instructions": "2"},
                {"id": "s3", "source_id": "c", "instructions": "3"},
                {"id": "s4", "source_id": "d", "instructions": "4"},
            ],
        )
