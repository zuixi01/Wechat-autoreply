"""家庭档案的 HTTP 与真实 PostgreSQL 权限、版本及记录验证。"""

import asyncio
import os
import socket
import uuid
from datetime import datetime, timedelta, UTC

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
import uvicorn
from sqlalchemy import insert, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from server.routers import router
from server.utils.auth_middleware import get_db
from yuxi.storage.postgres.models_business import Base, Department, FamilyMember, FamilyMeasurement, User
from yuxi.utils.auth_utils import AuthUtils

pytestmark = pytest.mark.integration
TEST_TOKENS = {}


@pytest.fixture(scope="session", autouse=True)
def cleanup_test_sandboxes():
    """此文件仅创建临时数据库 schema，不创建或清理 Agent 沙盒。"""
    yield


@pytest_asyncio.fixture
async def family_client(monkeypatch):
    """用独立 schema 运行真实路由和数据库，不连接生产服务。"""
    dsn = os.getenv("FAMILY_TEST_POSTGRES_URL") or os.getenv("POSTGRES_URL")
    if not dsn:
        pytest.skip("FAMILY_TEST_POSTGRES_URL 未配置")
    monkeypatch.setenv("API_KEY_DERIVATION_SECRET", "family-integration-synthetic-secret")
    schema = "family_test_" + uuid.uuid4().hex
    bootstrap = create_async_engine(dsn)
    async with bootstrap.begin() as conn:
        await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_async_engine(dsn, connect_args={"server_settings": {"search_path": schema}})
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with sessions() as db:
        dept = Department(name="合成测试部门")
        db.add(dept)
        await db.flush()
        for uid in ("owner", "member", "stranger"):
            user = User(uid=uid, username=uid, password_hash="test-only", role="user", department_id=dept.id)
            db.add(user)
            await db.flush()
            TEST_TOKENS[uid] = AuthUtils.create_access_token({"sub": str(user.id)})
        await db.commit()

    async def database():
        async with sessions() as db:
            yield db

    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = database
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        for _ in range(100):
            if server.started:
                break
            if task.done():
                await task
            await asyncio.sleep(0.01)
        assert server.started
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{listener.getsockname()[1]}") as client:
            yield client, sessions
    finally:
        server.should_exit = True
        await task
        listener.close()
    await engine.dispose()
    async with bootstrap.begin() as conn:
        await conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    await bootstrap.dispose()


def headers(uid="owner"):
    """构造仅供集成测试的认证身份。"""
    return {"Authorization": f"Bearer {TEST_TOKENS[uid]}"}


async def create_family(client):
    """建立家庭及本人档案。"""
    response = await client.post("/api/family", headers=headers(), json={"name": "合成测试家庭"})
    assert response.status_code == 200, response.text
    return response.json()


async def invite_member(client, family_id, adult=True):
    """创建成员并由另一登录用户认领。"""
    response = await client.post(
        f"/api/family/{family_id}/members", headers=headers(), json={"name": "合成成员", "relationship": "配偶"}
    )
    assert response.status_code == 200, response.text
    member_id = response.json()["id"]
    invitation = await client.post(f"/api/family/{family_id}/members/{member_id}/invite", headers=headers())
    assert invitation.status_code == 200
    claimed = await client.post("/api/family/join", headers=headers("member"), json={"code": invitation.json()["code"]})
    assert claimed.status_code == 200, claimed.text
    if adult:
        await client.put(
            f"/api/family/{family_id}/members/{member_id}",
            headers=headers("member"),
            json={"expected_version": 1, "profile": {"birth_date": "1990-01-01"}},
        )
    return member_id


async def grant(client, family_id, member_id, fields):
    """由本人授予有期限的字段访问权。"""
    return await client.put(
        f"/api/family/{family_id}/members/{member_id}/authorization",
        headers=headers("member"),
        json={
            "fields": fields,
            "edit_fields": fields,
            "expires_at": (datetime.now(UTC) + timedelta(days=30)).isoformat(),
        },
    )


