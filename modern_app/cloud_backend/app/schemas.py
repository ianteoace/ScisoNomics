from __future__ import annotations

from pydantic import BaseModel


FeatureKey = str


class RegisterRequest(BaseModel):
    email: str
    password: str
    display_name: str | None = None


class LoginRequest(BaseModel):
    email: str
    password: str


class UserOut(BaseModel):
    id: str
    email: str
    display_name: str | None = None
    created_at: str
    updated_at: str


class AuthResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    token: str | None = None
    user: UserOut


class RefreshRequest(BaseModel):
    refresh_token: str


class LogoutRequest(BaseModel):
    refresh_token: str


class BillingFeaturesOut(BaseModel):
    budgets: bool
    saving_goals: bool
    fixed_expenses: bool
    planning: bool


class BillingEntitlementsOut(BaseModel):
    user_id: str
    plan: str
    status: str
    features: BillingFeaturesOut
    expires_at: str | None = None
    issued_at: str
    valid_until: str
    entitlement_token: str


class AdminBillingEntitlementsUpdateIn(BaseModel):
    email: str
    plan: str
    subscription_status: str
    subscription_expires_at: str | None = None
