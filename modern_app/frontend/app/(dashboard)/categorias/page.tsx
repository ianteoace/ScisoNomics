"use client";

import { useEffect, useState } from "react";

import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { ErrorState } from "../../../components/ui/ErrorState";
import { CategoriasView } from "../../../components/views/CategoriasView";
import { useDashboardUi } from "../../../hooks/useDashboardUi";
import { useToast } from "../../../hooks/useToast";
import { api } from "../../../services/api";
import type { Categoria } from "../../../types/domain";

export default function CategoriasPage() {
  const { showError, showSuccess } = useToast();
  const { setSaldoActual } = useDashboardUi();
  const [categories, setCategories] = useState<Categoria[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [confirmState, setConfirmState] = useState<{ open: boolean; action: (() => Promise<void>) | null }>({ open: false, action: null });

  async function load() {
    setLoading(true);
    const c = await api.categorias("todos");
    setCategories(c);
    setSaldoActual(0);
    setLoadError("");
    setLoading(false);
    return c;
  }

  useEffect(() => {
    load().catch((e: any) => {
      setLoadError(e.message || "No se pudieron cargar categorias");
      setLoading(false);
      showError(e.message || "No se pudieron cargar categorias");
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
        <CategoriasView
          categories={categories}
          loading={loading}
          onCreate={(payload) => wrap(() => api.createCategoria(payload).then(() => undefined), "Categoria creada")}
          onUpdate={(id, payload) => wrap(() => api.updateCategoria(id, payload).then(() => undefined), "Categoria actualizada")}
          onDelete={(id) => {
            const target = categories.find((c) => c.id === id);
            setConfirmState({
              open: true,
              action: () =>
                wrap(async () => {
                  await api.deleteCategoria(id);
                  const refreshed = await load();
                  const stillExistsById = refreshed.some((c) => c.id === id);
                  const stillExistsByIdentity = target
                    ? refreshed.some(
                        (c) =>
                          c.nombre.trim().toLowerCase() === target.nombre.trim().toLowerCase() &&
                          c.tipo === target.tipo,
                      )
                    : false;
                  if (stillExistsById || stillExistsByIdentity) {
                    throw new Error("La categoria no se pudo eliminar realmente. Revisa si el backend activo esta desactualizado.");
                  }
                }, "Categoria eliminada"),
            });
            return Promise.resolve();
          }}
        />
      )}
      <ConfirmDialog
        open={confirmState.open}
        title="Eliminar categoria"
        message="Esta acción no se puede deshacer. Se eliminará la categoría seleccionada."
        onCancel={() => setConfirmState({ open: false, action: null })}
        onConfirm={async () => {
          if (confirmState.action) await confirmState.action();
          setConfirmState({ open: false, action: null });
        }}
      />
    </>
  );
}
