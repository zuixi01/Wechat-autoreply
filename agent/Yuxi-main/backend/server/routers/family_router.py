"""家庭档案的认证、输入模型和 HTTP 适配。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from server.utils.auth_middleware import get_db, get_required_user
from yuxi.services.family_schemas import (
    AuthorizationInput,
    FamilyInput,
    JoinInput,
    MeasurementInput,
    MeasurementQuery,
    MeasurementUpdate,
    MeasurementVoid,
    MemberInput,
    MemberStatusInput,
    MemberUpdate,
    ProfileUpdate,
    VersionInput,
)
from yuxi.services.family_service import FamilyService
from yuxi.storage.postgres.models_business import User


def private_response(response: Response):
    """健康相关响应禁止公共或浏览器持久缓存。"""
    response.headers["Cache-Control"] = "no-store"


def family_service(db: AsyncSession = Depends(get_db), user: User = Depends(get_required_user)):
    """从认证身份建立业务上下文。"""
    return FamilyService(db, user.uid)


family = APIRouter(prefix="/family", tags=["family"], dependencies=[Depends(private_response)])


@family.get("")
async def list_families(service=Depends(family_service)):
    """列出可访问家庭。"""
    return await service.list_families()


@family.post("")
async def create_family(payload: FamilyInput, user: User = Depends(get_required_user), service=Depends(family_service)):
    """创建家庭及本人档案。"""
    return await service.create_family(payload.name, user.username)


@family.post("/join")
async def join_family(payload: JoinInput, service=Depends(family_service)):
    """本人认领邀请关系。"""
    return await service.join(payload.code)


@family.get("/{fid}")
async def get_family(fid: str, service=Depends(family_service)):
    """读取当前授权范围的家庭档案。"""
    return await service.family(fid)


@family.post("/{fid}/members")
async def add_member(fid: str, payload: MemberInput, service=Depends(family_service)):
    """添加成员昵称和关系。"""
    return await service.add_member(fid, payload.name, payload.relationship)


@family.put("/{fid}/members/{mid}")
async def update_profile(fid: str, mid: str, payload: ProfileUpdate, service=Depends(family_service)):
    """更新指定字段并保存版本。"""
    return await service.update_profile(fid, mid, payload)


@family.put("/{fid}/members/{mid}/relationship")
async def update_member(fid: str, mid: str, payload: MemberUpdate, service=Depends(family_service)):
    """按版本维护昵称与关系。"""
    return await service.update_member(fid, mid, payload)


@family.put("/{fid}/members/{mid}/status")
async def member_status(fid: str, mid: str, payload: MemberStatusInput, service=Depends(family_service)):
    """退出、停用或恢复关系，保留历史。"""
    return await service.member_status(fid, mid, payload)


@family.post("/{fid}/members/{mid}/confirm")
async def confirm_profile(fid: str, mid: str, payload: VersionInput, service=Depends(family_service)):
    """本人确认当前档案。"""
    return await service.confirm(fid, mid, payload.expected_version)


@family.get("/{fid}/members/{mid}/history")
async def profile_history(
    fid: str,
    mid: str,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    service=Depends(family_service),
):
    """受当前授权限制的档案历史。"""
    return await service.history(fid, mid, limit=limit, offset=offset)


@family.post("/{fid}/members/{mid}/invite")
async def invite_member(fid: str, mid: str, service=Depends(family_service)):
    """生成短期一次性邀请。"""
    return await service.invite(fid, mid)


@family.put("/{fid}/members/{mid}/authorization")
async def authorize_member(fid: str, mid: str, payload: AuthorizationInput, service=Depends(family_service)):
    """本人维护用途、字段与有效期。"""
    return await service.authorization(
        fid, mid, payload.fields, payload.purpose, payload.expires_at, payload.edit_fields
    )


@family.post("/{fid}/members/{mid}/invite/revoke")
async def revoke_invitation(fid: str, mid: str, service=Depends(family_service)):
    """撤销尚未认领的邀请。"""
    return await service.revoke_invitation(fid, mid)


@family.get("/{fid}/members/{mid}/measurements")
async def list_measurements(
    fid: str,
    mid: str,
    filters: Annotated[MeasurementQuery, Query()],
    service=Depends(family_service),
):
    """读取当前可见指标。"""
    return await service.measurements(fid, mid, **filters.model_dump())


@family.get("/{fid}/members/{mid}/measurements/export")
async def export_measurements(
    fid: str,
    mid: str,
    filters: Annotated[MeasurementQuery, Query()],
    service=Depends(family_service),
):
    """导出经过当前授权校验的所选指标记录。"""
    return await service.export_measurements(fid, mid, **filters.model_dump(exclude={"limit", "offset"}))


@family.post("/{fid}/members/{mid}/measurements")
async def add_measurement(fid: str, mid: str, payload: MeasurementInput, service=Depends(family_service)):
    """幂等保存实测记录。"""
    return await service.add_measurement(fid, mid, payload)


@family.put("/{fid}/members/{mid}/measurements/{rid}")
async def correct_measurement(
    fid: str, mid: str, rid: str, payload: MeasurementUpdate, service=Depends(family_service)
):
    """更正并保留旧版本。"""
    return await service.correct_measurement(fid, mid, rid, payload)


@family.post("/{fid}/members/{mid}/measurements/{rid}/void")
async def void_measurement(fid: str, mid: str, rid: str, payload: MeasurementVoid, service=Depends(family_service)):
    """按版本作废并保留原始记录。"""
    return await service.void_measurement(fid, mid, rid, payload)


@family.get("/{fid}/statistics")
async def statistics(fid: str, days: int = Query(30, ge=1, le=365), service=Depends(family_service)):
    """计算所选期间可见记录的聚合。"""
    return await service.statistics(fid, days)
