from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


MoveType = Literal["ingreso", "gasto", "ahorro", "inversion"]
CategoryType = Literal["ingreso", "gasto", "ahorro", "inversion"]
ProgramState = Literal["pendiente", "pagado", "cancelado"]
ProgramFrequency = Literal["mensual", "semanal", "anual"]


class StrictLocalModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class MovimientoIn(StrictLocalModel):
    fecha: str = Field(min_length=8, max_length=32)
    tipo: MoveType
    categoria_id: int
    descripcion: str = Field(default="", max_length=500)
    monto: float = Field(gt=0)
    meta_id: int | None = None
    nota: str = Field(default="", max_length=4000)
    tag_ids: list[int] = Field(default_factory=list, max_length=100)


class CategoriaIn(StrictLocalModel):
    nombre: str = Field(min_length=1, max_length=120)
    tipo: CategoryType


class GastoFijoIn(StrictLocalModel):
    categoria_id: int
    descripcion: str = Field(min_length=1, max_length=500)
    monto: float = Field(gt=0)
    dia_vencimiento: int = Field(ge=1, le=31)
    activo: int = Field(ge=0, le=1)


class GastoProgramadoIn(StrictLocalModel):
    descripcion: str = Field(min_length=1, max_length=500)
    categoria_id: int
    monto_estimado: float = Field(gt=0)
    fecha_vencimiento: str = Field(min_length=8, max_length=32)
    estado: ProgramState = "pendiente"
    es_recurrente: int = Field(default=0, ge=0, le=1)
    frecuencia: ProgramFrequency | None = None


class StatsQuery(BaseModel):
    month: int = Field(ge=1, le=12)
    year: int


class PresupuestoIn(StrictLocalModel):
    categoria_id: int
    mes: int = Field(ge=1, le=12)
    anio: int
    monto: float = Field(gt=0)


class MetaAhorroIn(StrictLocalModel):
    nombre: str = Field(min_length=1, max_length=160)
    monto_objetivo: float = Field(gt=0)
    monto_inicial: float = Field(default=0, ge=0)
    fecha_objetivo: str | None = Field(default=None, max_length=32)
    descripcion: str = Field(default="", max_length=2000)
    estado: Literal["activa", "completada", "pausada"] = "activa"


class TagIn(StrictLocalModel):
    nombre: str = Field(min_length=1, max_length=80)
    color: str | None = Field(default=None, max_length=32)


class BackupRestoreIn(StrictLocalModel):
    file_name: str = Field(min_length=1, max_length=255)


class BackupFrequencyIn(BaseModel):
    frecuencia: Literal["desactivado", "diario", "semanal", "mensual"]


class BackupRestorePathIn(BaseModel):
    source_path: str


class BackupEncryptionIn(StrictLocalModel):
    passphrase: str = Field(min_length=12, max_length=256)


class PremiumFeaturesIn(BaseModel):
    budgets: bool = False
    saving_goals: bool = False
    fixed_expenses: bool = False
    planning: bool = False


class BillingEntitlementsCacheIn(BaseModel):
    refresh: bool = True
