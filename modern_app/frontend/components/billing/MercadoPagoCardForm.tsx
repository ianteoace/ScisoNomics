"use client";

import { useEffect, useRef, useState } from "react";

const PUBLIC_KEY = process.env.NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY || "";
const SDK_URL = "https://sdk.mercadopago.com/js/v2";

type CardForm = {
  getCardFormData: () => { token?: string };
  unmount?: () => void;
};
type MercadoPagoSDK = new (publicKey: string) => {
  cardForm: (settings: object) => CardForm;
};

function loadSdk(): Promise<MercadoPagoSDK> {
  const current = (window as Window & { MercadoPago?: MercadoPagoSDK }).MercadoPago;
  if (current) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const script = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`) || document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => {
      const sdk = (window as Window & { MercadoPago?: MercadoPagoSDK }).MercadoPago;
      if (sdk) resolve(sdk);
      else reject(new Error("No se pudo cargar el formulario seguro de Mercado Pago."));
    };
    script.onerror = () => reject(new Error("No se pudo cargar el formulario seguro de Mercado Pago."));
    if (!script.isConnected) document.head.appendChild(script);
  });
}

export function MercadoPagoCardForm({ amount, onToken, onError }: {
  amount: string;
  onToken: (token: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const formRef = useRef<CardForm | null>(null);
  const submittingRef = useRef(false);
  const onTokenRef = useRef(onToken);
  const onErrorRef = useRef(onError);
  onTokenRef.current = onToken;
  onErrorRef.current = onError;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!PUBLIC_KEY || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      onErrorRef.current("El formulario de tarjeta todavía no está disponible.");
      return;
    }
    void loadSdk().then((MercadoPago) => {
      if (cancelled) return;
      const mp = new MercadoPago(PUBLIC_KEY);
      formRef.current = mp.cardForm({
        amount,
        iframe: true,
        form: {
          id: "mp-card-form",
          cardNumber: { id: "mp-card-number", placeholder: "Número de tarjeta" },
          expirationDate: { id: "mp-card-expiration", placeholder: "MM/AA" },
          securityCode: { id: "mp-card-security", placeholder: "Código de seguridad" },
          cardholderName: { id: "mp-cardholder-name", placeholder: "Titular" },
          issuer: { id: "mp-card-issuer", placeholder: "Banco emisor" },
          installments: { id: "mp-card-installments", placeholder: "Cuotas" },
          identificationType: { id: "mp-card-id-type", placeholder: "Tipo de documento" },
          identificationNumber: { id: "mp-card-id-number", placeholder: "Documento" },
        },
        callbacks: {
          onFormMounted: (error: unknown) => {
            if (cancelled) return;
            if (error) onErrorRef.current("No se pudo mostrar el formulario seguro de tarjeta.");
          },
          onReady: () => { if (!cancelled) setReady(true); },
          onError: () => { if (!cancelled) onErrorRef.current("Mercado Pago no pudo validar los datos de la tarjeta."); },
          onSubmit: (event: Event) => {
            event.preventDefault();
            if (cancelled || submittingRef.current) return;
            const token = formRef.current?.getCardFormData().token;
            if (!token) {
              onErrorRef.current("No se pudo validar la tarjeta. Revisá los datos e intentá otra vez.");
              return;
            }
            submittingRef.current = true;
            void onTokenRef.current(token).catch(() => {
              onErrorRef.current("No se pudo asociar la tarjeta. Volvé a intentarlo.");
            }).finally(() => { submittingRef.current = false; });
          },
        },
      });
    }).catch(() => {
      if (!cancelled) onErrorRef.current("No se pudo cargar el formulario seguro de Mercado Pago.");
    });
    return () => {
      cancelled = true;
      formRef.current?.unmount?.();
      formRef.current = null;
    };
  }, [amount]);

  return (
    <form id="mp-card-form" className="mt-4 space-y-3" autoComplete="off">
      <p className="text-sm text-slate-300">Ingresá la tarjeta en los campos seguros de Mercado Pago. ScisoNomics no guarda sus datos.</p>
      <div id="mp-card-number" className="min-h-10 rounded-lg bg-white p-2" aria-label="Número de tarjeta" />
      <div className="grid grid-cols-2 gap-3">
        <div id="mp-card-expiration" className="min-h-10 rounded-lg bg-white p-2" aria-label="Vencimiento" />
        <div id="mp-card-security" className="min-h-10 rounded-lg bg-white p-2" aria-label="Código de seguridad" />
      </div>
      <input id="mp-cardholder-name" className="input w-full" placeholder="Titular de la tarjeta" aria-label="Titular de la tarjeta" />
      <select id="mp-card-issuer" className="input w-full" aria-label="Banco emisor" />
      <select id="mp-card-installments" className="input w-full" aria-label="Cuotas" />
      <select id="mp-card-id-type" className="input w-full" aria-label="Tipo de documento" />
      <input id="mp-card-id-number" className="input w-full" placeholder="Documento" aria-label="Documento" />
      <button className="btn" type="submit" disabled={!ready || submittingRef.current}>Confirmar tarjeta</button>
    </form>
  );
}