def measurement_payload(kind="weight", **overrides):
    """只使用合成实测值，固定创建意图以验证重试。"""
    return {
        "id": str(uuid.uuid4()),
        "kind": kind,
        "values": {"glucose": 5.5} if kind == "blood_glucose" else {"weight": 60},
        "measured_at": (datetime.now(UTC) - timedelta(hours=1)).isoformat(),
        "source": "manual",
        "condition": "fasting" if kind == "blood_glucose" else "",
        "note": "",
        **overrides,
    }


@pytest.mark.asyncio
async def test_view_only_grant_cannot_write_correct_or_void_and_export_rechecks(family_client):
    """仅查看不授予代维护；撤回后历史、趋势和导出均关闭。"""
    client, sessions = family_client
    family = await create_family(client)
    fid, mid = family["id"], await invite_member(client, family["id"])
    path = f"/api/family/{fid}/members/{mid}"
    record = measurement_payload()
    assert (await client.post(path + "/measurements", headers=headers("member"), json=record)).status_code == 200
    body = {"fields": ["birth_date", "weight"], "expires_at": (datetime.now(UTC) + timedelta(days=1)).isoformat()}
    assert (await client.put(path + "/authorization", headers=headers("member"), json=body)).status_code == 200
    member = next(
        m for m in (await client.get(f"/api/family/{fid}", headers=headers())).json()["members"] if m["id"] == mid
    )
    assert member["editable_fields"] == []
    assert member["allowed_fields"] == ["birth_date", "weight"]
    assert (await client.get(path + "/measurements/export", headers=headers())).json()["total"] == 1
    assert (
        await client.put(path, headers=headers(), json={"expected_version": 2, "profile": {"birth_date": "1991-01-01"}})
    ).status_code == 403
    assert (await client.post(path + "/measurements", headers=headers(), json=measurement_payload())).status_code == 403
    rid = record["id"]
    assert (
        await client.put(
            path + f"/measurements/{rid}",
            headers=headers(),
            json={"expected_version": 1, "values": {"weight": 61}, "note": "更正"},
        )
    ).status_code == 403
    assert (
        await client.post(
            path + f"/measurements/{rid}/void", headers=headers(), json={"expected_version": 1, "reason": "重复"}
        )
    ).status_code == 403
    assert (
        await client.put(
            path + "/authorization", headers=headers("member"), json={**body, "edit_fields": ["height_cm"]}
        )
    ).status_code == 422
    await grant(client, fid, mid, [])
    for suffix in ("/history", "/measurements", "/measurements/export"):
        assert (await client.get(path + suffix, headers=headers())).status_code == 403
    async with sessions() as db:
        saved = await db.scalar(select(FamilyMeasurement).where(FamilyMeasurement.id == rid))
        assert saved.version == 1 and saved.values == {"weight": 60} and saved.voided_at is None


@pytest.mark.asyncio
async def test_noop_preserves_confirmation_and_history_masks_paginated_changes(family_client):
    """相同保存与确认无额外版本，历史分页保留相邻差异且只含授权字段。"""
    client, sessions = family_client
    family = await create_family(client)
    fid, mid = family["id"], await invite_member(client, family["id"])
    path = f"/api/family/{fid}/members/{mid}"
    profile = {"height_cm": 170, "allergens": [], "medical_history": "合成私密资料"}
    saved = (await client.put(path, headers=headers("member"), json={"expected_version": 2, "profile": profile})).json()
    confirmed = (await client.post(path + "/confirm", headers=headers("member"), json={"expected_version": 3})).json()
    assert confirmed["confirmed_at"]
    replay = await client.put(path, headers=headers("member"), json={"expected_version": 3, "profile": profile})
    assert replay.json()["version"] == saved["version"] == 3
    assert replay.json()["confirmed_at"] == confirmed["confirmed_at"]
    await client.post(path + "/confirm", headers=headers("member"), json={"expected_version": 3})
    assert (
        await client.put(path, headers=headers("member"), json={"expected_version": 2, "profile": profile})
    ).status_code == 409
    await grant(client, fid, mid, ["height_cm"])
    await client.put(path, headers=headers(), json={"expected_version": 3, "profile": {"height_cm": 171}})
    first = (await client.get(path + "/history?limit=1", headers=headers())).json()
    assert first["total"] == 3 and len(first["items"]) == 1
    assert first["items"][0]["actor"] == "owner"
    assert first["items"][0]["changes"] == {"height_cm": {"before": 170, "after": 171}}
    second = (await client.get(path + "/history?limit=1&offset=1", headers=headers())).json()["items"][0]
    assert second["confirmed_at"] == confirmed["confirmed_at"]
    assert second["profile"] == {"height_cm": 170}
    assert "合成私密" not in str(first) + str(second)
    assert (await client.get(path + "/history?offset=-1", headers=headers())).status_code == 422
    async with sessions() as db:
        assert await db.scalar(text("SELECT count(*) FROM family_audits WHERE action='profile.confirm'")) == 1
        assert await db.scalar(text("SELECT count(*) FROM family_profile_revisions")) == 3


