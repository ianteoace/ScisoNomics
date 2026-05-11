# App Registro - Finanzas Personales (Python + Tkinter + SQLite)

Aplicacion de escritorio offline para registrar ingresos y gastos, con filtros, resumen, categorias, gastos fijos, estadisticas y exportaciones.

## App web/desktop (FastAPI + Next.js/Tauri): base SQLite unica

La app web/desktop usa siempre esta base:

`C:\Users\<usuario>\AppData\Local\RegistroFinanzas\data\finanzas.db`

En el backend se centraliza en `modern_app/backend/app/settings.py` (`WEB_DB_PATH`).

### Backups para la app web/desktop

- Copia tus backups en `C:\Users\<usuario>\AppData\Local\RegistroFinanzas\data\` con nombre `finanzas.db`.
- Si esa base no existe y si existe `App registro/data/finanzas.db`, el backend copia automaticamente desde esa base.
- Si no existe ninguna de las dos, el backend responde con error claro: `No se encontro la base de datos.`
- No se crea una base vacia silenciosamente.

### Verificar ruta efectiva en runtime

Con el backend levantado:

`GET /debug/db-path`

Devuelve:
- `db_path` absoluto en uso
- `exists`
- `size_bytes`
- `movimientos_count`
- `categorias_count`
- `gastos_fijos_count`
- `gastos_programados_count`

## Requisitos

- Windows
- Python 3.10+
- Dependencia opcional para estadisticas: matplotlib

## Ejecutar

```powershell
pip install -r requirements.txt
python main.py
```

Si no instalas matplotlib, la app funciona igual. Solo la ventana de Estadisticas mostrara un aviso con el comando de instalacion.

## Donde se guardan los datos

La app guarda siempre sus datos en una carpeta fija del usuario:

```text
C:\Users\<usuario>\AppData\Local\RegistroFinanzas\data\
```

Archivos:
- Base SQLite: `C:\Users\<usuario>\AppData\Local\RegistroFinanzas\data\finanzas.db`
- Configuracion: `C:\Users\<usuario>\AppData\Local\RegistroFinanzas\data\config.json`
- Backups: `C:\Users\<usuario>\AppData\Local\RegistroFinanzas\data\backups\`

Al iniciar, si existe una base/config antigua en `./data/`, se copia automaticamente a AppData solo si el archivo nuevo todavia no existe.

## Estructura

```text
App registro/
  main.py
  requirements.txt
  finance_app/
    app.py
    backup.py
    config.py
    db.py
    paths.py
    exporter.py
    services.py
    ui/
      main_window.py
      movimiento_dialog.py
      gastos_fijos_window.py
      gasto_programado_dialog.py
      planificacion_window.py
      categorias_window.py
      stats_window.py
