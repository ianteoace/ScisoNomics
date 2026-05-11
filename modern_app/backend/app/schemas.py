from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


MoveType = Literal["ingreso", "gasto", "ahorro", "inversion"]
CategoryType = Literal["ingreso", "gasto", "ahorro", "inversion"]
ProgramState = Literal["pendiente", "pagado", "cancelado"]
ProgramFrequency = Literal["mensual", "semanal", "anual"]


class MovimientoIn(BaseModel):
    fecha: str
    tipo: MoveType
    categoria_id: int
    descripcion: str = ""
    monto: float = Field(gt=0)
    meta_id: int | None = None
    nota: str = ""
    tag_ids: list[int] = Field(default_factory=list)


class CategoriaIn(BaseModel):
    nombre: str
    tipo: CategoryType


class GastoFijoIn(BaseModel):
    categoria_id: int
    descripcion: str
    monto: float = Field(gt=0)
    dia_vencimiento: int = Field(ge=1, le=31)
    activo: int = Field(ge=0, le=1)


class GastoProgramadoIn(BaseModel):
    descripcion: str
    categoria_id: int
    monto_estimado: float = Field(gt=0)
    fecha_vencimiento: str
    estado: ProgramState = "pendiente"
    es_recurrente: int = Field(default=0, ge=0, le=1)
    frecuencia: ProgramFrequency | None = None


class StatsQuery(BaseModel):
    month: int = Field(ge=1, le=12)
    year: int


class PresupuestoIn(BaseModel):
    categoria_id: int
    mes: int = Field(ge=1, le=12)
    anio: int
    monto: float = Field(gt=0)


class MetaAhorroIn(BaseModel):
    nombre: str
    monto_objetivo: float = Field(gt=0)
    monto_inicial: float = Field(default=0, ge=0)
    fecha_objetivo: str | None = None
    descripcion: str = ""
    estado: Literal["activa", "completada", "pausada"] = "activa"


class TagIn(BaseModel):
    nombre: str
    color: str | None = None


class BackupRestoreIn(BaseModel):
    file_name: str


class BackupFrequencyIn(BaseModel):
    frecuencia: Literal["desactivado", "diario", "semanal", "mensual"]


class BackupRestorePathIn(BaseModel):
    source_path: str