@pytest.mark.asyncio
async def test_relationship_lifecycle_revokes_grants_invites_and_keeps_history(family_client):
    """停用、恢复、本人退出与跨家庭尝试在真实接口和数据库闭合。"""
    client, sessions = family_client
    family = await create_family(client)
    fid, mid = family["id"], await invite_member(client, family["id"])
    path = f"/api/family/{fid}/members/{mid}"
    await grant(client, fid, mid, ["birth_date", "weight"])
    changed = await client.put(
        path + "/relationship",
        headers=headers(),
        json={"expected_version": 1, "name": "新合成昵称", "relationship": "家人"},
    )
    assert changed.json()["version"] == 2 and changed.json()["relationship_version"] == 2
    assert (
        await client.put(
            path + "/relationship",
            headers=headers(),
            json={"expected_version": 1, "name": "旧覆盖", "relationship": "家人"},
        )
    ).status_code == 409
    assert (
        await client.put(
            path + "/status", headers=headers("stranger"), json={"expected_version": 2, "is_active": False}
        )
    ).status_code == 404
    status = {"expected_version": 2, "is_active": False}
    assert (await client.put(path + "/status", headers=headers(), json=status)).status_code == 200
    assert (await client.get(f"/api/family/{fid}", headers=headers("member"))).status_code == 404
    assert (await client.get(path + "/measurements/export", headers=headers())).status_code == 404
    assert (
        await client.put(path, headers=headers(), json={"expected_version": 2, "profile": {"birth_date": "1991-01-01"}})
    ).status_code == 404
    assert (
        await client.put(path + "/status", headers=headers("member"), json={"expected_version": 3, "is_active": True})
    ).status_code == 403
    restored = await client.put(path + "/status", headers=headers(), json={"expected_version": 3, "is_active": True})
    assert restored.json()["allowed_fields"] == []
    assert (await client.get(path + "/history", headers=headers())).status_code == 403
    assert (await client.get(path + "/history", headers=headers("member"))).json()["total"] == 1
    assert (
        await client.put(path + "/status", headers=headers("member"), json={"expected_version": 4, "is_active": False})
    ).status_code == 200
    assert (await client.get("/api/family", headers=headers("member"))).json() == []
    owner_mid = family["members"][0]["id"]
    assert (
        await client.put(
            f"/api/family/{fid}/members/{owner_mid}/status",
            headers=headers(),
            json={"expected_version": 1, "is_active": False},
        )
    ).status_code == 409
    async with sessions() as db:
        row = await db.get(FamilyMember, mid)
        assert not row.is_active and row.grant_fields == row.grant_edit_fields == [] and row.invite_hash is None
        assert row.profile == {"birth_date": "1990-01-01"}
    added = (
        await client.post(
            f"/api/family/{fid}/members", headers=headers(), json={"name": "未认领", "relationship": "家人"}
        )
    ).json()
    invite_path = f"/api/family/{fid}/members/{added['id']}/invite"
    code = (await client.post(invite_path, headers=headers())).json()["code"]
    assert (await client.post(invite_path + "/revoke", headers=headers())).status_code == 200
    assert (await client.post("/api/family/join", headers=headers("stranger"), json={"code": code})).status_code == 410
    assert (await client.post(invite_path, headers=headers())).json()["code"] != code


