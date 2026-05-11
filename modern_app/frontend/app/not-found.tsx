export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-3xl items-center justify-center p-6">
      <div className="card w-full max-w-xl p-8 text-center">
        <p className="section-title">Pagina no encontrada</p>
        <p className="section-subtitle mt-2">La ruta que intentaste abrir no existe o fue movida.</p>
      </div>
    </main>
  );
}