'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './controls';

type ToastTone = 'success' | 'info';
type Toast = { id: number; message: string; tone: ToastTone };
const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => {});
const ToastHostContext = createContext<(element: HTMLElement) => () => void>(() => () => {});
export const useToast = () => useContext(ToastContext);
export const useToastHost = () => useContext(ToastHostContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const sequence = useRef(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [hosts, setHosts] = useState<HTMLElement[]>([]);
  const show = useCallback((message: string, tone: ToastTone = 'success') => {
    const id = ++sequence.current;
    setToasts(current => [...current.filter(item => item.message !== message).slice(-2), { id, message, tone }]);
  }, []);
  const dismiss = useCallback((id: number) => setToasts(current => current.filter(item => item.id !== id)), []);
  const registerHost = useCallback((element: HTMLElement) => {
    setHosts(current => [...current, element]);
    return () => setHosts(current => current.filter(host => host !== element));
  }, []);
  const activeHost = hosts.at(-1);
  const viewport = <div className="toast-stack" role="status" aria-label="Notifications" aria-live="polite" aria-atomic="false">
    {toasts.map(toast => <ToastItem key={toast.id} toast={toast} dismiss={dismiss} />)}
  </div>;
  return <ToastContext.Provider value={show}><ToastHostContext.Provider value={registerHost}>
    {children}
    {activeHost ? createPortal(viewport, activeHost) : viewport}
  </ToastHostContext.Provider></ToastContext.Provider>;
}

function ToastItem({ toast, dismiss }: { toast: Toast; dismiss(id: number): void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (hovered || focused) return;
    const timer = window.setTimeout(() => dismiss(toast.id), 6500);
    return () => window.clearTimeout(timer);
  }, [dismiss, focused, hovered, toast.id]);
  return <div className="toast-item" data-tone={toast.tone} onPointerEnter={event => { if (event.pointerType === 'mouse') setHovered(true); }}
    onPointerLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
    <span className="toast-icon" aria-hidden="true">{toast.tone === 'success' ? '✓' : 'i'}</span>
    <span>{toast.message}</span>
    <Button type="button" className="icon-button" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}>×</Button>
  </div>;
}

function ToastMessage({ message, tone }: { message?: string; tone: ToastTone }) {
  const show = useToast();
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (message && message !== last.current) show(message, tone);
    last.current = message;
  }, [message, show, tone]);
  return null;
}

export function SuccessToast({ message }: { message?: string }) {
  return <ToastMessage message={message} tone="success" />;
}

export function InfoToast({ message }: { message?: string }) {
  return <ToastMessage message={message} tone="info" />;
}
