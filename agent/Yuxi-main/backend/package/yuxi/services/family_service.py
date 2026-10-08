"""家庭档案用例：权限、版本、幂等、事务与统计。"""

import hashlib
import uuid
from datetime import date, datetime, timedelta, UTC
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from yuxi.repositories.family_repository import FamilyRepository
from yuxi.services.family_schemas import (
    METRIC_FIELDS,
    METRIC_UNITS,
    PROFILE_FIELDS,
    REQUIRED_PROFILE_FIELDS,
    MeasurementInput,
)
from yuxi.storage.postgres.models_business import FamilyArchive, FamilyMeasurement, FamilyMember, FamilyProfileRevision
from yuxi.utils.datetime_utils import format_utc_datetime, utc_now_naive
from yuxi.utils.auth_utils import AuthUtils

DISPLAY_ZONE = ZoneInfo("Asia/Shanghai")


def is_adult(member):
    """一期按本人填写的出生日期限制成年成员授权；不替代身份核验。"""
    born = (member.profile or {}).get("birth_date")
    if not born:
        return False
    birth_date = date.fromisoformat(born)
    today = datetime.now(DISPLAY_ZONE).date()
    return today.year - birth_date.year - ((today.month, today.day) < (birth_date.month, birth_date.day)) >= 18


def authorized_fields(family, member, uid, now=None, *, write=False):
    """在有效关系与授权中分别计算查看和代维护范围。"""
    if not member.is_active:
        return set()
    if member.subject_uid == uid:
        return PROFILE_FIELDS | METRIC_FIELDS.keys()
    now = now or utc_now_naive()
    if (
        family.owner_uid == uid
        and member.subject_uid
        and is_adult(member)
        and member.grant_purpose == "family_nutrition"
        and member.grant_expires_at
        and member.grant_expires_at > now
    ):
        readable = set(member.grant_fields or [])
        return readable & set(member.grant_edit_fields or []) if write else readable
    return set()


def member_view(family, member, uid):
    """按当前访问范围投影，隐藏未经授权的字段及其完整度。"""
    allowed = authorized_fields(family, member, uid)
    editable = authorized_fields(family, member, uid, write=True)
    profile = {key: value for key, value in (member.profile or {}).items() if key in allowed}
    missing = [key for key in REQUIRED_PROFILE_FIELDS if key in allowed and profile.get(key) in (None, "", [])]
    full_profile_access = set(REQUIRED_PROFILE_FIELDS) <= allowed
    return {
        "id": member.id,
        "name": member.name,
        "relationship": member.relationship,
        "is_active": member.is_active,
        "relationship_version": member.relationship_version,
        "is_self": member.subject_uid == uid,
        "claimed": member.subject_uid is not None,
        "profile": profile,
        "allowed_fields": sorted(allowed),
        "editable_fields": sorted(editable),
        "version": member.version,
        "confirmed": member.confirmed_version == member.version if full_profile_access else None,
        "missing_fields": missing,
        "ready": full_profile_access and not missing and member.confirmed_version == member.version,
        "readiness_scope": "basic_profile",
        "unknown_fields": sorted(key for key in allowed & PROFILE_FIELDS if profile.get(key) in (None, "")),
        "confirmed_at": format_utc_datetime(member.confirmed_at) if full_profile_access else None,
        "updated_at": format_utc_datetime(member.updated_at),
        "authorization": {
            "fields": sorted(allowed) if member.subject_uid != uid else sorted(member.grant_fields or []),
            "edit_fields": sorted(editable) if member.subject_uid != uid else sorted(member.grant_edit_fields or []),
            "expires_at": format_utc_datetime(member.grant_expires_at),
            "purpose": member.grant_purpose,
        }
        if member.subject_uid == uid or family.owner_uid == uid
        else None,
    }


def measurement_view(record, names=None):
    """返回带来源、更正版本及固定单位的实测记录。"""
    names = names or {}
    return {
        "id": record.id,
        "member_id": record.member_id,
        "kind": record.kind,
        "values": record.values,
        "measured_at": format_utc_datetime(record.measured_at),
        "unit": METRIC_UNITS[record.kind],
        "source": record.source,
        "condition": record.condition,
        "note": record.note,
        "version": record.version,
        "previous": record.previous or [],
        "created_by": names.get(record.created_by, "家庭成员"),
        "voided_at": format_utc_datetime(record.voided_at),
        "voided_by": names.get(record.voided_by) if record.voided_by else None,
        "void_reason": record.void_reason,
    }


