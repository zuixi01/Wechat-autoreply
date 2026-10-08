"""家庭维护字段与历史授权的幂等迁移。"""

from sqlalchemy import text


async def upgrade_family_archives(manager) -> None:
    """保留既有查看与代维护授权；新协议空写权限重跑时保持为空。"""
    statements = (
        "ALTER TABLE family_members ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE",
        "ALTER TABLE family_members ADD COLUMN IF NOT EXISTS relationship_version INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE family_members ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP",
        "ALTER TABLE family_members ADD COLUMN IF NOT EXISTS grant_edit_fields JSONB",
        "UPDATE family_members SET grant_edit_fields = grant_fields WHERE grant_edit_fields IS NULL",
        "ALTER TABLE family_members ALTER COLUMN grant_edit_fields SET DEFAULT '[]'::jsonb",
        "ALTER TABLE family_members ALTER COLUMN grant_edit_fields SET NOT NULL",
        "ALTER TABLE family_measurements ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP",
        "ALTER TABLE family_measurements ADD COLUMN IF NOT EXISTS voided_by VARCHAR REFERENCES users(uid)",
        "ALTER TABLE family_measurements ADD COLUMN IF NOT EXISTS void_reason TEXT",
        """UPDATE family_members AS member SET confirmed_at = confirmed.at
           FROM (SELECT member_id, version, MIN(created_at) AS at FROM family_audits
                 WHERE action = 'profile.confirm' GROUP BY member_id, version) AS confirmed
           WHERE member.id = confirmed.member_id AND member.confirmed_version = confirmed.version
             AND member.version = confirmed.version
             AND member.confirmed_at IS NULL""",
        "CREATE INDEX IF NOT EXISTS ix_family_measurements_member_time ON family_measurements(member_id, measured_at)",
    )
    async with manager.async_engine.begin() as connection:
        for statement in statements:
            await connection.execute(text(statement))
