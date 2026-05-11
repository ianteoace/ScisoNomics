from __future__ import annotations


def format_currency(value: float) -> str:
    """Format a numeric value as currency with AR-style separators."""
    formatted = f"{float(value):,.2f}"
    # 1,234,567.89 -> 1.234.567,89
    formatted = formatted.replace(",", "X").replace(".", ",").replace("X", ".")
    return f"$ {formatted}"


def parse_amount(text: str) -> float:
    """Parse amounts written with optional '$', thousands separators and comma decimals."""
    raw = (text or "").strip()
    if not raw:
        raise ValueError("El monto es obligatorio.")

    cleaned = raw.replace("$", "").replace(" ", "")
    if "." in cleaned and "," in cleaned:
        cleaned = cleaned.replace(".", "").replace(",", ".")
    elif "," in cleaned:
        cleaned = cleaned.replace(",", ".")
    return float(cleaned)