```

## Funcionalidades destacadas

- Filtros por mes, ano y tipo de movimiento (`Todos`, `Ingresos`, `Gastos`).
- Persistencia de filtros en `config.json`.
- Filtros instantaneos: al cambiar mes, ano, tipo o busqueda, la vista se actualiza automaticamente (tabla, resumen y comparacion mensual).
- Resumen mensual con arrastre real de saldo:
  - `Saldo inicial`: ingresos acumulados historicos menos gastos historicos antes del primer dia del mes.
  - `Ingresos` y `Gastos` del mes seleccionado.
  - `Balance final`: `saldo_inicial + ingresos - gastos`.
- La app no registra el saldo arrastrado como movimiento: se calcula de forma dinamica.
- CRUD de movimientos con validaciones completas.
- Gestion de categorias:
  - Listar, crear, editar.
  - Eliminar solo si no tiene movimientos ni gastos fijos asociados.
  - Evita duplicados por `nombre + tipo`.
- Gestion de gastos fijos con validaciones y aplicacion mensual.
- Planificacion de gastos futuros:
  - Registro de gastos programados con fecha de vencimiento, estado y recurrencia.
  - Filtros por estado y proximidad (`7`, `15`, `30` dias).
  - Marcado como pagado que genera automaticamente un movimiento real de tipo `gasto`.
  - En gastos recurrentes, al marcar como pagado se genera automaticamente el proximo vencimiento segun frecuencia.
  - Alertas visuales para vencidos, vencen hoy y proximos 3 dias.
  - Resumen proyectado: pendiente 30 dias, vencido, pagado del mes y balance proyectado mensual.
- Estadisticas (matplotlib):
  - Grafico de torta interactivo de gastos por categoria (click para seleccionar porcion).
  - Detalle de categoria seleccionada: total, porcentaje, cantidad de movimientos y listado (fecha, descripcion, monto).
  - Exportacion del detalle de la categoria seleccionada a Excel.
  - Ingresos vs gastos del mes.
  - Evolucion anual del balance.
- Exportacion a Excel:
  - Mes seleccionado con libro multihoja:
    - `Resumen`
    - `Movimientos`
    - `Ingresos`
    - `Gastos`
    - `Gastos por categoria`
    - `Planificacion` (solo si hay pendientes en ese mes)
  - Ano seleccionado con libro multihoja:
    - `Resumen anual`
    - `Movimientos del ano`
    - `Resumen por mes`
    - `Ingresos`
    - `Gastos`
    - `Gastos por categoria`
    - `Balance mensual`
    - `Planificacion` (solo si hay pendientes en ese ano)
  - Filtrado actual: exporta exactamente lo visible en la tabla.
  - Estilo aplicado en hojas: encabezados, bordes, filtros, congelado de fila de titulos, anchos automaticos y montos con formato moneda.
  - Mejora visual:
    - Filas de ingresos en verde suave y gastos en rojo suave para lectura rapida.
    - Filas de totales resaltadas en naranja suave con negrita y borde superior mas marcado.
    - Balance positivo/negativo/cero con colores diferenciales.
    - Hojas resumen con bloques visuales tipo dashboard.
    - En `Gastos por categoria` se destaca la categoria principal y barra de datos en montos.
- Backup automatico al iniciar (se conservan los ultimos 10).

## Robustez de datos

- Indices SQLite para mejorar consultas de movimientos y gastos fijos.
- Tabla `gastos_programados` creada con migracion segura (`CREATE TABLE IF NOT EXISTS`) e indices por `fecha_vencimiento`, `estado` y `categoria_id`.
- Restricciones y triggers en `categorias` para reforzar nombre/tipo validos sin borrar datos existentes.
- Manejo de errores con mensajes claros en la UI.

## Planificacion de gastos

La seccion **Planificacion** permite cargar gastos futuros para anticipar compromisos del mes.

### Como cargar un gasto futuro

1. Abrir `Planificacion` desde la ventana principal.
2. Presionar `Agregar`.
3. Completar descripcion, categoria, monto estimado y fecha de vencimiento.
4. Opcional: activar `Recurrente` y elegir frecuencia (`mensual`, `semanal`, `anual`).
5. Guardar.

### Como marcarlo como pagado

1. Seleccionar el gasto programado en la tabla.
2. Presionar `Marcar como pagado`.
3. La app cambia el estado a `pagado` y crea un movimiento real de tipo `gasto` con la fecha actual.
4. Si el gasto es recurrente, la app crea automaticamente el siguiente `gasto_programado` en estado `pendiente`.
5. Si ya estaba pagado, no vuelve a duplicar el movimiento.

### Balance proyectado del mes

Formula utilizada:

`balance_proyectado = ingresos_del_mes - gastos_registrados_del_mes - gastos_programados_pendientes_del_mes`

## Tabla de movimientos

- Columnas: fecha, tipo, categoria, descripcion, monto, dia de la semana y saldo acumulado.
- `Saldo acumulado` representa el saldo cronologico total luego de cada movimiento, considerando historial completo (incluyendo otros meses/anios).
- Orden por defecto: fecha descendente y, para misma fecha, `id` descendente.

## Nota

Todo corre localmente y offline, tanto con `python main.py` como empaquetado en `.exe` con PyInstaller.
