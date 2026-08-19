from datetime import datetime

from pydantic import BaseModel, Field


class BucketCreate(BaseModel):
    color_name: str = Field(min_length=1, max_length=100)
    material: str = Field(min_length=1, max_length=50)
    brand: str | None = Field(default=None, max_length=100)
    subtype: str | None = Field(default=None, max_length=50)
    extra_colors: str | None = Field(default=None, max_length=255)
    effect_type: str | None = Field(default=None, max_length=20)
    color_hex: str | None = Field(default=None, max_length=9)
    on_hand_grams: float = Field(default=0, ge=0)
    spool_weight_grams: float = Field(default=1000, gt=0)
    cost_per_kg: float | None = Field(default=None, ge=0)
    lead_time_days: int = Field(default=7, ge=1, le=365)


class BucketStockUpdate(BaseModel):
    color_name: str | None = Field(default=None, min_length=1, max_length=100)
    material: str | None = Field(default=None, min_length=1, max_length=50)
    brand: str | None = Field(default=None, max_length=100)
    subtype: str | None = Field(default=None, max_length=50)
    extra_colors: str | None = Field(default=None, max_length=255)
    effect_type: str | None = Field(default=None, max_length=20)
    on_hand_grams: float | None = Field(default=None, ge=0)
    add_grams: float | None = None
    spool_weight_grams: float | None = Field(default=None, gt=0)
    color_hex: str | None = Field(default=None, max_length=9)
    cost_per_kg: float | None = Field(default=None, ge=0)
    lead_time_days: int | None = Field(default=None, ge=1, le=365)


class SlotAssignmentCreate(BaseModel):
    printer_id: int
    ams_id: int
    tray_id: int
    bucket_id: int


class SlotAssignmentResponse(BaseModel):
    id: int
    printer_id: int
    ams_id: int
    tray_id: int
    bucket_id: int
    color_name: str
    material: str
    brand: str | None = None
    subtype: str | None = None
    extra_colors: str | None = None
    effect_type: str | None = None
    color_hex: str | None

    class Config:
        from_attributes = True


class BucketResponse(BaseModel):
    id: int
    color_name: str
    material: str
    brand: str | None = None
    subtype: str | None = None
    extra_colors: str | None = None
    effect_type: str | None = None
    color_hex: str | None
    on_hand_grams: float
    spool_weight_grams: float
    cost_per_kg: float | None = None
    lead_time_days: int = 7
    stock_initialized: bool
    tracking_started_at: datetime | None
    created_at: datetime | None

    class Config:
        from_attributes = True


class UsageEventResponse(BaseModel):
    id: int
    bucket_id: int
    color_name: str
    material: str
    brand: str | None = None
    subtype: str | None = None
    extra_colors: str | None = None
    effect_type: str | None = None
    color_hex: str | None
    grams: float
    occurred_at: datetime
    kind: str
    progress: float | None
    archive_id: int | None
    printer_id: int | None
    print_name: str | None

    class Config:
        from_attributes = True


class MaterialPlanResponse(BaseModel):
    bucket_id: int
    color_name: str
    material: str
    brand: str | None = None
    subtype: str | None = None
    extra_colors: str | None = None
    effect_type: str | None = None
    color_hex: str | None
    on_hand_grams: float
    stock_initialized: bool
    spool_weight_grams: float
    cost_per_kg: float | None = None
    on_hand_value: float | None = None
    monthly_cost_estimate: float | None = None
    spool_equivalent: float
    observed_usage_grams: float
    daily_rate_grams: float
    monthly_estimate_grams: float
    projected_remaining_grams: float
    recommended_spools: int
    days_of_cover: float | None
    days_until_order: int | None = None
    lead_time_days: int = 7
    reorder_grams: float | None = None
    stage: str


class FilamentPlanResponse(BaseModel):
    stage: str
    days_observed: int
    window_label: str
    materials: list[MaterialPlanResponse]
    total_on_hand_grams: float
    total_observed_usage_grams: float
    total_monthly_estimate_grams: float
    total_on_hand_value: float | None = None
    total_monthly_cost_estimate: float | None = None
    total_recommended_spools: int
    soonest_days_until_order: int | None = None
    tracking_started_at: datetime | None
