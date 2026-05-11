import { toast } from "sonner";
import { useCallback } from "react";

export function useToast() {
  const showSuccess = useCallback((message: string) => {
    toast.success(message);
  }, []);

  const showError = useCallback((message: string) => {
    toast.error(message);
  }, []);

  const showWarning = useCallback((message: string) => {
    toast.warning(message);
  }, []);

  return { toast: null, showSuccess, showError, showWarning };
}
