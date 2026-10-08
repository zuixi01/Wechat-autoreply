"""仅供本地 UI 验证的隔离服务；家庭与认证使用正式路由和 PostgreSQL。

POSTGRES_URL 和 REDIS_URL 必须指向一次性测试容器；其余导航资源为空 fixture。
启动：python -m uvicorn test.fixtures.family_preview:app --host 0.0.0.0 --port 5050
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import select

from server.routers.auth_router import auth
from server.routers.family_router import family
from yuxi.storage.postgres.manager import pg_manager
from yuxi.storage.postgres.models_business import Department, User
from yuxi.utils.auth_utils import AuthUtils


@asynccontextmanager
async def lifespan(_app):
    """在专用测试数据库建立合成账户，不接入生产初始化入口。"""
    pg_manager.initialize()
    await pg_manager.create_business_tables()
    async with pg_manager.get_async_session_context() as db:
        dept = await db.scalar(select(Department).where(Department.name == "本地合成测试"))
        if not dept:
            dept = Department(name="本地合成测试")
            db.add(dept)
            await db.flush()
        for uid, name in (("family-owner", "合成管理员"), ("family-member", "合成成员")):
            if not await db.scalar(select(User).where(User.uid == uid)):
                db.add(
                    User(
                        uid=uid,
                        username=name,
                        password_hash=AuthUtils.hash_password("FamilyTest123!"),
                        role="user",
                        department_id=dept.id,
                    )
                )
    yield
    await pg_manager.close()


app = FastAPI(lifespan=lifespan)
app.include_router(auth, prefix="/api")
app.include_router(family, prefix="/api")


@app.get("/api/system/info")
async def info():
    """保留现有 Yuxi 品牌与导航外壳。"""
    return {
        "success": True,
        "data": {
            "branding": {"name": "Yuxi", "title": "Yuxi"},
            "organization": {"name": "Yuxi", "logo": "/favicon.svg", "avatar": "/favicon.svg"},
            "footer": {},
        },
    }


@app.get("/api/system/config")
async def config():
    """无需模型与 Agent 的档案验证。"""
    return {}


@app.get("/api/system/health")
async def health():
    """仅表达此测试 API 进程可访问。"""
    return {"status": "ok"}


@app.get("/api/agent")
@app.get("/api/chat/threads")
@app.get("/api/projects")
async def empty_navigation():
    """其他模块在该 fixture 中不参与验收。"""
    return []


@app.get("/api/knowledge/databases/accessible")
async def empty_knowledge():
    """不连接其他项目的知识库服务。"""
    return {"databases": []}


@app.get("/api/system/mcp-servers")
@app.get("/api/skills/accessible")
@app.get("/api/system/tools")
async def empty_resources():
    """不连接工具服务。"""
    return {"data": []}
