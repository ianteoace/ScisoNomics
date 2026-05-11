from __future__ import annotations

from tkinter import ttk


COLORS = {
    "bg_app": "#0f1414",
    "bg_panel": "#182120",
    "bg_card": "#1f2a29",
    "fg_main": "#e9f7f4",
    "fg_soft": "#9ec9bf",
    "accent_aqua": "#49d3c2",
    "accent_aqua_hover": "#61e3d3",
    "accent_orange": "#ff9f43",
    "accent_orange_hover": "#ffb56a",
    "border": "#2b3c39",
    "entry_bg": "#111918",
    "entry_fg": "#d8efea",
    "entry_selected": "#2d4641",
    "table_even": "#162120",
    "table_odd": "#121b1a",
    "table_selected": "#31514c",
    "income_green": "#34d67a",
    "expense_red": "#ff5d5d",
    "warn_red_bg": "#3b1f22",
    "warn_red_fg": "#ff8080",
    "warn_orange_bg": "#3b2d1d",
    "warn_orange_fg": "#ffc67d",
    "ok_aqua_bg": "#1c3835",
    "ok_aqua_fg": "#8ef0e3",
    "grid_line": "#6a7c75",
    "axis_line": "#51605b",
    "chart_total_bg": "#24403c",
    "pie_pct_text": "#0f1414",
}


def apply_theme(widget) -> None:
    style = ttk.Style(widget)
    style.theme_use("clam")

    style.configure("App.TFrame", background=COLORS["bg_app"])
    style.configure("Panel.TLabelframe", background=COLORS["bg_panel"], borderwidth=1, relief="solid")
    style.configure(
        "Panel.TLabelframe.Label",
        background=COLORS["bg_panel"],
        foreground=COLORS["fg_main"],
        font=("Segoe UI", 10, "bold"),
    )
    style.configure("Card.TFrame", background=COLORS["bg_card"], relief="flat")
    style.configure("Title.TLabel", background=COLORS["bg_card"], foreground=COLORS["fg_soft"], font=("Segoe UI", 10, "bold"))
    style.configure("Value.TLabel", background=COLORS["bg_card"], foreground=COLORS["accent_aqua"], font=("Segoe UI", 16, "bold"))
    style.configure("TLabel", background=COLORS["bg_panel"], foreground=COLORS["fg_main"])
    style.configure("Empty.TLabel", background=COLORS["bg_panel"], foreground=COLORS["fg_soft"], font=("Segoe UI", 11))

    style.configure(
        "TButton",
        background=COLORS["accent_orange"],
        foreground="#1a160f",
        bordercolor=COLORS["accent_orange"],
        focuscolor=COLORS["accent_orange"],
        relief="flat",
        padding=(10, 6),
        font=("Segoe UI", 9, "bold"),
    )
    style.map(
        "TButton",
        background=[("active", COLORS["accent_orange_hover"]), ("disabled", "#55605e")],
        foreground=[("disabled", "#2b3130")],
    )

    style.configure(
        "TEntry",
        fieldbackground=COLORS["entry_bg"],
        background=COLORS["entry_bg"],
        foreground=COLORS["entry_fg"],
        insertcolor=COLORS["fg_main"],
        bordercolor=COLORS["border"],
        lightcolor=COLORS["border"],
        darkcolor=COLORS["border"],
    )
    style.map("TEntry", fieldbackground=[("focus", "#1b2322")], bordercolor=[("focus", COLORS["accent_aqua"])])

    style.configure(
        "TCombobox",
        fieldbackground=COLORS["entry_bg"],
        background=COLORS["entry_bg"],
        foreground=COLORS["entry_fg"],
        arrowcolor=COLORS["accent_orange"],
        bordercolor=COLORS["border"],
        lightcolor=COLORS["border"],
        darkcolor=COLORS["border"],
    )
    style.map("TCombobox", fieldbackground=[("readonly", COLORS["entry_bg"]), ("focus", "#1b2322")], selectbackground=[("readonly", COLORS["entry_selected"])])

    style.configure(
        "Treeview",
        rowheight=30,
        font=("Segoe UI", 10),
        background=COLORS["table_odd"],
        fieldbackground=COLORS["table_odd"],
        foreground=COLORS["fg_main"],
        bordercolor=COLORS["border"],
    )
    style.map("Treeview", background=[("selected", COLORS["table_selected"])], foreground=[("selected", COLORS["fg_main"])])
    style.configure(
        "Treeview.Heading",
        font=("Segoe UI", 10, "bold"),
        background=COLORS["bg_card"],
        foreground=COLORS["accent_orange"],
        relief="flat",
    )
    style.map("Treeview.Heading", background=[("active", "#2a3432")], foreground=[("active", COLORS["accent_orange_hover"])])