class FamilyService:
    """持有家庭事务，并在每次读取或副作用前执行授权校验。"""

    def __init__(self, db, uid):
        self.db, self.uid = db, str(uid)
        self.repo = FamilyRepository(db)

    async def context(self, fid, mid=None, *, include_inactive=False):
        """获取可访问家庭和严格属于该家庭的成员。"""
        family = await self.repo.get_family(fid, self.uid, include_inactive=include_inactive)
        if family is None:
            raise HTTPException(404, "家庭不存在或不可访问")
        member = await self.repo.member(fid, mid) if mid else None
        if mid and (member is None or (not member.is_active and not include_inactive)):
            raise HTTPException(404, "成员不存在")
        return family, member

    def require_fields(self, family, member, fields, *, write=False):
        """授权字段必须覆盖此次读写；空白和过期都拒绝。"""
        if not set(fields) <= authorized_fields(family, member, self.uid, write=write):
            raise HTTPException(403, "请由成员本人授权对应字段")

    def require_version(self, member, expected):
        """拒绝基于旧版本覆盖最新档案。"""
        if member.version != expected:
            raise HTTPException(409, "档案已更新，请重新核对")

    async def list_families(self):
        """列表只包含家庭关系元信息。"""
        families = await self.repo.list_families(self.uid)
        return [{"id": row.id, "name": row.name, "is_owner": row.owner_uid == self.uid} for row in families]

    async def family(self, fid):
        """返回当前字段范围内的档案，记录访问。"""
        family, _ = await self.context(fid)
        members = await self.repo.members(fid)
        result = {
            "id": fid,
            "name": family.name,
            "is_owner": family.owner_uid == self.uid,
            "members": [member_view(family, member, self.uid) for member in members if member.is_active],
            "inactive_members": [member_view(family, member, self.uid) for member in members if not member.is_active]
            if family.owner_uid == self.uid
            else [],
        }
        await self.repo.audit(fid, None, self.uid, "profiles.read")
        await self.db.commit()
        return result

    async def create_family(self, name, username):
        """每个用户管理一个家庭；重复相同请求返回已有家庭。"""
        existing = await self.repo.owned_family(self.uid)
        if existing:
            if existing.name != name:
                raise HTTPException(409, "当前账户已经管理一个家庭")
            return await self.family(existing.id)
        family = FamilyArchive(id=str(uuid.uuid4()), owner_uid=self.uid, name=name)
        member = FamilyMember(
            id=str(uuid.uuid4()), family_id=family.id, subject_uid=self.uid, name=username, relationship="本人"
        )
        try:
            self.db.add(family)
            await self.db.flush()
            self.db.add(member)
            await self.repo.audit(family.id, member.id, self.uid, "family.create")
            await self.db.commit()
        except IntegrityError:
            await self.db.rollback()
            existing = await self.repo.owned_family(self.uid)
            if existing and existing.name == name:
                return await self.family(existing.id)
            raise HTTPException(409, "当前账户已经管理一个家庭") from None
        return await self.family(family.id)

    async def add_member(self, fid, name, relationship):
        """仅管理员新增成员关系；健康信息须本人认领后授权。"""
        family, _ = await self.context(fid)
        if family.owner_uid != self.uid:
            raise HTTPException(403, "仅家庭管理员可添加成员")
        members = await self.repo.members(fid)
        if sum(member.is_active for member in members) >= 30:
            raise HTTPException(422, "一个家庭最多30名成员")
        member = FamilyMember(id=str(uuid.uuid4()), family_id=fid, name=name, relationship=relationship)
        self.db.add(member)
        await self.db.flush()
        result = member_view(family, member, self.uid)
        await self.repo.audit(fid, member.id, self.uid, "member.create")
        await self.db.commit()
        return result

    async def update_member(self, fid, mid, payload):
        """本人或管理员按关系版本维护昵称与关系。"""
        family, member = await self.context(fid, mid)
        if self.uid not in {family.owner_uid, member.subject_uid}:
            raise HTTPException(403, "仅本人或家庭管理员可维护成员关系")
        if member.relationship_version != payload.expected_version:
            raise HTTPException(409, "成员关系已更新，请重新核对")
        if (member.name, member.relationship) != (payload.name, payload.relationship):
            member.name, member.relationship = payload.name, payload.relationship
            member.relationship_version += 1
            await self.repo.audit(fid, mid, self.uid, "member.update", member.relationship_version)
        result = member_view(family, member, self.uid)
        await self.db.commit()
        return result

    async def member_status(self, fid, mid, payload):
        """退出或停用撤销授权与邀请；恢复关系不恢复授权。"""
        family, member = await self.context(fid, mid, include_inactive=True)
        is_owner = family.owner_uid == self.uid
        if not is_owner and (member.subject_uid != self.uid or payload.is_active):
            raise HTTPException(403, "仅管理员可恢复成员，本人可退出自己的关系")
        if member.subject_uid == family.owner_uid:
            raise HTTPException(409, "家庭管理员不能停用或退出本人关系")
        if member.relationship_version != payload.expected_version:
            raise HTTPException(409, "成员关系已更新，请重新核对")
        if member.is_active != payload.is_active:
            if payload.is_active and sum(row.is_active for row in await self.repo.members(fid)) >= 30:
                raise HTTPException(422, "一个家庭最多30名有效成员")
            member.is_active = payload.is_active
            member.relationship_version += 1
            member.grant_fields, member.grant_edit_fields = [], []
            member.grant_expires_at, member.grant_purpose = None, None
            member.invite_hash, member.invite_expires_at = None, None
            action = "member.restore" if payload.is_active else "member.deactivate" if is_owner else "member.leave"
            await self.repo.audit(fid, mid, self.uid, action, member.relationship_version)
        result = member_view(family, member, self.uid)
        await self.db.commit()
        return result

    async def revoke_invitation(self, fid, mid):
        """管理员撤销未认领邀请，下次生成不同代码。"""
        family, member = await self.context(fid, mid)
        if family.owner_uid != self.uid or member.subject_uid:
            raise HTTPException(403, "当前成员不能撤销邀请")
        member.invite_hash, member.invite_expires_at = None, None
        await self.repo.audit(fid, mid, self.uid, "member.invite.revoke")
        await self.db.commit()
        return {"revoked": True}

    async def invite(self, fid, mid):
        """只向管理员返回一次性短期邀请；数据库保存摘要。"""
        family, member = await self.context(fid, mid)
        if family.owner_uid != self.uid or member.subject_uid:
            raise HTTPException(403, "当前成员不能重新邀请")
        if not member.invite_expires_at or member.invite_expires_at <= utc_now_naive():
            member.invite_expires_at = utc_now_naive() + timedelta(days=2)
        key, _, _ = AuthUtils.derive_api_key(f"family-invitation:{member.invite_expires_at.isoformat()}", member.id)
        code = "family_" + key.removeprefix("yxkey_")
        member.invite_hash = hashlib.sha256(code.encode()).hexdigest()
        await self.repo.audit(fid, mid, self.uid, "member.invite")
        await self.db.commit()
        return {"code": code, "expires_at": format_utc_datetime(member.invite_expires_at)}

    async def join(self, code):
        """已登录的本人认领关系，不自动开放健康信息。"""
        digest = hashlib.sha256(code.encode()).hexdigest()
        candidate = await self.repo.invitation(digest)
        if candidate is None:
            raise HTTPException(410, "邀请已失效")
        fid, mid = candidate.family_id, candidate.id
        family = await self.db.scalar(select(FamilyArchive).where(FamilyArchive.id == fid).with_for_update())
        member = await self.repo.member(fid, mid)
        await self.db.refresh(member)
        valid = (
            member.is_active
            and member.invite_hash == digest
            and member.invite_expires_at
            and member.invite_expires_at > utc_now_naive()
        )
        if valid and member.subject_uid == self.uid:
            return await self.family(fid)
        if (
            member.invite_hash != digest
            or not member.is_active
            or member.subject_uid
            or not member.invite_expires_at
            or member.invite_expires_at <= utc_now_naive()
        ):
            raise HTTPException(410, "邀请已失效")
        if family.owner_uid == self.uid or await self.repo.subject_member(fid, self.uid):
            raise HTTPException(409, "当前账户已经是此家庭成员")
        member.subject_uid = self.uid
        await self.repo.audit(fid, mid, self.uid, "member.claim")
        await self.db.commit()
        return await self.family(fid)

    async def authorization(self, fid, mid, fields, purpose, expires_at, edit_fields):
        """仅档案本人可授予或撤回向家庭管理员开放的字段。"""
        family, member = await self.context(fid, mid)
        if member.subject_uid != self.uid:
            raise HTTPException(403, "授权须由成员本人确认")
        if fields and not is_adult(member):
            raise HTTPException(422, "请先在本人档案填写出生日期；一期仅支持成年成员向管理员授权")
        if not set(edit_fields) <= set(fields):
            raise HTTPException(422, "代维护范围必须包含在查看范围内")
        member.grant_fields = sorted(set(fields))
        member.grant_edit_fields = sorted(set(edit_fields))
        member.grant_purpose = purpose
        member.grant_expires_at = expires_at.astimezone(UTC).replace(tzinfo=None)
        result = member_view(family, member, self.uid)
        await self.repo.audit(fid, mid, self.uid, "authorization.change")
        await self.db.commit()
        return result

    async def update_profile(self, fid, mid, payload):
        """按授予字段和当前版本修改，保存新的完整快照。"""
        family, member = await self.context(fid, mid)
        changes = payload.profile.model_dump(mode="json", exclude_unset=True)
        if not changes:
            raise HTTPException(422, "没有档案变更")
        self.require_fields(family, member, changes, write=True)
        self.require_version(member, payload.expected_version)
        changes = {key: value for key, value in changes.items() if (member.profile or {}).get(key) != value}
        if not changes:
            result = member_view(family, member, self.uid)
            await self.db.commit()
            return result
        member.profile = {**(member.profile or {}), **changes}
        member.version += 1
        member.confirmed_at = None
        member.updated_at = utc_now_naive()
        self.db.add(
            FamilyProfileRevision(member_id=mid, version=member.version, profile=member.profile, actor_uid=self.uid)
        )
        result = member_view(family, member, self.uid)
        await self.repo.audit(fid, mid, self.uid, "profile.update", member.version)
        await self.db.commit()
        return result

    async def confirm(self, fid, mid, expected_version):
        """本人核对当前档案，不用管理员身份代替本人确认。"""
        family, member = await self.context(fid, mid)
        if member.subject_uid != self.uid:
            raise HTTPException(403, "档案确认须由本人完成")
        self.require_version(member, expected_version)
        if member.confirmed_version != member.version:
            member.confirmed_version = member.version
            member.confirmed_at = utc_now_naive()
            await self.repo.audit(
                fid, mid, self.uid, "profile.confirm", member.version, occurred_at=member.confirmed_at
            )
        result = member_view(family, member, self.uid)
        await self.db.commit()
        return result

    async def history(self, fid, mid, *, limit=20, offset=0):
        """历史快照同样使用当前授权，撤回不能通过历史绕过。"""
        family, member = await self.context(fid, mid)
        allowed = authorized_fields(family, member, self.uid) & PROFILE_FIELDS
        if not allowed:
            raise HTTPException(403, "无档案访问权限")
        records, total = await self.repo.revisions(mid, limit=limit, offset=offset)
        names = await self.repo.actor_names(fid)
        confirmations = await self.repo.confirmations(mid)
        items = []
        for index, row in enumerate(records[:limit]):
            previous = records[index + 1].profile if index + 1 < len(records) else {}
            changes = {
                key: {"before": previous.get(key), "after": row.profile.get(key)}
                for key in allowed
                if previous.get(key) != row.profile.get(key)
            }
            items.append(
                {
                    "version": row.version,
                    "profile": {k: v for k, v in row.profile.items() if k in allowed},
                    "changes": changes,
                    "actor": names.get(row.actor_uid, "家庭成员"),
                    "created_at": format_utc_datetime(row.created_at),
                    "confirmed_at": format_utc_datetime(confirmations.get(row.version)),
                }
            )
        result = {"items": items, "total": total, "limit": limit, "offset": offset}
        await self.repo.audit(fid, mid, self.uid, "profile.history")
        await self.db.commit()
        return result

    async def measurements(
        self,
        fid,
        mid,
        kind=None,
        days=30,
        *,
        limit=100,
        offset=0,
        condition=None,
        include_voided=False,
        from_date=None,
        to_date=None,
    ):
        """分页读取当前授权指标，支持日期、条件与作废记录筛选。"""
        family, member = await self.context(fid, mid)
        allowed = authorized_fields(family, member, self.uid) & METRIC_FIELDS.keys()
        if not allowed or (kind and kind not in allowed):
            raise HTTPException(403, "无指标访问权限")
        since, until = self._measurement_period(days, from_date, to_date)
        records, total = await self.repo.measurement_page(
            [mid],
            [kind] if kind else allowed,
            since,
            until,
            limit=limit,
            offset=offset,
            condition=condition,
            include_voided=include_voided,
        )
        names = await self.repo.actor_names(fid)
        trend = await self.repo.measurement_trend(mid, [kind] if kind else allowed, since, until, condition)
        result = {
            "items": [measurement_view(row, names) for row in records],
            "total": total,
            "limit": limit,
            "offset": offset,
            "truncated": offset + len(records) < total,
            "trend": [
                {"kind": row.kind, "values": row.values, "measured_at": format_utc_datetime(row.measured_at)}
                for row in trend
            ],
        }
        await self.repo.audit(fid, mid, self.uid, "measurements.read")
        await self.db.commit()
        return result

    async def export_measurements(self, fid, mid, kind=None, days=30, **filters):
        """重新校验授权后导出所选记录，超过明确上限时要求缩短范围。"""
        result = await self.measurements(fid, mid, kind, days, limit=10000, **filters)
        if result["truncated"]:
            raise HTTPException(
                422, detail={"code": "export_too_large", "message": "记录超过10000条，请缩短导出日期范围"}
            )
        return {"exported_at": format_utc_datetime(utc_now_naive()), "items": result["items"], "total": result["total"]}

    async def add_measurement(self, fid, mid, payload):
        """幂等创建实测记录，不把失败或重试当成新增摄入。"""
        family, member = await self.context(fid, mid)
        self.require_fields(family, member, [payload.kind], write=True)
        intent = payload.model_dump(mode="json")
        rid = str(payload.id)
        existing = await self.repo.measurement(rid)
        if existing:
            if existing.member_id != mid or existing.created_by != self.uid or existing.creation_intent != intent:
                raise HTTPException(409, "记录ID已经用于其他请求")
            return measurement_view(existing)
        record = FamilyMeasurement(
            id=rid,
            member_id=mid,
            kind=payload.kind,
            values=payload.values,
            measured_at=payload.measured_at.astimezone(UTC).replace(tzinfo=None),
            source=payload.source,
            condition=payload.condition,
            note=payload.note,
            created_by=self.uid,
            creation_intent=intent,
        )
        try:
            self.db.add(record)
            await self.db.flush()
            await self.repo.audit(fid, mid, self.uid, "measurement.create", 1)
            result = measurement_view(record)
            await self.db.commit()
        except IntegrityError:
            await self.db.rollback()
            raise HTTPException(409, "记录ID已经用于其他请求") from None
        return result

    async def correct_measurement(self, fid, mid, rid, payload):
        """更正测量数值及元信息，保留旧快照和操作者。"""
        family, member = await self.context(fid, mid)
        record = await self.repo.measurement(rid)
        if record is None or record.member_id != mid:
            raise HTTPException(404, "记录不存在")
        self.require_fields(family, member, [record.kind], write=True)
        if record.voided_at:
            raise HTTPException(409, "作废记录不能更正，请重新录入正确记录")
        if record.version != payload.expected_version:
            raise HTTPException(409, "记录已更新")
        try:
            updated = MeasurementInput(
                **{
                    "id": record.id,
                    "kind": record.kind,
                    "values": record.values,
                    "measured_at": record.measured_at.replace(tzinfo=UTC),
                    "source": record.source,
                    "condition": record.condition,
                    "note": record.note,
                    **payload.model_dump(exclude_unset=True, exclude={"expected_version"}),
                }
            )
        except ValidationError:
            raise HTTPException(422, "更正信息必须包含有效数值、非未来时间和正确测量条件") from None
        names = await self.repo.actor_names(fid)
        record.previous = [*(record.previous or []), self._measurement_revision(record, names, "corrected")]
        record.values, record.note = updated.values, updated.note
        record.measured_at = updated.measured_at.astimezone(UTC).replace(tzinfo=None)
        record.source, record.condition = updated.source, updated.condition
        record.version += 1
        record.updated_at = utc_now_naive()
        result = measurement_view(record, names)
        await self.repo.audit(fid, mid, self.uid, "measurement.correct", record.version)
        await self.db.commit()
        return result

    async def void_measurement(self, fid, mid, rid, payload):
        """作废保留原值与创建意图，重复同一请求不新增版本。"""
        family, member = await self.context(fid, mid)
        record = await self.repo.measurement(rid)
        if record is None or record.member_id != mid:
            raise HTTPException(404, "记录不存在")
        self.require_fields(family, member, [record.kind], write=True)
        names = await self.repo.actor_names(fid)
        if record.voided_at:
            if (
                record.voided_by != self.uid
                or record.void_reason != payload.reason
                or payload.expected_version not in {record.version, record.version - 1}
            ):
                raise HTTPException(409, "记录已作废，请重新核对")
        else:
            if record.version != payload.expected_version:
                raise HTTPException(409, "记录已更新")
            record.previous = [*(record.previous or []), self._measurement_revision(record, names, "voided")]
            record.voided_at, record.voided_by, record.void_reason = utc_now_naive(), self.uid, payload.reason
            record.version += 1
            record.updated_at = record.voided_at
            await self.repo.audit(fid, mid, self.uid, "measurement.void", record.version)
        result = measurement_view(record, names)
        await self.db.commit()
        return result

    async def statistics(self, fid, days=30):
        """仅汇总当前可见实测记录，不计算跨成员的医学平均值。"""
        family, _ = await self.context(fid)
        members = [member for member in await self.repo.members(fid) if member.is_active]
        today = datetime.now(DISPLAY_ZONE).date()
        start = today - timedelta(days=days - 1)
        since = datetime.combine(start, datetime.min.time(), DISPLAY_ZONE).astimezone(UTC).replace(tzinfo=None)
        until = (
            datetime.combine(today + timedelta(days=1), datetime.min.time(), DISPLAY_ZONE)
            .astimezone(UTC)
            .replace(tzinfo=None)
        )
        visible = {row.id: authorized_fields(family, row, self.uid) for row in members}
        records = await self.repo.measurement_statistics(
            {mid: fields & METRIC_FIELDS.keys() for mid, fields in visible.items()}, since, until
        )
        dates = {(start + timedelta(days=index)).isoformat(): 0 for index in range(days)}
        counts = {kind: 0 for kind in METRIC_FIELDS}
        for row in records:
            dates[row.day.isoformat()] += row.count
            counts[row.kind] += row.count
        result = {
            "member_count": len(members),
            "visible_member_count": sum(bool(fields) for fields in visible.values()),
            "ready_member_count": sum(member_view(family, row, self.uid)["ready"] for row in members),
            "record_count": sum(row.count for row in records),
            "record_member_count": len({row.member_id for row in records}),
            "daily_counts": [{"date": key, "count": value} for key, value in dates.items()],
            "metric_counts": counts,
            "from": start.isoformat(),
            "to": today.isoformat(),
            "as_of": format_utc_datetime(utc_now_naive()),
            "timezone": "Asia/Shanghai",
        }
        await self.repo.audit(fid, None, self.uid, "statistics.read")
        await self.db.commit()
        return result

    def _measurement_revision(self, record, names, action):
        """在受控记录内保存完整旧状态，审计表仍只保存元信息。"""
        return {
            "version": record.version,
            "values": record.values,
            "note": record.note,
            "measured_at": format_utc_datetime(record.measured_at),
            "source": record.source,
            "condition": record.condition,
            "action": action,
            "actor": names.get(self.uid, "家庭成员"),
            "corrected_at": format_utc_datetime(utc_now_naive()),
        }

    def _measurement_period(self, days, from_date, to_date):
        """把上海自然日范围转换为统一 UTC 查询边界。"""
        today = datetime.now(DISPLAY_ZONE).date()
        end = to_date or today
        start = from_date or end - timedelta(days=days - 1)
        if start > end or end > today or (end - start).days >= 366:
            raise HTTPException(
                422, detail={"code": "invalid_period", "message": "日期范围须为过去或今天，且不超过366天"}
            )
        since = datetime.combine(start, datetime.min.time(), DISPLAY_ZONE).astimezone(UTC).replace(tzinfo=None)
        until = (
            datetime.combine(end + timedelta(days=1), datetime.min.time(), DISPLAY_ZONE)
            .astimezone(UTC)
            .replace(tzinfo=None)
        )
        return since, until