@pytest.mark.asyncio
async def test_measurement_metadata_correction_void_retry_filters_and_persistence(family_client):
    """更正元信息重新校验，作废幂等，趋势与统计读取有效最终记录。"""
    client, sessions = family_client
    family = await create_family(client)
    fid, mid = family["id"], family["members"][0]["id"]
    path = f"/api/family/{fid}/members/{mid}/measurements"
    payload = measurement_payload("blood_glucose")
    assert (await client.post(path, headers=headers(), json=payload)).status_code == 200
    correction = {
        "expected_version": 1,
        "values": {"glucose": 5.6},
        "note": "修正采样时间",
        "source": "report",
        "condition": "random",
        "measured_at": (datetime.now(UTC) - timedelta(days=1)).isoformat(),
    }
    for invalid in (
        {"measured_at": (datetime.now(UTC) + timedelta(days=1)).isoformat()},
        {"condition": "unknown"},
        {"source": None},
    ):
        assert (
            await client.put(path + "/" + payload["id"], headers=headers(), json={**correction, **invalid})
        ).status_code == 422
    fixed = (await client.put(path + "/" + payload["id"], headers=headers(), json=correction)).json()
    assert fixed["version"] == 2 and fixed["condition"] == "random" and fixed["source"] == "report"
    assert fixed["previous"][0]["measured_at"] == payload["measured_at"].replace("+00:00", "Z")
    assert fixed["previous"][0]["actor"] == "owner"
    assert (await client.get(path + "?kind=blood_glucose&condition=fasting", headers=headers())).json()["total"] == 0
    assert (await client.get(path + "?kind=blood_glucose&condition=random", headers=headers())).json()["total"] == 1
    assert (
        await client.post(
            path + f"/{payload['id']}/void", headers=headers(), json={"expected_version": 1, "reason": "重复"}
        )
    ).status_code == 409
    void_body = {"expected_version": 2, "reason": "合成重复记录"}
    for _ in range(2):
        voided = await client.post(path + f"/{payload['id']}/void", headers=headers(), json=void_body)
        assert voided.status_code == 200 and voided.json()["version"] == 3
    assert (
        await client.put(path + "/" + payload["id"], headers=headers(), json={**correction, "expected_version": 3})
    ).status_code == 409
    assert (
        await client.post(path + f"/{payload['id']}/void", headers=headers(), json={**void_body, "reason": "不同请求"})
    ).status_code == 409
    assert (await client.post(path, headers=headers(), json=payload)).json()["voided_at"]
    active = (await client.get(path, headers=headers())).json()
    assert active["total"] == 0 and active["trend"] == []
    assert (await client.get(path + "/export", headers=headers())).json()["total"] == 0
    archived = (await client.get(path + "?include_voided=true", headers=headers())).json()
    assert archived["total"] == 1 and archived["trend"] == []
    assert (await client.get(f"/api/family/{fid}/statistics", headers=headers())).json()["record_count"] == 0
    for query in (
        "from_date=2026-10-08&to_date=2026-10-01",
        "days=367",
        "offset=-1",
        "limit=501",
        "from_date=2020-01-01",
        "to_date=2099-01-01",
    ):
        assert (await client.get(path + "?" + query, headers=headers())).status_code == 422
    async with sessions() as db:
        saved = await db.get(FamilyMeasurement, payload["id"])
        assert saved.creation_intent == {**payload, "measured_at": payload["measured_at"].replace("+00:00", "Z")}
        assert saved.voided_by == "owner" and len(saved.previous) == 2


