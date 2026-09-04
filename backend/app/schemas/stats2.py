"""Pydantic schemas for Stats 2 config + capacity endpoints."""

from __future__ import annotations

from datetime import date
from typing import Any

from pydantic import BaseModel, Field


class ScheduleShift(BaseModel):
    id: int | None = None
    day_of_week: int = Field(ge=0, le=6)
    start_time: str
    end_time: str
    operator_count: int = Field(default=1, ge=1)
    timezone: str = "UTC"
    enabled: bool = True


class ScheduleGlobals(BaseModel):
    expected_plate_clear_minutes: int = Field(ge=0)
    production_line_start_time: str
    pre_line_buffer_minutes: int = Field(ge=0)
    timezone: str = "UTC"
    # None on PUT = leave unchanged; GET always returns the resolved map.
    ready_buffer_targets: dict[str, int] | None = None


class ScheduleResponse(BaseModel):
    shifts: list[ScheduleShift]
    globals: ScheduleGlobals


class SchedulePutRequest(BaseModel):
    shifts: list[ScheduleShift]
    globals: ScheduleGlobals | None = None


class EffectiveScheduleResponse(BaseModel):
    date: date | str
    timezone: str
    shifts: list[ScheduleShift]
    line_start_time: str
    pre_line_buffer_minutes: int
    ready_deadline_time: str
    expected_plate_clear_minutes: int
    is_staffed: bool
    day_of_week: int | None = None
    windows: list[dict] = Field(default_factory=list)
    peak_operator_count: int = 0
    total_staffed_minutes: int = 0
    staffed_now: bool | None = None
    using_default_stub: bool = False


class DiscoveredSlotOut(BaseModel):
    slot_id: int
    printer_model: str
    quantity: int
    print_time_seconds: int | None = None
    filename: str | None = None
    version: str
    recommended: bool = False


class DeviceRecipeLineOut(BaseModel):
    id: int
    part_id: int
    part_code: str
    part_name: str
    qty_per_device: int
    preferred_slot_id: int | None = None
    recommended_slot_id: int | None = None
    recommended_filename: str | None = None
    discovered_slots: list[DiscoveredSlotOut] = Field(default_factory=list)


class DeviceRecipeOut(BaseModel):
    id: int
    name: str
    lines: list[DeviceRecipeLineOut]


class DeviceRecipeLineIn(BaseModel):
    part_code: str
    qty_per_device: int = Field(ge=1)
    preferred_slot_id: int | None = None


class DeviceRecipePutRequest(BaseModel):
    lines: list[DeviceRecipeLineIn]


# ── Phase 3a capacity / readiness / schedule ──────────────────────────────


class ComponentCapacityOut(BaseModel):
    part_code: str
    part_name: str
    qty_per_device: int
    slot_id: int | None = None
    filename: str | None = None
    printer_model: str | None = None
    quantity_per_plate: int = 0
    print_time_seconds: int = 0
    cycle_seconds: int = 0
    active_printers: int = 0
    plates_per_printer_per_day_theo: float = 0.0
    plates_per_printer_per_day: float = 0.0
    effective_parts_per_plate: float = 0.0
    parts_per_day: float = 0.0
    devices_from_component: float = 0.0
    devices_theoretical: float = 0.0
    print_job_success: float = 1.0
    harvest_yield: float = 1.0
    qc_yield: float = 1.0
    incomplete: bool = False
    warning: str | None = None
    using_defaults: bool = False
    print_time_assumed: bool = False
    model_breakdown: list[dict[str, Any]] = Field(default_factory=list)


class YieldDragStageOut(BaseModel):
    stage: str
    label: str
    devices_lost: int = 0
    devices_after: int = 0
    binding_part: str | None = None


class YieldDragPartOut(BaseModel):
    part_code: str
    qty_per_device: int = 1
    print_job_success: float = 1.0
    harvest_yield: float = 1.0
    qc_yield: float = 1.0
    devices_theoretical: float = 0.0
    devices_expected: float = 0.0
    is_binding: bool = False


class YieldDragOut(BaseModel):
    """Whole-device yield losses: lost_print + lost_harvest + lost_qc == theo − expected."""

    devices_lost_total: int = 0
    devices_theoretical_whole: int = 0
    devices_expected_whole: int = 0
    devices_after_print: int = 0
    devices_after_harvest: int = 0
    devices_after_qc: int = 0
    lost_print: int = 0
    lost_harvest: int = 0
    lost_qc: int = 0
    binding_part: str | None = None
    stages: list[YieldDragStageOut] = Field(default_factory=list)
    parts: list[YieldDragPartOut] = Field(default_factory=list)


class CapacityResponse(BaseModel):
    as_of: str
    staffed_minutes: float
    staffed_seconds: float
    expected_plate_clear_minutes: int
    using_default_schedule_stub: bool = False
    devices_per_day_theoretical: float
    devices_per_day_realistic: float
    devices_per_day_theoretical_unconstrained: float = 0.0
    devices_per_day_realistic_unconstrained: float = 0.0
    binding_part: str | None = None
    fleet_by_model: dict[str, int] = Field(default_factory=dict)
    components: list[ComponentCapacityOut] = Field(default_factory=list)
    yield_drag: YieldDragOut | None = None


