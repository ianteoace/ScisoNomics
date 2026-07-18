from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


FeatureKey = str


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class RegisterRequest(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=12, max_length=256)
    display_name: str | None = Field(default=None, max_length=120)


class LoginRequest(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=256)


class UserOut(BaseModel):
    id: str
    email: str
    display_name: str | None = None
    created_at: str
    updated_at: str


class EmailVerificationRequiredOut(BaseModel):
    status: str = "verification_required"
    code: str = "email_verification_required"
    email: str
    verification_token: str
    verification_expires_in: int
    resend_available_in: int


class AuthResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    token: str | None = None
    user: UserOut


class VerifyEmailRequest(StrictModel):
    verification_token: str = Field(min_length=32, max_length=4096)
    code: str = Field(min_length=6, max_length=32)


class ResendEmailVerificationRequest(StrictModel):
    verification_token: str = Field(min_length=32, max_length=4096)


class RefreshRequest(StrictModel):
    refresh_token: str = Field(min_length=32, max_length=512)


class LogoutRequest(StrictModel):
    refresh_token: str = Field(min_length=32, max_length=512)


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


class AdminBillingEntitlementsUpdateIn(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    plan: str = Field(min_length=1, max_length=32)
    subscription_status: str = Field(min_length=1, max_length=32)
    subscription_expires_at: str | None = Field(default=None, max_length=64)