@pytest.mark.asyncio
async def test_long_measurement_history_counts_pages_trend_and_export_limit(family_client):
    """超过旧截断上限的真实数据不丢计数，分页不改变趋势，导出明确拒绝过大范围。"""
    client, sessions = family_client
    family = await create_family(client)
    fid, mid = family["id"], family["members"][0]["id"]
    now = datetime.now(UTC).replace(tzinfo=None) - timedelta(hours=1)
    rows = [
        {
            "id": str(uuid.uuid4()),
            "member_id": mid,
            "kind": "weight",
            "values": {"weight": 60 + index / 100000},
            "measured_at": now - timedelta(seconds=index),
            "source": "manual",
            "created_by": "owner",
            "creation_intent": {},
        }
        for index in range(10001)
    ]
    rows.append({**rows[-1], "id": str(uuid.uuid4()), "measured_at": now - timedelta(days=2), "values": {"weight": 62}})
    async with sessions() as db:
        await db.execute(insert(FamilyMeasurement), rows)
        await db.commit()
    path = f"/api/family/{fid}/members/{mid}/measurements"
    first = (await client.get(path + "?limit=20", headers=headers())).json()
    second = (await client.get(path + "?limit=20&offset=20", headers=headers())).json()
    assert first["total"] == second["total"] == 10002
    assert len(first["items"]) == len(second["items"]) == 20
    assert {r["id"] for r in first["items"]}.isdisjoint(r["id"] for r in second["items"])
    assert first["trend"] == second["trend"]
    assert any(point["values"] == {"weight": 62} for point in first["trend"])
    overview = (await client.get(f"/api/family/{fid}/statistics", headers=headers())).json()
    assert overview["record_count"] == overview["metric_counts"]["weight"] == 10002
    assert sum(row["count"] for row in overview["daily_counts"]) == 10002
    oversized = await client.get(path + "/export", headers=headers())
    assert oversized.status_code == 422 and oversized.json()["detail"]["code"] == "export_too_large"
    old_day = (now.replace(tzinfo=UTC) + timedelta(hours=8) - timedelta(days=2)).date().isoformat()
    bounded = (await client.get(path + f"/export?from_date={old_day}&to_date={old_day}", headers=headers())).json()
    assert bounded["total"] == 1 and bounded["items"][0]["values"] == {"weight": 62}


@pytest.mark.asyncio
async def test_family_is_private_and_requires_authentication(family_client):
    client, _ = family_client
    assert (await client.get("/api/family")).status_code == 401
    family = await create_family(client)
    assert family["members"][0]["is_self"] is True
    assert (await client.get("/api/family", headers=headers("stranger"))).json() == []
    assert (await client.get(f"/api/family/{family['id']}", headers=headers("stranger"))).status_code == 404


@pytest.mark.asyncio
async def test_owner_needs_subject_authorization_for_fields_and_metrics(family_client):
    client, _ = family_client
    family = await create_family(client)
    fid = family["id"]
    mid = await invite_member(client, fid)
    path = f"/api/family/{fid}/members/{mid}"
    denied = await client.put(path, headers=headers(), json={"expected_version": 1, "profile": {"height_cm": 170}})
    assert denied.status_code == 403
    assert (await grant(client, fid, mid, ["height_cm", "weight"])).status_code == 200
    result = await client.put(path, headers=headers(), json={"expected_version": 2, "profile": {"height_cm": 170}})
    assert result.status_code == 200
    assert result.json()["profile"] == {"height_cm": 170}
    assert (
        await client.put(
            path, headers=headers(), json={"expected_version": 2, "profile": {"medical_history": "合成敏感信息"}}
        )
    ).status_code == 403
    assert (
        await client.put(
            path + "/authorization",
            headers=headers(),
            json={"fields": ["medical_history"], "expires_at": (datetime.now(UTC) + timedelta(days=1)).isoformat()},
        )
    ).status_code == 403


