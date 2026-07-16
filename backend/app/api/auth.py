"""Authentication endpoints — login, logout, user management."""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security import (
    check_rate_limit,
    clear_cookie_kwargs,
    cookie_kwargs,
    create_token,
    get_current_user,
    hash_password,
    require_owner,
    verify_password,
)
from app.kb.database import get_db
from app.kb.models import AuditLog, User

router = APIRouter(prefix="/auth", tags=["auth"])


# ── Schemas ────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    id: int
    username: str
    role: str
    is_active: bool
    must_change_password: bool = False
    created_at: datetime

    class Config:
        from_attributes = True


class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = "assistant"  # owner / assistant / viewer


class PatchUserRequest(BaseModel):
    role:      str | None = None
    is_active: bool | None = None
    password:  str | None = None


# ── Auth endpoints ─────────────────────────────────────────────────────────────

@router.post("/login")
def login(req: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)):
    client_ip = request.client.host if request.client else "unknown"
    check_rate_limit(client_ip)

    user = db.query(User).filter(
        User.username == req.username,
        User.is_active == True,
    ).first()

    if not user or not verify_password(req.password, user.hashed_password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid username or password")

    token = create_token(user)
    # Set httpOnly cookie — not accessible via JavaScript (XSS protection)
    response.set_cookie(value=token, **cookie_kwargs())
    return {"user": UserOut.from_orm(user)}


@router.get("/me")
def me(user: User = Depends(get_current_user)) -> UserOut:
    return UserOut.from_orm(user)


@router.post("/logout")
def logout(response: Response, _: User = Depends(get_current_user)):
    response.set_cookie(value="", **clear_cookie_kwargs())
    return {"ok": True}


# ── User management (owner only) ───────────────────────────────────────────────

@router.get("/users")
def list_users(
    db:    Session = Depends(get_db),
    owner: User    = Depends(require_owner),
) -> list[UserOut]:
    return [UserOut.from_orm(u) for u in db.query(User).order_by(User.id).all()]


@router.post("/users", status_code=201)
def create_user(
    req:   CreateUserRequest,
    db:    Session = Depends(get_db),
    owner: User    = Depends(require_owner),
) -> UserOut:
    if req.role not in ("owner", "assistant", "viewer"):
        raise HTTPException(400, "role must be owner, assistant, or viewer")

    if db.query(User).filter(User.username == req.username).first():
        raise HTTPException(400, "Username already exists")

    new_user = User(
        username=req.username,
        hashed_password=hash_password(req.password),
        role=req.role,
        must_change_password=True,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    db.add(AuditLog(user_id=owner.id, action="create_user", detail=f"Created {req.username} ({req.role})"))
    db.commit()

    return UserOut.from_orm(new_user)


@router.patch("/users/{user_id}")
def patch_user(
    user_id: int,
    req:     PatchUserRequest,
    db:      Session = Depends(get_db),
    owner:   User    = Depends(require_owner),
) -> UserOut:
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(404, "User not found")
    if target.id == owner.id:
        raise HTTPException(400, "Cannot modify your own account via this endpoint")

    if req.role is not None:
        if req.role not in ("owner", "assistant", "viewer"):
            raise HTTPException(400, "role must be owner, assistant, or viewer")
        target.role = req.role

    if req.is_active is not None:
        target.is_active = req.is_active

    if req.password is not None:
        target.hashed_password = hash_password(req.password)

    db.commit()
    db.refresh(target)

    db.add(AuditLog(user_id=owner.id, action="patch_user", detail=f"Updated {target.username}"))
    db.commit()

    return UserOut.from_orm(target)


class ChangePasswordRequest(BaseModel):
    new_password: str


@router.post("/change-password")
def change_password(
    req: ChangePasswordRequest,
    db:  Session = Depends(get_db),
    user: User   = Depends(get_current_user),
):
    if len(req.new_password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    user.hashed_password = hash_password(req.new_password)
    user.must_change_password = False
    db.commit()
    return {"ok": True}


@router.delete("/users/{user_id}", status_code=204)
def delete_user(
    user_id: int,
    db:      Session = Depends(get_db),
    owner:   User    = Depends(require_owner),
):
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(404, "User not found")
    if target.id == owner.id:
        raise HTTPException(400, "Cannot delete your own account")

    db.add(AuditLog(user_id=owner.id, action="delete_user", detail=f"Deleted {target.username}"))
    db.delete(target)
    db.commit()
