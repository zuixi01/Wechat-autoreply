"""在真实 PostgreSQL 上验证上游与家庭版本升级及重复执行。"""

import os
import uuid

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from yuxi import storage_migration
from yuxi.storage.postgres.manager import PostgresManager
from yuxi.storage.postgres.models_business import Agent, Base, User, FamilyArchive, FamilyMember
from yuxi.storage_migrations.v071_workdirs import V071WorkdirMigrationPlan

pytestmark = pytest.mark.integration


@pytest.fixture(scope="session", autouse=True)
def cleanup_test_sandboxes():
    """只创建数据库 schema，不接触 Agent 沙盒。"""
    yield


async def no_file_migration(*_args, **_kwargs):
    """隔离此次纯 Schema 迁移以外的已有文件迁移。"""
    return None


@pytest.mark.asyncio
@pytest.mark.parametrize("old_version,fail_after_schema", [(7, False), (8, False), (9, False), (10, False), (10, True)])
async def test_supported_upgrade_preserves_data_and_is_repeatable(
    monkeypatch, tmp_path, old_version, fail_after_schema
):
    """迁移保留旧用户、家庭授权和上游资源选择，重复执行不改变空选择。"""
    dsn = os.getenv("FAMILY_TEST_POSTGRES_URL") or os.getenv("POSTGRES_URL")
    if not dsn:
        pytest.skip("FAMILY_TEST_POSTGRES_URL 未配置")
    schema = "family_migrate_" + uuid.uuid4().hex
    bootstrap = create_async_engine(dsn)
    async with bootstrap.begin() as conn:
        await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_async_engine(dsn, connect_args={"server_settings": {"search_path": schema}})
    manager = object.__new__(PostgresManager)
    PostgresManager.__init__(manager)
    manager.async_engine = engine
    manager.AsyncSession = async_sessionmaker(engine, expire_on_commit=False)
    manager._initialized = True
    old_tables = [
        table for table in Base.metadata.sorted_tables if old_version in (8, 10) or not table.name.startswith("family_")
    ]
    try:
        async with engine.begin() as conn:
            await conn.run_sync(lambda sync: Base.metadata.create_all(sync, tables=old_tables))
        async with manager.get_async_session_context() as db:
            db.add(User(uid="old-user", username="保留的合成用户", password_hash="synthetic-only", role="user"))
            await db.flush()
            if old_version in (8, 10):
                db.add(FamilyArchive(id="old-family", owner_uid="old-user", name="保留家庭"))
                await db.flush()
                db.add(
                    FamilyMember(
                        id="old-member",
                        family_id="old-family",
                        subject_uid="old-user",
                        name="合成成员",
                        relationship="本人",
                        profile={"height_cm": 170},
                        grant_fields=["height_cm", "weight"],
                    )
                )
            db.add(
                Agent(
                    slug="old-agent",
                    name="合成智能体",
                    backend_id="chatbot",
                    share_config={},
                    config_json={
                        "context": {
                            "tools": [] if old_version >= 9 else None,
                            "subagents": [] if old_version >= 9 else None,
                        }
                    },
                )
            )
        if old_version in (8, 10):
            async with engine.begin() as conn:
                for column in ("is_active", "relationship_version", "confirmed_at", "grant_edit_fields"):
                    await conn.execute(text(f"ALTER TABLE family_members DROP COLUMN {column}"))
                for column in ("voided_at", "voided_by", "void_reason"):
                    await conn.execute(text(f"ALTER TABLE family_measurements DROP COLUMN {column}"))
        await manager.create_schema_version_table()
        await manager.record_schema_version("business", old_version)
        await manager.record_schema_version("knowledge", 2)

        async def workdir_plan(_db):
            """测试数据库已经是现代工作区布局。"""
            return V071WorkdirMigrationPlan(False, (), ())

        monkeypatch.setattr(storage_migration, "pg_manager", manager)
        monkeypatch.setattr(storage_migration, "read_v071_workdir_plan", workdir_plan)
        monkeypatch.setattr(storage_migration, "_legacy_skill_roots_exist", lambda: False)
        monkeypatch.setattr(storage_migration, "_legacy_system_config_exists", lambda: False)
        monkeypatch.setattr(storage_migration, "runtime_storage_requires_quiescence", lambda: False)
        monkeypatch.setattr(storage_migration, "get_legacy_storage_dir", lambda: tmp_path)
        monkeypatch.setattr(storage_migration, "_converge_database_state", no_file_migration)
        monkeypatch.setattr(storage_migration, "migrate_shared_skills", no_file_migration)
        monkeypatch.setattr(storage_migration, "mark_v071_skills_migrated", lambda: None)
        monkeypatch.setattr(storage_migration, "migrate_runtime_storage_identity", lambda: None)
        monkeypatch.setattr(manager, "close", no_file_migration)
        if fail_after_schema:

            async def fail_convergence(**_kwargs):
                """模拟后续迁移失败，组合版本必须尚未发布。"""
                raise RuntimeError("injected convergence failure")

            monkeypatch.setattr(storage_migration, "_converge_database_state", fail_convergence)
            with pytest.raises(RuntimeError, match="injected convergence failure"):
                await storage_migration.main()
            assert await manager.get_schema_versions() == {"business": 10, "knowledge": 2}
            monkeypatch.setattr(storage_migration, "_converge_database_state", no_file_migration)
        await storage_migration.main()
        await storage_migration.main()
        await manager.require_current_schema()
        async with engine.connect() as conn:
            tables = await conn.run_sync(lambda sync: inspect(sync).get_table_names())
            assert {
                "family_archives",
                "family_members",
                "family_measurements",
                "family_profile_revisions",
                "family_audits",
            } <= set(tables)
            assert await conn.scalar(text("SELECT username FROM users WHERE uid = 'old-user'")) == "保留的合成用户"
            config = await conn.scalar(text("SELECT config_json FROM agents WHERE slug = 'old-agent'"))
            assert config["context"]["subagents"] == ([] if old_version >= 9 else "all")
            assert config["context"]["tools"] == ([] if old_version >= 9 else "all")
            if old_version in (8, 10):
                assert await conn.scalar(text("SELECT profile FROM family_members WHERE id = 'old-member'")) == {
                    "height_cm": 170
                }
                assert await conn.scalar(text("SELECT grant_fields FROM family_members WHERE id = 'old-member'")) == [
                    "height_cm",
                    "weight",
                ]
                assert await conn.scalar(
                    text("SELECT grant_edit_fields FROM family_members WHERE id = 'old-member'")
                ) == ["height_cm", "weight"]
                assert await conn.scalar(text("SELECT is_active FROM family_members WHERE id = 'old-member'")) is True
                await conn.execute(
                    text("UPDATE family_members SET grant_edit_fields = '[]'::jsonb WHERE id = 'old-member'")
                )
                await conn.commit()
            assert {"voided_at", "voided_by", "void_reason"} <= set(
                await conn.run_sync(lambda sync: [c["name"] for c in inspect(sync).get_columns("family_measurements")])
            )
        await storage_migration.upgrade_family_archives(manager)
        await storage_migration.main()
        if old_version in (8, 10):
            async with engine.connect() as conn:
                assert (
                    await conn.scalar(text("SELECT grant_edit_fields FROM family_members WHERE id = 'old-member'"))
                    == []
                )
        assert await manager.get_schema_versions() == {"business": 11, "knowledge": 2}
    finally:
        await engine.dispose()
        async with bootstrap.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await bootstrap.dispose()
