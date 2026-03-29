"""Seed the admin user (Daniel) into the database."""
import asyncio
import sys
sys.path.insert(0, ".")

from sqlalchemy import select
from app.core.database import engine, async_session, Base
from app.core.security import get_password_hash
from app.models.models import User
from app.models.enums import UserRole


async def seed():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with async_session() as session:
        result = await session.execute(select(User).where(User.email == "daetradez2003@gmail.com"))
        if result.scalar_one_or_none():
            print("Admin user already exists.")
            return

        admin = User(
            email="daetradez2003@gmail.com",
            hashed_password=get_password_hash("changeme123"),
            full_name="Daniel Elumelu",
            role=UserRole.ADMIN,
        )
        session.add(admin)
        await session.commit()
        print(f"Admin user created: {admin.email} (ID: {admin.id})")


if __name__ == "__main__":
    asyncio.run(seed())
