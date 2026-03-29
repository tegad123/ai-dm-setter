from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os

from app.api.routes import auth, leads, conversations, webhooks, booking
from app.services.meta_api import meta_client
from app.services.leadconnector_service import lc_client


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown lifecycle hooks."""
    # Startup — nothing special needed, clients init lazily
    yield
    # Shutdown — close HTTP clients cleanly
    await meta_client.close()
    await lc_client.close()


app = FastAPI(
    title="DAETRADEZ AI DM Setter",
    description="AI-powered DM setter for Daniel Elumelu's DAE Trading Accelerator",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static files for voice notes
os.makedirs("static/voice_notes", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

# Routes
app.include_router(auth.router, prefix="/api/v1")
app.include_router(leads.router, prefix="/api/v1")
app.include_router(conversations.router, prefix="/api/v1")
app.include_router(webhooks.router, prefix="/api/v1")
app.include_router(booking.router, prefix="/api/v1")


@app.get("/")
async def root():
    return {"app": "DAETRADEZ AI DM Setter", "version": "1.0.0", "status": "running"}


@app.get("/health")
async def health():
    return {"status": "healthy"}
