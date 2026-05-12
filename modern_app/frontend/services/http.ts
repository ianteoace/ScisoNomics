export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

function toConnectionError(error: unknown) {
  console.error("HTTP request could not reach local API", error);
  return new Error("No se pudo conectar con ScisoNomics. Intentá nuevamente.");
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    console.error("HTTP request failed", { url: res.url, status: res.status, response: text });
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error("HTTP error body (raw):", text);
    }

    if (res.status === 404) throw new Error("No se pudo encontrar la información solicitada.");
    if (res.status === 422) {
      const detail = Array.isArray(parsed?.detail) ? parsed.detail[0] : parsed?.detail;
      const msg = typeof detail?.msg === "string" ? detail.msg : "";
      const detailText = typeof detail === "string" ? detail : "";
      const combined = `${msg} ${detailText}`.toLowerCase();
      if (combined.includes("greater than 0") || combined.includes("mayor a 0")) throw new Error("Ingresá un monto mayor a 0.");
      throw new Error("Revisá los datos ingresados.");
    }
    if (res.status >= 500) throw new Error("Ocurrió un error inesperado.");

    const backendMessage = parsed?.detail || parsed?.message || text || `HTTP ${res.status}`;
    if (typeof backendMessage === "string" && backendMessage.toLowerCase().includes("foreign key constraint failed")) {
      throw new Error("La categoría seleccionada no existe o no es válida. Volvé a seleccionar una categoría.");
    }
    if (typeof backendMessage === "string" && backendMessage.trim()) throw new Error(backendMessage.trim());
    throw new Error("No se pudo completar la operación.");
  }
  return (await res.json()) as T;
}

export async function getJSON<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  } catch (error) {
    throw toConnectionError(error);
  }
  return parse<T>(res);
}

export async function sendJSON<T>(path: string, method: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw toConnectionError(error);
  }
  return parse<T>(res);
}
