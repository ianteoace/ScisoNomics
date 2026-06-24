export type MoveType = "ingreso" | "gasto" | "ahorro" | "inversion";
export type BackupFrequency = "desactivado" | "diario" | "semanal" | "mensual";

export type Movimiento = {
  id: number;
  fecha: string;
  tipo: MoveType;
  categoria: string;
  descripcion: string;
  monto: number;
  saldo_acumulado: number;
  meta_id?: number | null;
  meta_nombre?: string | null;
  nota?: string;
  tags?: Tag[];
};

export type Categoria = {
  id: number;
  nombre: string;
  tipo: MoveType;
};

export type GastoFijo = {
  id: number;
  categoria_id: number;
  categoria: string;
  descripcion: string;
  monto: number;
  dia_vencimiento: number;
  activo: number;
};

export type GastoProgramado = {
  id: number;
  descripcion: string;
  categoria_id: number;
  categoria: string;
  monto_estimado: number;
  fecha_vencimiento: string;
  estado: "pendiente" | "pagado" | "cancelado";
  es_recurrente: number;
  frecuencia: "mensual" | "semanal" | "anual" | null;
};

export type MovimientosResponse = {
  rows: Movimiento[];
  summary: {
    saldo_inicial: number;
    ingreso: number;
    gasto: number;
    ahorro?: number;
    balance_final: number;
    disponible_luego_ahorro?: number;
  };
  visible_count: number;
  visible_total: number;
};

export type StatsResponse = {
  summary: {
    saldo_inicial: number;
    ingreso: number;
    gasto: number;
    ahorro?: number;
    balance_final: number;
    balance?: number;
    disponible_luego_ahorro?: number;
  };
  month_totals: {
    ingreso: number;
    gasto: number;
    ahorro?: number;
    inversion?: number;
    balance: number;
    disponible_luego_ahorro?: number;
  };
  expenses_by_category: Array<{ categoria_id?: number; categoria: string; total: number; movimientos?: number }>;
  trend: Array<{ mes: number; ingresos: number; gastos: number }>;
  planificacion: {
    total_pendiente_30_dias: number;
    total_vencido: number;
    total_pagado_mes: number;
    balance_proyectado_mes: number;
  };
};

export type AnnualStatsResponse = {
  year: number;
  totals: {
    ingresos: number;
    gastos: number;
    ahorros: number;
    inversiones: number;
    balance: number;
    movimientos: number;
  };
  promedios_mensuales: {
    ingresos: number;
    gastos: number;
    balance: number;
  };
  mes_mayor_gasto: { mes: number; gastos: number } | null;
  mes_mayor_ingreso: { mes: number; ingresos: number } | null;
  categoria_mayor_gasto: { categoria: string; total: number; movimientos?: number } | null;
  monthly: Array<{ mes: number; ingresos: number; gastos: number; ahorros: number; inversiones: number; balance: number }>;
  gastos_por_categoria: Array<{ categoria: string; total: number; movimientos?: number }>;
};

export type Presupuesto = {
  id: number;
  categoria_id: number;
  categoria: string;
  mes: number;
  anio: number;
  monto_presupuestado: number;
  monto_gastado: number;
  porcentaje_usado: number;
  monto_disponible: number;
  excedido: boolean;
};

export type SettingsInfo = {
  version: string;
  backend_ok: boolean;
  db_path: string;
  db_exists?: boolean;
  db_initialized?: boolean;
  database_ready?: boolean;
  db_status?: "ready" | "degraded" | "repair_required" | "migration_failed" | "critical";
  db_code?: string;
  db_message?: string;
  repairable?: boolean;
  sync_allowed?: boolean;
  db_size?: number;
  data_dir: string;
  backups_dir?: string;
  logs_dir: string;
  logs_exists: boolean;
  app_data_dir?: string;
  migrations_status?: string;
  counts?: {
    movimientos: number;
    categorias: number;
    presupuestos: number;
    metas: number;
  };
};

export type MetaAhorro = {
  id: number;
  nombre: string;
  monto_objetivo: number;
  monto_inicial: number;
  fecha_objetivo?: string | null;
  descripcion?: string;
  estado: "activa" | "completada" | "pausada";
  monto_ahorrado: number;
  faltante: number;
  porcentaje_completado: number;
};

export type Tag = {
  id: number;
  nombre: string;
  color?: string | null;
};

export type BackupItem = {
  name: string;
  path: string;
  size: number;
  modified_at: string;
};

export type BackupState = {
  folder: string;
  count: number;
  last_backup?: BackupItem | null;
  items: BackupItem[];
  frequency: BackupFrequency;
};