@pytest.mark.asyncio
async def test_measurement_retries_conflicts_and_revocation(family_client):
    client, sessions = family_client
    family = await create_family(client)
    fid = family["id"]
    mid = await invite_member(client, fid)
    await grant(client, fid, mid, ["weight"])
    rid = str(uuid.uuid4())
    measured = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    payload = {
        "id": rid,
        "kind": "weight",
        "values": {"weight": 63.4},
        "measured_at": measured,
        "source": "manual",
        "condition": "",
        "note": "",
    }
    path = f"/api/family/{fid}/members/{mid}/measurements"
    first = await client.post(path, headers=headers(), json=payload)
    assert first.status_code == 200, first.text
    assert (await client.post(path, headers=headers(), json=payload)).json()["id"] == rid
    assert (await client.post(path, headers=headers(), json={**payload, "values": {"weight": 64}})).status_code == 409
    corrected = await client.put(
        path + "/" + rid,
        headers=headers(),
        json={"expected_version": 1, "values": {"weight": 63.5}, "note": "更正合成记录"},
    )
    assert corrected.status_code == 200
    assert corrected.json()["version"] == 2
    assert corrected.json()["previous"][0]["values"] == {"weight": 63.4}
    overview = await client.get(f"/api/family/{fid}/statistics?days=30", headers=headers())
    assert overview.status_code == 200
    assert overview.json()["record_count"] == 1
    await grant(client, fid, mid, [])
    listed = (await client.get(f"/api/family/{fid}", headers=headers())).json()
    member = next(row for row in listed["members"] if row["id"] == mid)
    assert member["profile"] == {}
    assert (await client.get(path, headers=headers())).status_code == 403
    assert (await client.post(path, headers=headers(), json=payload)).status_code == 403
    assert (await client.get(f"/api/family/{fid}/statistics", headers=headers())).json()["record_count"] == 0
    async with sessions() as db:
        count = await db.scalar(text("SELECT count(*) FROM family_measurements"))
        assert count == 1


@pytest.mark.asyncio
async def test_profile_version_and_unknown_values(family_client):
    client, _ = family_client
    family = await create_family(client)
    path = f"/api/family/{family['id']}/members/{family['members'][0]['id']}"
    saved = await client.put(path, headers=headers(), json={"expected_version": 1, "profile": {"height_cm": 165}})
    assert saved.status_code == 200
    assert saved.json()["version"] == 2
    assert "birth_date" in saved.json()["missing_fields"]
    assert (
        await client.put(path, headers=headers(), json={"expected_version": 1, "profile": {"height_cm": 166}})
    ).status_code == 409
    assert (await client.post(path + "/confirm", headers=headers(), json={"expected_version": 2})).status_code == 200
    history = (await client.get(path + "/history", headers=headers())).json()
    assert history["items"][0]["profile"]["height_cm"] == 165


@pytest.mark.asyncio
async def test_metric_shape_time_expiry_and_foreign_member_are_rejected(family_client):
    client, _ = family_client
    family = await create_family(client)
    fid, mid = family["id"], family["members"][0]["id"]
    path = f"/api/family/{fid}/members/{mid}/measurements"
    payload = {
        "id": str(uuid.uuid4()),
        "kind": "blood_pressure",
        "values": {"systolic": 120},
        "measured_at": datetime.now(UTC).isoformat(),
        "source": "manual",
    }
    assert (await client.post(path, headers=headers(), json=payload)).status_code == 422
    payload.update(
        kind="weight", values={"weight": 60}, measured_at=(datetime.now(UTC) + timedelta(days=1)).isoformat()
    )
    assert (await client.post(path, headers=headers(), json=payload)).status_code == 422
    assert (
        await client.get(f"/api/family/{uuid.uuid4()}/members/{mid}/measurements", headers=headers())
    ).status_code == 404
    pending = await invite_member(client, fid)
    expired = await client.put(
        f"/api/family/{fid}/members/{pending}/authorization",
        headers=headers("member"),
        json={"fields": ["weight"], "expires_at": (datetime.now(UTC) - timedelta(hours=1)).isoformat()},
    )
    assert expired.status_code == 422


