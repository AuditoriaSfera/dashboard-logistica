"use client";

import { useEffect, useRef, useState } from "react";

type PortalInstance = { ready: Promise<void>; dispose: () => void };
declare global {
  interface Window {
    SferaBacklogMount?: (root: ShadowRoot, xlsx: unknown, storagePrefix: string) => PortalInstance;
  }
}

let scriptReady: Promise<void> | null = null;
function loadPortalScript() {
  if (window.SferaBacklogMount) return Promise.resolve();
  if (!scriptReady) scriptReady = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/backlog/portal.js";
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); scriptReady = null; reject(new Error("Não foi possível carregar o portal de pedidos.")); };
    document.head.appendChild(script);
  });
  return scriptReady;
}

export function BacklogPortal({ userId }: { userId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let instance: PortalInstance | undefined;
    const root = host.current!.shadowRoot || host.current!.attachShadow({ mode: "open" });
    const controller = new AbortController();
    const load = async () => {
      try {
        const [markup, styles, xlsx] = await Promise.all([
          fetch("/backlog/interface.html", { signal: controller.signal }).then((response) => { if (!response.ok) throw new Error("Falha ao carregar a interface."); return response.text(); }),
          fetch("/backlog/style.css", { signal: controller.signal }).then((response) => { if (!response.ok) throw new Error("Falha ao carregar o visual."); return response.text(); }),
          import("xlsx"), loadPortalScript(),
        ]);
        if (cancelled) return;
        root.innerHTML = "";
        const style = document.createElement("style"); style.textContent = styles;
        root.appendChild(style);
        const template = document.createElement("template"); template.innerHTML = markup;
        root.appendChild(template.content.cloneNode(true));
        if (!window.SferaBacklogMount) throw new Error("Portal indisponível. Recarregue a página.");
        instance = window.SferaBacklogMount(root, xlsx, `sfera-portal-${userId}-`);
        await instance.ready;
        if (!cancelled) setLoading(false);
      } catch (caught) {
        if (!cancelled) { setError(caught instanceof Error ? caught.message : "Falha ao abrir o portal."); setLoading(false); }
      }
    };
    void load();
    return () => { cancelled = true; controller.abort(); instance?.dispose(); root.replaceChildren(); };
  }, [userId]);
  return <section aria-label="Portal de Pedidos Sfera">
    {loading && <p className="muted" role="status">Carregando portal de pedidos…</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    <div ref={host} />
    <p className="muted">Importações e relatórios deste portal ficam salvos neste navegador, na sua conta do dashboard.</p>
  </section>;
}
