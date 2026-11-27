"use client";

import { useEffect, useRef, useState } from "react";

type PortalInstance = { ready: Promise<void>; dispose: () => void };
declare global {
  interface Window {
    SferaBacklogMount?: (root: ShadowRoot, xlsx: unknown, storagePrefix: string) => PortalInstance;
    SferaBacklogView?: (name: string) => void;
    SferaArruamentoMount?: (root: ShadowRoot, xlsx: unknown, canImport: () => boolean) => void;
  }
}

let scriptReady: Promise<void> | null = null;
function loadPortalScript() {
  if (window.SferaBacklogMount) return Promise.resolve();
  if (!scriptReady) scriptReady = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/backlog/portal.js?v=atrasos-so-lojas-20";
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); scriptReady = null; reject(new Error("Não foi possível carregar o portal de pedidos.")); };
    document.head.appendChild(script);
  });
  return scriptReady;
}

let arruamentoScriptReady: Promise<void> | null = null;
function loadArruamentoScript() {
  if (window.SferaArruamentoMount) return Promise.resolve();
  if (!arruamentoScriptReady) arruamentoScriptReady = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/backlog/arruamento.js?v=6";
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); arruamentoScriptReady = null; reject(new Error("Não foi possível carregar o módulo de Arruamento.")); };
    document.head.appendChild(script);
  });
  return arruamentoScriptReady;
}

export function BacklogPortal({ userId, initialView = "orders", xlsx }: { userId: string; initialView?: string; xlsx: unknown }) {
  const host = useRef<HTMLDivElement>(null);
  const initialViewRef = useRef(initialView);
  initialViewRef.current = initialView;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let instance: PortalInstance | undefined;
    const root = host.current!.shadowRoot || host.current!.attachShadow({ mode: "open" });
    const controller = new AbortController();
    const load = async () => {
      try {
        const [markup, styles] = await Promise.all([
          fetch("/backlog/interface.html?v=shared-10", { signal: controller.signal }).then((response) => { if (!response.ok) throw new Error("Falha ao carregar a interface."); return response.text(); }),
          Promise.all([
            fetch("/backlog/style.css?v=shared-10", { signal: controller.signal }).then((response) => { if (!response.ok) throw new Error("Falha ao carregar o visual."); return response.text(); }),
            fetch("/backlog/counted.css?v=shared-10", { signal: controller.signal }).then((response) => { if (!response.ok) throw new Error("Falha ao carregar os estilos de Retirada."); return response.text(); }),
          ]).then(([baseStyles, countedStyles]) => `${baseStyles}\n${countedStyles}`),
          loadPortalScript(), loadArruamentoScript(),
        ]);
        if (cancelled) return;
        root.innerHTML = "";
        const style = document.createElement("style"); style.textContent = styles;
        root.appendChild(style);
        const template = document.createElement("template"); template.innerHTML = markup;
        root.appendChild(template.content.cloneNode(true));
        if (!window.SferaBacklogMount) throw new Error("Portal indisponível. Recarregue a página.");
        instance = window.SferaBacklogMount(root, xlsx, `sfera-portal-${userId}-`);
        window.SferaArruamentoMount?.(root, xlsx, () => (root.querySelector('[data-view="import"]') as HTMLElement | null)?.hidden === false);
        await instance.ready;
        // A navegação do Dashboard pode acontecer enquanto os scripts do Portal
        // ainda estão carregando. Reaplique a seção escolhida depois da montagem.
        if (!cancelled && initialViewRef.current !== "orders") window.SferaBacklogView?.(initialViewRef.current);
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
    <p className="muted">Base compartilhada das últimas importações de retirada e entrega, com acesso às lojas da sua conta. Atualização automática a cada 10 segundos. Relatórios salvos ficam neste navegador.</p>
  </section>;
}