@pytest.mark.asyncio
async def test_expired_grant_filters_profile_history_and_statistics(family_client):
    """落库授权过期后，所有健康读取路径都重新校验。"""
    client, sessions = family_client
    family = await create_family(client)
    fid = family["id"]
    mid = await invite_member(client, fid)
    path = f"/api/family/{fid}/members/{mid}"
    await client.put(
        path,
        headers=headers("member"),
        json={"expected_version": 2, "profile": {"height_cm": 172, "medical_history": "合成私密信息"}},
    )
    await grant(client, fid, mid, ["height_cm", "weight"])
    history = (await client.get(path + "/history", headers=headers())).json()
    assert history["items"][0]["profile"] == {"height_cm": 172}
    async with sessions() as db:
        member = await db.scalar(select(FamilyMember).where(FamilyMember.id == mid))
        member.grant_expires_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(seconds=1)
        await db.commit()
    response = await client.get(f"/api/family/{fid}", headers=headers())
    assert response.headers["cache-control"] == "no-store"
    visible = next(row for row in response.json()["members"] if row["id"] == mid)
    assert visible["profile"] == {} and visible["allowed_fields"] == []
    assert (await client.get(path + "/history", headers=headers())).status_code == 403
    assert (await client.get(path + "/measurements", headers=headers())).status_code == 403
    own = (await client.get(path + "/history", headers=headers("member"))).json()
    assert own["items"][0]["profile"]["medical_history"] == "合成私密信息"


@pytest.mark.asyncio
async def test_concurrent_retries_preserve_one_measurement(family_client):
    """真实并发请求由家庭事务锁串行化，落库仅一条。"""
    client, sessions = family_client
    family = await create_family(client)
    fid, mid = family["id"], family["members"][0]["id"]
    payload = {
        "id": str(uuid.uuid4()),
        "kind": "weight",
        "values": {"weight": 62},
        "measured_at": datetime.now(UTC).isoformat(),
        "source": "manual",
    }
    responses = await asyncio.gather(
        *[
            client.post(f"/api/family/{fid}/members/{mid}/measurements", headers=headers(), json=payload)
            for _ in range(3)
        ]
    )
    assert [response.status_code for response in responses] == [200, 200, 200]
    async with sessions() as db:
        assert await db.scalar(text("SELECT count(*) FROM family_measurements")) == 1


@pytest.mark.asyncio
async def test_member_authorization_requires_adult_profile(family_client):
    """年龄未知或未成年时拒绝开放；本人读写与撤回不受影响。"""
    client, _ = family_client
    family = await create_family(client)
    fid = family["id"]
    mid = await invite_member(client, fid, adult=False)
    path = f"/api/family/{fid}/members/{mid}"
    assert (await grant(client, fid, mid, ["weight"])).status_code == 422
    await client.put(
        path, headers=headers("member"), json={"expected_version": 1, "profile": {"birth_date": "2015-01-01"}}
    )
    assert (await grant(client, fid, mid, ["weight"])).status_code == 422
    assert (await grant(client, fid, mid, [])).status_code == 200


@pytest.mark.asyncio
async def test_invitation_and_claim_retries_do_not_create_new_access(family_client):
    """响应丢失可重放，已认领代码不会让其他账户获得关系。"""
    client, _ = family_client
    family = await create_family(client)
    fid = family["id"]
    created = await client.post(
        f"/api/family/{fid}/members", headers=headers(), json={"name": "合成邀请成员", "relationship": "家人"}
    )
    mid = created.json()["id"]
    path = f"/api/family/{fid}/members/{mid}/invite"
    first = (await client.post(path, headers=headers())).json()
    second = (await client.post(path, headers=headers())).json()
    assert first == second
    payload = {"code": first["code"]}
    assert (await client.post("/api/family/join", headers=headers("member"), json=payload)).status_code == 200
    replay = await client.post("/api/family/join", headers=headers("member"), json=payload)
    assert replay.status_code == 200
    assert len(replay.json()["members"]) == 2
    assert (await client.post("/api/family/join", headers=headers("stranger"), json=payload)).status_code == 410
    assert (await client.post(path, headers=headers())).status_code == 403
