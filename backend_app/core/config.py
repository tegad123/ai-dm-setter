from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    app_name: str = "DAETRADEZ AI DM Setter"
    debug: bool = False

    # Database
    database_url: str = "postgresql+asyncpg://postgres:password@localhost:5432/daetradez_dm"

    # Auth
    secret_key: str = "change-me-in-production"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 1440

    # AI Engine
    anthropic_api_key: str = ""
    openai_api_key: str = ""

    # ElevenLabs
    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = ""

    # Meta
    meta_app_id: str = ""
    meta_app_secret: str = ""
    meta_page_access_token: str = ""
    meta_verify_token: str = ""
    instagram_account_id: str = ""

    # LeadConnector
    leadconnector_api_key: str = ""
    leadconnector_calendar_id: str = ""
    leadconnector_location_id: str = ""

    # Redis
    redis_url: str = "redis://localhost:6379/0"

    # Response delay range (seconds)
    min_response_delay: int = 300  # 5 minutes
    max_response_delay: int = 600  # 10 minutes

    # Notifications
    notification_email: str = ""
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""

    model_config = {"env_file": ".env", "extra": "ignore"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
