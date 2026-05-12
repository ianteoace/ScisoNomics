"use client";

import { useEffect, useState } from "react";

import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { ErrorState } from "../../../components/ui/ErrorState";
import { PlanificacionView } from "../../../components/views/PlanificacionView";
import { useDashboardUi } from "../../../hooks/useDashboardUi";
import { useToast } from "../../../hooks/useToast";
import { api } from "../../../services/api";
import type { Categoria, GastoProgramado } from "../../../types/domain";

export default function PlanificacionPage() {
  const { showError, showSuccess } = useToast();
  const { setSaldoActual } = useDashboardUi();
  const [rows, setRows] = useState<GastoProgramado[]>([]);
  const [categories, setCategories] = useState<Categoria[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [confirmState, setConfirmState] = useState<{ open: boolean; action: (() => Promise<void>) | null }>({ open: false, action: null });

  async function load() {
    setLoading(true);
    try {
      const [gp, c] = await Promise.all([api.gastosProgramados("todos"), api.categorias("todos")]);
      setRows(gp);
      setCategories(c);
      setSaldoActual(0);
      setLoadError("");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch((e: any) => {
      setLoadError(e.message || "No se pudieron cargar los datos.");
      showError(e.message || "No se pudo cargar planificacion");
    });
  }, []);

  async function wrap(action: () => Promise<void>, msg: string) {
    try {
      await action();
      showSuccess(msg);
      await load();
    } catch (e: any) {
      showError(e.message || "Operacion fallida");
    }
  }

  return (
    <>
      {loadError ? <ErrorState title="No se pudieron cargar los datos." description={loadError} onRetry={load} /> : null}
      {!loading && loadError ? null : (
        <PlanificacionView
          rows={rows}
          categories={categories}
          loading={loading}
          onCreate={(payload) => wrap(() => api.createGastoProgramado(payload).then(() => undefined), "Gasto programado creado")}
          onUpdate={(id, payload) => wrap(() => api.updateGastoProgramado(id, payload).then(() => undefined), "Gasto programado actualizado")}
          onDelete={(id) => {
            setConfirmState({ open: true, action: () => wrap(() => api.deleteGastoProgramado(id).then(() => undefined), "Gasto programado eliminado") });
            return Promise.resolve();
          }}
          onMarkPaid={(id) => wrap(() => api.marcarPagado(id).then(() => undefined), "Gasto marcado como pagado")}
        />
      )}

      <ConfirmDialog
        open={confirmState.open}
        title="Eliminar gasto programado"
        message="Esta acción no se puede deshacer. Se eliminará este presupuesto/gasto programado."
        onCancel={() => setConfirmState({ open: false, action: null })}
        onConfirm={async () => {
          if (confirmState.action) await confirmState.action();
          setConfirmState({ open: false, action: null });
        }}
      />
    </>
  );
}