class ReadinessPartOut(BaseModel):
    part_code: str
    part_name: str
    qty_per_device: int
    in_wip: int = 0
    staged_for_prod: int = 0
    initial_qc_finished: int = 0
    rework_sanding: int = 0
    linked: int = 0
    ready_now: int = 0
    upstream: int = 0
    devices_covered: float = 0.0
    is_binding: bool = False


class ReadinessResponse(BaseModel):
    as_of: str
    line_start_at: str
    ready_deadline_at: str
    devices_buildable_now: float
    binding_part: str | None = None
    parts: list[ReadinessPartOut] = Field(default_factory=list)


class BuildPlanRowOut(BaseModel):
    part_code: str
    part_name: str
    qty_per_device: int
    recommended_slot_id: int | None = None
    recommended_filename: str | None = None
    quantity_per_plate: int = 0
    printer_model: str | None = None
    active_printers: int = 0
    plates_per_day: float = 0.0
    parts_per_day: float = 0.0
    devices_per_day: float = 0.0
    is_binding: bool = False
    incomplete: bool = False
    warning: str | None = None
    model_breakdown: list[dict[str, Any]] = Field(default_factory=list)


class BuildPlanResponse(BaseModel):
    devices_per_day_realistic: float
    devices_per_day_theoretical: float
    binding_part: str | None = None
    rows: list[BuildPlanRowOut] = Field(default_factory=list)


class VariantCompareResponse(BaseModel):
    part_code: str
    qty_per_device: int | None = None
    recommended_slot_id: int | None = None
    variants: list[dict[str, Any]] = Field(default_factory=list)
    warning: str | None = None


class OverviewResponse(BaseModel):
    capacity: dict[str, Any]
    readiness: dict[str, Any]
    components: list[ComponentCapacityOut] = Field(default_factory=list)


class CapacityHistoryPoint(BaseModel):
    date: str
    staffed_minutes: float
    devices_per_day_theoretical: float
    devices_per_day_realistic: float
    devices_shipped: int = 0
    binding_part: str | None = None


class CapacityHistoryResponse(BaseModel):
    days: int
    points: list[CapacityHistoryPoint] = Field(default_factory=list)


class PrintPlanScenarioRow(BaseModel):
    part_code: str
    qty_per_device: int
    quantity_per_plate: int
    plates_needed: int
    parts_needed: int


class PrintPlanShortPart(BaseModel):
    """Recipe part that missed the what-if ask on the packed schedule."""

    part_code: str
    parts_needed: int
    parts_packed: int
    devices_needed: float = 0.0
    devices_packed: float = 0.0
    eligible_models: list[str] = Field(default_factory=list)
    eligible_printers: int = 0
    min_extra_printers: int = 0


class PrintPlanResponse(BaseModel):
    week_start: str
    timeline_mode: str = "capacity"
    target_devices: float
    capacity_devices_realistic: float = 0.0
    capacity_devices_theoretical: float = 0.0
    devices_achievable: float = 0.0
    feasible: bool = True
    plates_needed: dict[str, int] = Field(default_factory=dict)
    plates_packed: dict[str, int] = Field(default_factory=dict)
    parts_needed: dict[str, float] = Field(default_factory=dict)
    parts_packed: dict[str, float] = Field(default_factory=dict)
    scenario_rows: list[PrintPlanScenarioRow] = Field(default_factory=list)
    short_parts: list[PrintPlanShortPart] = Field(default_factory=list)
    binding_readiness_part: str | None = None
    binding_print_part: str | None = None
    buffer_targets: dict[str, int] = Field(default_factory=dict)
    buffer_ready: dict[str, int] = Field(default_factory=dict)
    buffer_debt: dict[str, float] = Field(default_factory=dict)
    buffer_debt_remaining: dict[str, float] = Field(default_factory=dict)
    hypothetical_fleet: bool = False
    hypothetical_added: dict[str, int] = Field(default_factory=dict)
    as_of: str
    days: list[dict[str, Any]] = Field(default_factory=list)


class PrinterTimeBlockOut(BaseModel):
    id: int | None = None
    printer_id: int
    printer_name: str | None = None
    printer_model: str | None = None
    day_of_week: int
    start_time: str
    end_time: str
    label: str | None = None
    enabled: bool = True


class PrinterTimeBlocksResponse(BaseModel):
    blocks: list[PrinterTimeBlockOut] = Field(default_factory=list)


class PrinterTimeBlockItemIn(BaseModel):
    day_of_week: int
    start_time: str
    end_time: str
    label: str | None = None
    enabled: bool = True


class PrinterTimeBlockPutRequest(BaseModel):
    blocks: list[PrinterTimeBlockItemIn] = Field(default_factory=list)
