"""家庭档案持久化与带身份范围的查询。"""

from sqlalchemy import and_, exists, func, or_, select
from yuxi.storage.postgres.models_business import (
    FamilyArchive,
    FamilyAudit,
    FamilyMeasurement,
    FamilyMember,
    FamilyProfileRevision,
)


class FamilyRepository:
    """所有操作使用调用方拥有的事务。"""

    def __init__(self, db):
        self.db = db

    def visible_families(self, uid, *, include_inactive=False):
        """仅查询自己管理或本人已加入的家庭。"""
        membership = exists().where(FamilyMember.family_id == FamilyArchive.id, FamilyMember.subject_uid == uid)
        if not include_inactive:
            membership = membership.where(FamilyMember.is_active.is_(True))
        return select(FamilyArchive).where(or_(FamilyArchive.owner_uid == uid, membership))

    async def list_families(self, uid):
        """列出可访问家庭。"""
        return list((await self.db.scalars(self.visible_families(uid).order_by(FamilyArchive.created_at))).all())

    async def get_family(self, fid, uid, *, include_inactive=False):
        """锁定家庭，将授权撤回与受控读写串行化。"""
        return await self.db.scalar(
            self.visible_families(uid, include_inactive=include_inactive)
            .where(FamilyArchive.id == fid)
            .with_for_update()
        )

    async def owned_family(self, uid):
        """读取用户唯一管理的家庭。"""
        return await self.db.scalar(select(FamilyArchive).where(FamilyArchive.owner_uid == uid))

    async def members(self, fid):
        """按稳定顺序读取成员。"""
        return list(
            (
                await self.db.scalars(
                    select(FamilyMember)
                    .where(FamilyMember.family_id == fid)
                    .order_by(FamilyMember.updated_at, FamilyMember.id)
                )
            ).all()
        )

    async def member(self, fid, mid):
        """成员 ID 必须属于当前家庭。"""
        return await self.db.scalar(select(FamilyMember).where(FamilyMember.id == mid, FamilyMember.family_id == fid))

    async def invitation(self, code_hash):
        """只查找邀请的归属，调用方随后锁定家庭并重新核对。"""
        return await self.db.scalar(select(FamilyMember).where(FamilyMember.invite_hash == code_hash))

    async def subject_member(self, fid, uid):
        """防止同一账户在同一家庭认领多个身份。"""
        return await self.db.scalar(
            select(FamilyMember).where(FamilyMember.family_id == fid, FamilyMember.subject_uid == uid)
        )

    async def measurement_page(
        self, mids, kinds=None, since=None, until=None, *, condition=None, include_voided=False, limit=100, offset=0
    ):
        """按授权作用域统计和分页，不以截断列表推断总数。"""
        query = self._measurement_query(mids, kinds, since, until, condition, include_voided)
        total = await self.db.scalar(select(func.count()).select_from(query.subquery()))
        rows = await self.db.scalars(
            query.order_by(FamilyMeasurement.measured_at.desc(), FamilyMeasurement.id).offset(offset).limit(limit)
        )
        return list(rows.all()), total

    async def measurement_statistics(self, visible, since, until):
        """数据库内按当前授权成员、指标和上海日期聚合有效记录。"""
        scopes = [
            and_(FamilyMeasurement.member_id == mid, FamilyMeasurement.kind.in_(kinds))
            for mid, kinds in visible.items()
            if kinds
        ]
        if not scopes:
            return []
        day = func.date(func.timezone("Asia/Shanghai", func.timezone("UTC", FamilyMeasurement.measured_at)))
        query = (
            select(FamilyMeasurement.member_id, FamilyMeasurement.kind, day.label("day"), func.count().label("count"))
            .where(
                or_(*scopes),
                FamilyMeasurement.measured_at >= since,
                FamilyMeasurement.measured_at < until,
                FamilyMeasurement.voided_at.is_(None),
            )
            .group_by(FamilyMeasurement.member_id, FamilyMeasurement.kind, day)
        )
        return list((await self.db.execute(query)).all())

    async def measurement_trend(self, mid, kinds, since, until, condition):
        """趋势从全部有效记录选取每日最后实测，与表格分页独立。"""
        records = self._measurement_query([mid], kinds, since, until, condition, False).subquery()
        day = func.date(func.timezone("Asia/Shanghai", func.timezone("UTC", records.c.measured_at)))
        ranked = select(
            records.c.kind,
            records.c["values"],
            records.c.measured_at,
            func.row_number()
            .over(partition_by=(records.c.kind, day), order_by=(records.c.measured_at.desc(), records.c.id.desc()))
            .label("rank"),
        ).subquery()
        rows = await self.db.execute(select(ranked).where(ranked.c.rank == 1).order_by(ranked.c.measured_at))
        return list(rows.all())

    async def actor_names(self, fid):
        """仅使用该家庭成员昵称解释操作者，不公开账户资料。"""
        rows = await self.db.execute(
            select(FamilyMember.subject_uid, FamilyMember.name).where(FamilyMember.family_id == fid)
        )
        return {uid: name for uid, name in rows if uid}

    async def confirmations(self, mid):
        """读取每个档案版本首次本人确认的时间。"""
        rows = await self.db.execute(
            select(FamilyAudit.version, func.min(FamilyAudit.created_at))
            .where(FamilyAudit.member_id == mid, FamilyAudit.action == "profile.confirm")
            .group_by(FamilyAudit.version)
        )
        return dict(rows.all())

    async def measurement(self, rid):
        """读取幂等记录。调用方必须先校验目标成员权限。"""
        return await self.db.scalar(select(FamilyMeasurement).where(FamilyMeasurement.id == rid))

    async def revisions(self, mid, *, limit=20, offset=0):
        """多读取一个相邻快照，用于分页边界的字段差异。"""
        query = select(FamilyProfileRevision).where(FamilyProfileRevision.member_id == mid)
        total = await self.db.scalar(select(func.count()).select_from(query.subquery()))
        records = await self.db.scalars(
            query.order_by(FamilyProfileRevision.version.desc()).offset(offset).limit(limit + 1)
        )
        return list(records.all()), total

    async def audit(self, fid, mid, uid, action, version=None, *, occurred_at=None):
        """记录元信息，不把健康数值写入日志。"""
        metadata = {"created_at": occurred_at} if occurred_at is not None else {}
        self.db.add(
            FamilyAudit(family_id=fid, member_id=mid, actor_uid=uid, action=action, version=version, **metadata)
        )
        await self.db.flush()

    def _measurement_query(self, mids, kinds, since, until, condition, include_voided):
        """分页与计数共用同一过滤语义。"""
        query = select(FamilyMeasurement).where(FamilyMeasurement.member_id.in_(mids))
        if kinds is not None:
            query = query.where(FamilyMeasurement.kind.in_(kinds))
        if since is not None:
            query = query.where(FamilyMeasurement.measured_at >= since)
        if until is not None:
            query = query.where(FamilyMeasurement.measured_at < until)
        if condition is not None:
            query = query.where(FamilyMeasurement.condition == condition)
        if not include_voided:
            query = query.where(FamilyMeasurement.voided_at.is_(None))
        return query
