"""SQLAlchemy 2.0 ORM models."""

from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Boolean, Column, ForeignKey, Integer, String, Table, Text,
    DateTime, Float,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


# Association table
message_entities = Table(
    "message_entities",
    Base.metadata,
    Column("message_id", ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True),
    Column("entity_id",  ForeignKey("entities.id",  ondelete="CASCADE"), primary_key=True),
)


class User(Base):
    __tablename__ = "users"

    id:              Mapped[int]  = mapped_column(primary_key=True)
    username:        Mapped[str]  = mapped_column(String(100), unique=True, nullable=False)
    hashed_password: Mapped[str]  = mapped_column(String(256), nullable=False)
    role:            Mapped[str]  = mapped_column(String(20), default="assistant")  # owner / assistant / viewer
    is_active:       Mapped[bool] = mapped_column(Boolean, default=True)
    created_at:      Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    audit_logs: Mapped[list["AuditLog"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id:        Mapped[int]           = mapped_column(primary_key=True)
    user_id:   Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    action:    Mapped[str]           = mapped_column(String(100))
    detail:    Mapped[Optional[str]] = mapped_column(Text)
    timestamp: Mapped[datetime]      = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    user: Mapped[Optional["User"]] = relationship(back_populates="audit_logs")


class Workspace(Base):
    __tablename__ = "workspaces"

    id:          Mapped[int]           = mapped_column(primary_key=True)
    name:        Mapped[str]           = mapped_column(String(255), default="My Workspace")
    bridge_port: Mapped[int]           = mapped_column(Integer, default=3001)
    phone_label: Mapped[Optional[str]] = mapped_column(String(50))   # e.g. "+212 6XX XXX XXX"
    created_at:  Mapped[datetime]      = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    chats:    Mapped[list["Chat"]]    = relationship(back_populates="workspace")
    contacts: Mapped[list["Contact"]] = relationship(back_populates="workspace", cascade="all, delete-orphan")


class Chat(Base):
    __tablename__ = "chats"

    id:                Mapped[int]            = mapped_column(primary_key=True)
    workspace_id:      Mapped[Optional[int]]  = mapped_column(ForeignKey("workspaces.id", ondelete="SET NULL"))
    filename:          Mapped[str]            = mapped_column(String(255))
    original_filename: Mapped[Optional[str]]  = mapped_column(String(255))
    category:          Mapped[str]            = mapped_column(String(50), default="other")
    upload_time:       Mapped[datetime]       = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    status:            Mapped[str]            = mapped_column(String(50), default="pending")
    error_message:     Mapped[Optional[str]]  = mapped_column(Text)
    participant_names: Mapped[Optional[list]] = mapped_column(ARRAY(String))
    message_count:     Mapped[int]            = mapped_column(default=0)
    date_from:         Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    date_to:           Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    workspace:            Mapped[Optional["Workspace"]]        = relationship(back_populates="chats")
    messages:             Mapped[list["Message"]]              = relationship(back_populates="chat", cascade="all, delete-orphan")
    threads:              Mapped[list["Thread"]]               = relationship(back_populates="chat", cascade="all, delete-orphan")
    contact_appearances:  Mapped[list["ContactAppearance"]]    = relationship(back_populates="chat", cascade="all, delete-orphan")


class Thread(Base):
    __tablename__ = "threads"

    id:            Mapped[int]             = mapped_column(primary_key=True)
    chat_id:       Mapped[int]             = mapped_column(ForeignKey("chats.id", ondelete="CASCADE"))
    thread_index:  Mapped[Optional[int]]
    start_time:    Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    end_time:      Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    message_count: Mapped[int]             = mapped_column(default=0)
    summary:       Mapped[Optional[str]]   = mapped_column(Text)
    intent_tags:   Mapped[Optional[list]]  = mapped_column(ARRAY(String))
    key_entities:  Mapped[Optional[dict]]  = mapped_column(JSONB)
    embedding:     Mapped[Optional[list]]  = mapped_column(ARRAY(Float))

    chat:     Mapped["Chat"]          = relationship(back_populates="threads")
    messages: Mapped[list["Message"]] = relationship(back_populates="thread")


class Message(Base):
    __tablename__ = "messages"

    id:                 Mapped[int]            = mapped_column(primary_key=True)
    chat_id:            Mapped[int]            = mapped_column(ForeignKey("chats.id", ondelete="CASCADE"))
    thread_id:          Mapped[Optional[int]]  = mapped_column(ForeignKey("threads.id", ondelete="SET NULL"))
    burst_id:           Mapped[Optional[int]]
    position_in_chat:   Mapped[Optional[int]]
    timestamp:          Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    sender:             Mapped[Optional[str]]  = mapped_column(String(255))
    body:               Mapped[Optional[str]]  = mapped_column(Text)
    message_type:       Mapped[str]            = mapped_column(String(50), default="text")
    media_filename:     Mapped[Optional[str]]  = mapped_column(String(255))
    media_path:         Mapped[Optional[str]]  = mapped_column(String(500))
    transcription:      Mapped[Optional[str]]  = mapped_column(Text)
    vision_description: Mapped[Optional[str]]  = mapped_column(Text)
    language:           Mapped[Optional[str]]  = mapped_column(String(10))
    embedding:          Mapped[Optional[list]] = mapped_column(ARRAY(Float))

    chat:     Mapped["Chat"]             = relationship(back_populates="messages")
    thread:   Mapped[Optional["Thread"]] = relationship(back_populates="messages")
    entities: Mapped[list["Entity"]]     = relationship(secondary=message_entities, back_populates="messages")


class Entity(Base):
    __tablename__ = "entities"

    id:          Mapped[int]           = mapped_column(primary_key=True)
    chat_id:     Mapped[int]           = mapped_column(ForeignKey("chats.id", ondelete="CASCADE"))
    name:        Mapped[str]           = mapped_column(String(255))
    entity_type: Mapped[Optional[str]] = mapped_column(String(50))

    messages: Mapped[list["Message"]] = relationship(secondary=message_entities, back_populates="entities")


class Contact(Base):
    __tablename__ = "contacts"

    id:            Mapped[int]             = mapped_column(primary_key=True)
    workspace_id:  Mapped[int]             = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"))
    display_name:  Mapped[str]             = mapped_column(String(255))
    message_count: Mapped[int]             = mapped_column(default=0)
    chat_count:    Mapped[int]             = mapped_column(default=0)
    last_seen:     Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    notes:         Mapped[Optional[str]]   = mapped_column(Text, nullable=True)
    tags:          Mapped[Optional[list]]  = mapped_column(ARRAY(String), nullable=True)

    workspace:   Mapped["Workspace"]              = relationship(back_populates="contacts")
    appearances: Mapped[list["ContactAppearance"]] = relationship(back_populates="contact", cascade="all, delete-orphan")


class ContactAppearance(Base):
    __tablename__ = "contact_appearances"

    contact_id:    Mapped[int]           = mapped_column(ForeignKey("contacts.id", ondelete="CASCADE"), primary_key=True)
    chat_id:       Mapped[int]           = mapped_column(ForeignKey("chats.id",     ondelete="CASCADE"), primary_key=True)
    sender_name:   Mapped[Optional[str]] = mapped_column(String(255))
    message_count: Mapped[int]           = mapped_column(default=0)

    contact: Mapped["Contact"] = relationship(back_populates="appearances")
    chat:    Mapped["Chat"]    = relationship(back_populates="contact_appearances")
