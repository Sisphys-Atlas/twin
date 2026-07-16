"""JWT creation/verification, password hashing, FastAPI auth dependencies."""

import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from time import time
from typing import Optional

from fastapi import Depends, HTTPException, Request, status
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.kb.database import get_db
from app.kb.models import User

# ── Config ─────────────────────────────────────────────────────────────────────

_ENV        = os.environ.get("ENVIRONMENT", "development").lower()
_IS_PROD    = _ENV == "production"

SECRET_KEY  = os.environ.get("JWT_SECRET", "")
ALGORITHM   = "HS256"
TOKEN_TTL_H = 24

# Bridge-to-backend shared secret — set BRIDGE_SECRET env var on both bridge and backend
BRIDGE_SECRET = os.environ.get("BRIDGE_SECRET", "twin-bridge-default-change-me")

_COOKIE_NAME = "twin_token"

if not SECRET_KEY:
    if _IS_PROD:
        print("[auth] FATAL: JWT_SECRET env var is not set. Refusing to start in production.", file=sys.stderr)
        sys.exit(1)
    SECRET_KEY = "twin-dev-only-secret-not-for-production"
    print("[auth] WARNING: JWT_SECRET not set — using insecure dev default. Set JWT_SECRET before deploying.")

if BRIDGE_SECRET == "twin-bridge-default-change-me" and _IS_PROD:
    print("[auth] FATAL: BRIDGE_SECRET env var is not set. Refusing to start in production.", file=sys.stderr)
    sys.exit(1)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# ── Password ───────────────────────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


# ── JWT ────────────────────────────────────────────────────────────────────────

def create_token(user: User) -> str:
    payload = {
        "sub":     user.username,
        "user_id": user.id,
        "role":    user.role,
        "exp":     datetime.now(timezone.utc) + timedelta(hours=TOKEN_TTL_H),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None


# ── Cookie helpers ─────────────────────────────────────────────────────────────

def cookie_kwargs() -> dict:
    """Returns Set-Cookie kwargs appropriate for the current environment."""
    return {
        "key":       _COOKIE_NAME,
        "httponly":  True,
        "samesite":  "lax",
        "secure":    _IS_PROD,   # Secure flag only on HTTPS (production)
        "path":      "/",
        "max_age":   TOKEN_TTL_H * 3600,
    }


def clear_cookie_kwargs() -> dict:
    return {
        "key":      _COOKIE_NAME,
        "httponly": True,
        "samesite": "lax",
        "secure":   _IS_PROD,
        "path":     "/",
        "max_age":  0,
    }


# ── Rate limiting (in-memory, per-process) ─────────────────────────────────────

_login_attempts: dict[str, list[float]] = defaultdict(list)

def check_rate_limit(ip: str) -> None:
    now   = time()
    _login_attempts[ip] = [t for t in _login_attempts[ip] if now - t < 60]
    if len(_login_attempts[ip]) >= 5:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many login attempts — wait 1 minute",
        )
    _login_attempts[ip].append(now)


# ── Bridge secret verification ─────────────────────────────────────────────────

def verify_bridge_secret(request: Request) -> None:
    """Dependency for bridge-only endpoints (inbound, connected, disconnected, upload)."""
    secret = request.headers.get("X-Bridge-Secret", "")
    if secret != BRIDGE_SECRET:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid bridge secret")


# ── FastAPI user auth dependencies ─────────────────────────────────────────────

def _get_token_from_request(request: Request) -> Optional[str]:
    # httpOnly cookie is the primary method (browser clients)
    token = request.cookies.get(_COOKIE_NAME)
    if token:
        return token
    # Authorization: Bearer is the fallback (API clients / scripts)
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    return None


def get_current_user(
    request: Request,
    db: Session = Depends(get_db),
) -> User:
    token = _get_token_from_request(request)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")

    payload = decode_token(token)
    if not payload:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")

    user = db.query(User).filter(User.id == payload["user_id"], User.is_active == True).first()
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found")
    return user


def require_assistant(user: User = Depends(get_current_user)) -> User:
    if user.role == "viewer":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Viewer accounts cannot perform this action")
    return user


def require_owner(user: User = Depends(get_current_user)) -> User:
    if user.role not in ("owner", "superadmin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Owner access required")
    return user


def require_superadmin(user: User = Depends(get_current_user)) -> User:
    if user.role != "superadmin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Superadmin access required")
    return user
