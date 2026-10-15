"use client";
import { useEffect, useRef, type InputHTMLAttributes } from "react";
import { formatNumericInput, numericCaret } from "../../lib/numericInput";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "inputMode"> & {
  value: string; onValueChange: (display: string) => void;
};
export function NumericInput({ value, onValueChange, ...props }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const selection = useRef<number | null>(null);
  const display = formatNumericInput(value);
  useEffect(() => {
    if (selection.current !== null && input.current === document.activeElement) input.current?.setSelectionRange(selection.current, selection.current);
    selection.current = null;
  }, [display]);
  function update(raw: string, caret: number, editing: boolean) {
    const next = formatNumericInput(raw, editing);
    selection.current = numericCaret(raw, next, caret);
    onValueChange(next);
  }
  return <input {...props} ref={input} type="text" inputMode="decimal" value={display}
    onChange={event => {
      let raw = event.target.value; const caret = event.target.selectionStart ?? raw.length;
      const native = (event.nativeEvent || {}) as InputEvent;
      // A typed dot is a decimal shortcut. Existing displayed dots are grouping.
      if (native.data === ".") raw = raw.slice(0, caret - 1) + "," + raw.slice(caret);
      update(raw, caret, native.inputType !== undefined);
    }}
    onPaste={event => {
      const pasted = event.clipboardData.getData("text");
      if (!/^[\s$\d.,-]+$/.test(pasted)) return;
      event.preventDefault();
      const node = event.currentTarget;
      const insertion = formatNumericInput(pasted);
      const start = node.selectionStart ?? 0, end = node.selectionEnd ?? node.value.length;
      const raw = node.value.slice(0, start) + insertion + node.value.slice(end);
      update(raw, start + insertion.length, true);
    }} />;
}
