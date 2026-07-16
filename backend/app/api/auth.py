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
    require_superadmin,
    verify_password,
)
from app.kb.database import get_db
from app.kb.models import AuditLog, Tenant, User, Workspace

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
    tenant_id: int | None = None
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
    db:   Session = Depends(get_db),
    user: User    = Depends(require_owner),
) -> list[UserOut]:
    q = db.query(User)
    if user.role != "superadmin":
        q = q.filter(User.tenant_id == user.tenant_id)
    return [UserOut.from_orm(u) for u in q.order_by(User.id).all()]


@router.post("/users", status_code=201)
def create_user(
    req:  CreateUserRequest,
    db:   Session = Depends(get_db),
    user: User    = Depends(require_owner),
) -> UserOut:
    if user.role == "superadmin":
        raise HTTPException(400, "Use POST /api/auth/tenants to create new owners")

    if req.role not in ("assistant", "viewer"):
        raise HTTPException(400, "role must be assistant or viewer")

    if db.query(User).filter(User.username == req.username).first():
        raise HTTPException(400, "Username already exists")

    new_user = User(
        username=req.username,
        hashed_password=hash_password(req.password),
        role=req.role,
        tenant_id=user.tenant_id,
        must_change_password=True,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    db.add(AuditLog(user_id=user.id, action="create_user", detail=f"Created {req.username} ({req.role})"))
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


# ── Tenant management (superadmin only) ───────────────────────────────────────

class CreateTenantRequest(BaseModel):
    tenant_name:    str
    owner_username: str
    owner_password: str


class TenantOut(BaseModel):
    id:             int
    name:           str
    owner_username: str
    created_at:     datetime


@router.get("/tenants")
def list_tenants(
    db: Session = Depends(get_db),
    _:  User    = Depends(require_superadmin),
) -> list[TenantOut]:
    tenants = db.query(Tenant).order_by(Tenant.id).all()
    result = []
    for t in tenants:
        owner = db.query(User).filter(User.tenant_id == t.id, User.role == "owner").first()
        result.append(TenantOut(
            id=t.id,
            name=t.name,
            owner_username=owner.username if owner else "—",
            created_at=t.created_at,
        ))
    return result


@router.post("/tenants", status_code=201)
def create_tenant(
    req: CreateTenantRequest,
    db:  Session = Depends(get_db),
    sa:  User    = Depends(require_superadmin),
) -> TenantOut:
    if db.query(User).filter(User.username == req.owner_username).first():
        raise HTTPException(400, "Username already exists")

    tenant = Tenant(name=req.tenant_name)
    db.add(tenant)
    db.flush()

    owner = User(
        username=req.owner_username,
        hashed_password=hash_password(req.owner_password),
        role="owner",
        tenant_id=tenant.id,
        must_change_password=True,
    )
    db.add(owner)

    # Create default workspace for this tenant
    max_port = db.query(Workspace).order_by(Workspace.bridge_port.desc()).first()
    next_port = (max_port.bridge_port + 1) if max_port else 3001
    db.add(Workspace(name="Main Number", bridge_port=next_port, tenant_id=tenant.id))

    db.commit()
    db.refresh(tenant)

    db.add(AuditLog(user_id=sa.id, action="create_tenant", detail=f"Created tenant '{req.tenant_name}' owner={req.owner_username}"))
    db.commit()

    return TenantOut(id=tenant.id, name=tenant.name, owner_username=req.owner_username, created_at=tenant.created_at)


@router.delete("/tenants/{tenant_id}", status_code=204)
def delete_tenant(
    tenant_id: int,
    db: Session = Depends(get_db),
    sa: User    = Depends(require_superadmin),
):
    if tenant_id == 1:
        raise HTTPException(400, "Cannot delete the default tenant")
    tenant = db.query(Tenant).filter(Tenant.id == tenant_id).first()
    if not tenant:
        raise HTTPException(404, "Tenant not found")
    db.add(AuditLog(user_id=sa.id, action="delete_tenant", detail=f"Deleted tenant '{tenant.name}'"))
    db.delete(tenant)
    db.commit()


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
