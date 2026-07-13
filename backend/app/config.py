import os
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql://postgres:postgres@localhost:5432/whatsapp_kb"

    # AI APIs
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash-lite"
    openai_api_key: str = ""

    storage_path: Path = Path("../storage")

    # Path to the bridge/ directory (relative to backend/, or absolute).
    # Used to auto-start a bridge process for a workspace when it isn't
    # already running, instead of requiring a manually-run terminal per number.
    bridge_dir: Path = Path("../bridge")
    bridge_auto_start: bool = True

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()

# google-generativeai reads GOOGLE_API_KEY from the environment natively.
# Forward our GEMINI_API_KEY to that name so genai.configure() is never needed.
if settings.gemini_api_key:
    os.environ["GOOGLE_API_KEY"] = settings.gemini_api_key