"use client";

import { useEffect, useState } from "react";

import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { GastosFijosView } from "../../../components/views/GastosFijosView";
import { useDashboardUi } from "../../../hooks/useDashboardUi";
import { useToast } from "../../../hooks/useToast";
import { api } from "../../../services/api";
import type { Categoria, GastoFijo } from "../../../types/domain";

export default function GastosFijosPage() {
  const { showError, showSuccess } = useToast();
  const { setSaldoActual } = useDashboardUi();
  const [rows, setRows] = useState<GastoFijo[]>([]);
  const [categories, setCategories] = useState<Categoria[]>([]);
  const [confirmState, setConfirmState] = useState<{ open: boolean; action: (() => Promise<void>) | null }>({ open: false, action: null });

  async function load() {
    const [gf, c] = await Promise.all([api.gastosFijos(), api.categorias("todos")]);
    setRows(gf);
    setCategories(c);
    setSaldoActual(0);
  }

  useEffect(() => {
    load().catch((e: any) => showError(e.message || "No se pudieron cargar gastos fijos"));
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
      <GastosFijosView
        rows={rows}
        categories={categories}
        onCreate={(payload) => wrap(() => api.createGastoFijo(payload).then(() => undefined), "Gasto fijo creado")}
        onUpdate={(id, payload) => wrap(() => api.updateGastoFijo(id, payload).then(() => undefined), "Gasto fijo actualizado")}
        onDelete={(id) => {
          setConfirmState({ open: true, action: () => wrap(() => api.deleteGastoFijo(id).then(() => undefined), "Gasto fijo eliminado") });
          return Promise.resolve();
        }}
      />
      <ConfirmDialog
        open={confirmState.open}
        title="Eliminar gasto fijo"
        message="Esta acción no se puede deshacer. Se eliminará el gasto fijo seleccionado."
        onCancel={() => setConfirmState({ open: false, action: null })}
        onConfirm={async () => {
          if (confirmState.action) await confirmState.action();
          setConfirmState({ open: false, action: null });
        }}
      />
    </>
  );
}
