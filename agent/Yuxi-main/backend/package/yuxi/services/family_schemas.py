"""家庭档案 HTTP 输入与字段白名单。"""

import math
from datetime import date, datetime, timedelta, UTC
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


PROFILE_FIELDS = {
    "sex",
    "birth_date",
    "height_cm",
    "activity_level",
    "goal",
    "medical_history",
    "medications",
    "doctor_instructions",
    "allergens",
    "avoidances",
    "preferences",
}
REQUIRED_PROFILE_FIELDS = ("sex", "birth_date", "height_cm", "activity_level", "goal")
METRIC_FIELDS = {
    "weight": ("weight",),
    "blood_pressure": ("systolic", "diastolic"),
    "blood_glucose": ("glucose",),
    "blood_lipids": ("tc", "tg", "hdl", "ldl"),
}
METRIC_UNITS = {"weight": "kg", "blood_pressure": "mmHg", "blood_glucose": "mmol/L", "blood_lipids": "mmol/L"}


class FamilyInput(BaseModel):
    """家庭名称。"""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=80)


class MemberInput(FamilyInput):
    """仅创建成员关系，不创建其他人的健康信息。"""

    relationship: str = Field(min_length=1, max_length=30)


class ProfileInput(BaseModel):
    """可更正的档案字段；未提供与明确空值分别表达。"""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    sex: Literal["female", "male", "unspecified"] | None = None
    birth_date: date | None = None
    height_cm: float | None = Field(default=None, gt=0, le=300, allow_inf_nan=False)
    activity_level: Literal["sedentary", "light", "moderate", "high"] | None = None
    goal: str | None = Field(default=None, max_length=200)
    medical_history: str | None = Field(default=None, max_length=2000)
    medications: str | None = Field(default=None, max_length=2000)
    doctor_instructions: str | None = Field(default=None, max_length=2000)
    allergens: list[str] | None = Field(default=None, max_length=50)
    avoidances: list[str] | None = Field(default=None, max_length=50)
    preferences: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def check_birth_date(self):
        """不接受未来出生日期。"""
        if self.birth_date and self.birth_date > datetime.now(UTC).date():
            raise ValueError("出生日期不能在未来")
        for values in (self.allergens, self.avoidances):
            if values and any(not value.strip() or len(value) > 100 for value in values):
                raise ValueError("过敏原和忌口须为非空短文本")
        return self


class ProfileUpdate(BaseModel):
    """基于明确版本修改档案。"""

    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=1)
    profile: ProfileInput


class VersionInput(BaseModel):
    """确认当前版本。"""

    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=1)


class MemberUpdate(MemberInput):
    """维护成员关系元信息，不改变健康档案。"""

    expected_version: int = Field(ge=1)


class MemberStatusInput(BaseModel):
    """停用或恢复家庭关系。"""

    model_config = ConfigDict(extra="forbid")
    is_active: bool
    expected_version: int = Field(ge=1)


class AuthorizationInput(BaseModel):
    """由本人授权字段、用途和期限。"""

    model_config = ConfigDict(extra="forbid")
    fields: list[str] = Field(max_length=15)
    edit_fields: list[str] = Field(default_factory=list, max_length=15)
    purpose: Literal["family_nutrition"] = "family_nutrition"
    expires_at: datetime

    @model_validator(mode="after")
    def check_authorization(self):
        """授权字段与有效期只能使用支持的当前语义。"""
        if set(self.fields) - (PROFILE_FIELDS | METRIC_FIELDS.keys()):
            raise ValueError("授权字段不支持")
        if not set(self.edit_fields) <= set(self.fields):
            raise ValueError("代维护范围必须包含在查看范围内")
        if self.expires_at.tzinfo is None or self.expires_at <= datetime.now(UTC):
            raise ValueError("授权有效期必须为带时区的未来时间")
        if self.expires_at > datetime.now(UTC) + timedelta(days=366):
            raise ValueError("授权有效期最长一年")
        return self


class JoinInput(BaseModel):
    """认领一次性邀请。"""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    code: str = Field(min_length=20, max_length=100)


class MeasurementInput(BaseModel):
    """独立且可幂等保存的实测记录。"""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: UUID
    kind: Literal["weight", "blood_pressure", "blood_glucose", "blood_lipids"]
    values: dict[str, float]
    measured_at: datetime
    source: str = Field(default="manual", min_length=1, max_length=100)
    condition: str = Field(default="", max_length=100)
    note: str = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def check_measurement(self):
        """只保存完整、有限且带明确测量时间的指标。"""
        validate_metric_values(self.kind, self.values)
        if self.measured_at.tzinfo is None or self.measured_at > datetime.now(UTC):
            raise ValueError("测量时间必须带时区且不能在未来")
        if self.kind == "blood_glucose" and self.condition not in {"fasting", "after_meal_2h", "random"}:
            raise ValueError("血糖必须注明测量条件")
        return self


class MeasurementUpdate(VersionInput):
    """更正数值或测量信息，指标类型和成员归属保持稳定。"""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    values: dict[str, float]
    note: str = Field(min_length=1, max_length=1000)
    measured_at: datetime | None = None
    source: str | None = Field(default=None, min_length=1, max_length=100)
    condition: str | None = Field(default=None, max_length=100)


class MeasurementVoid(VersionInput):
    """作废保留原始值、原因与审计。"""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    reason: str = Field(min_length=1, max_length=1000)


class MeasurementQuery(BaseModel):
    """指标查询的自然日范围、分页和条件。"""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["weight", "blood_pressure", "blood_glucose", "blood_lipids"] | None = None
    days: int = Field(default=30, ge=1, le=366)
    condition: Literal["fasting", "after_meal_2h", "random"] | None = None
    from_date: date | None = None
    to_date: date | None = None
    include_voided: bool = False
    limit: int = Field(default=100, ge=1, le=500)
    offset: int = Field(default=0, ge=0)


def validate_metric_values(kind: str, values: dict[str, float]) -> None:
    """验证指标结构，不进行诊断或临床风险分级。"""
    if set(values) != set(METRIC_FIELDS[kind]) or any(not math.isfinite(v) or v <= 0 for v in values.values()):
        raise ValueError("指标数值须完整且为有限正数")
    if kind == "blood_pressure" and values["systolic"] <= values["diastolic"]:
        raise ValueError("收缩压须大于舒张压")
