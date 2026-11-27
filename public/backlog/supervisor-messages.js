(function () {
  let root = null;
  let state = { canImport: false, orderType: "address", base: { rows: [], stores: {} }, directory: {} };
  let contacts = {};
  let contactsLoaded = false;
  let contactsLoading = false;

  const $ = (selector) => root?.querySelector(selector);
  const regions = ["Regional Regilane", "Regional Guilherme", "Regional Luanna"];
  const coordinators = {
    "Regional Regilane": "Regilane",
    "Regional Guilherme": "Guilherme",
    "Regional Luanna": "Luanna",
  };
  const brazilTime = (value, withTime = true) => new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", dateStyle: "short", ...(withTime ? { timeStyle: "short" } : {}),
  }).format(value ? new Date(value) : new Date());
  const digitsOnly = (value) => String(value || "").replace(/\D/g, "");
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);

  async function loadContacts() {
    if (contactsLoaded || contactsLoading || !state.canImport) return;
    contactsLoading = true;
    try {
      const response = await fetch("/api/portal-supervisors", { cache: "no-store", credentials: "same-origin" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Não foi possível carregar os contatos.");
      contacts = Object.fromEntries((data.contacts || []).map((contact) => [contact.regional, contact]));
      contactsLoaded = true;
      const region = $("#supervisorRegional")?.value;
      if (region && contacts[region]) fillContact(region);
      render();
    } catch (error) {
      if ($("#supervisorContactStatus")) $("#supervisorContactStatus").textContent = error.message || "Falha ao carregar contatos.";
    } finally {
      contactsLoading = false;
    }
  }

  function coordinatorForRegion(region) {
    return coordinators[region] || "";
  }

  function fillContact(region) {
    const saved = contacts[region];
    $("#supervisorName").value = saved?.supervisorName || coordinatorForRegion(region);
    $("#supervisorPhone").value = saved?.phone || "";
    $("#supervisorContactStatus").textContent = saved
      ? `Contato salvo · ${brazilTime(saved.updatedAt)}`
      : "Informe o WhatsApp com DDD. O contato será salvo para os próximos envios.";
  }

  function storeList(region) {
    const stores = new Map();
    for (const [id, item] of Object.entries(state.directory || {})) {
      if (!id.startsWith("pending-") && item.regional === region) stores.set(id, item.unit || state.base.stores?.[id] || id);
    }
    for (const [id, name] of Object.entries(state.base.stores || {})) {
      if (state.directory?.[id]?.regional === region) stores.set(id, state.directory[id].unit || name || id);
    }
    return [...stores].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }

  function backlogByStore(region) {
    const rows = state.base.rows || [];
    return storeList(region).map((store) => {
      const orders = rows.filter((row) => state.isUnbilled(row) && state.code(row.channel) === store.id);
      const delivery = orders.filter((row) => state.matchesType(row, "address")).length;
      const pickup = orders.filter((row) => state.matchesType(row, "pickup")).length;
      const other = orders.length - delivery - pickup;
      const statuses = [...new Set(orders.map((row) => row.status || "Não informado"))].sort((a, b) => a.localeCompare(b, "pt-BR"));
      return {
        ...store, total: orders.length, delivery, pickup, other,
        statusSummary: statuses.length
          ? statuses.map((status) => `${status}: ${orders.filter((row) => (row.status || "Não informado") === status).length}`).join(" · ")
          : "Sem pedidos em aberto",
      };
    });
  }

  function drawImage(region, supervisor, stores) {
    const canvas = $("#supervisorCanvas");
    if (!canvas) return;
    const context = canvas.getContext("2d");
    const width = 1500, header = 220, rowHeight = 72, footer = 58;
    canvas.width = width;
    canvas.height = header + Math.max(1, stores.length) * rowHeight + footer;
    context.fillStyle = "#f3f7fb";
    context.fillRect(0, 0, width, canvas.height);
    context.fillStyle = "#132c42";
    context.fillRect(0, 0, width, 170);
    context.fillStyle = "#70d0ff";
    context.font = "bold 16px Segoe UI, Arial";
    context.fillText("SFERA  /  PORTAL DE PEDIDOS", 38, 38);
    context.fillStyle = "#fff";
    context.font = "bold 32px Segoe UI, Arial";
    context.fillText("Situação do backlog por loja", 38, 88);
    context.font = "17px Segoe UI, Arial";
    context.fillStyle = "#d2e2ed";
    context.fillText(`${region} · Coordenador(a) regional: ${supervisor}`, 38, 126, 1400);
    const importedAt = state.base.importedAt ? brazilTime(state.base.importedAt) : "Sem importação registrada";
    const total = stores.reduce((sum, store) => sum + store.total, 0);
    context.fillText(`Base atualizada em ${importedAt} · ${stores.length} lojas · ${total} pedidos em aberto`, 38, 151, 1400);
    const tableTop = 195;
    context.fillStyle = "#dce8f2";
    context.fillRect(25, tableTop, width - 50, 40);
    context.fillStyle = "#40566b";
    context.font = "bold 12px Segoe UI, Arial";
    context.textAlign = "left";
    [["LOJA", 42], ["EM ABERTO", 610], ["ENTREGA", 760], ["RETIRADA", 885], ["OUTROS", 1010], ["SITUAÇÃO DOS PEDIDOS", 1120]]
      .forEach(([label, x]) => context.fillText(label, x, tableTop + 25));
    let y = header;
    for (const store of stores) {
      context.fillStyle = Math.floor(y / rowHeight) % 2 ? "#fff" : "#f8fbfe";
      context.fillRect(25, y, width - 50, rowHeight);
      context.fillStyle = "#193d5b";
      context.font = "bold 15px Segoe UI, Arial";
      context.textAlign = "left";
      context.fillText(`${store.id} · ${store.name}`, 42, y + 29, 535);
      context.fillStyle = store.total ? "#b3483f" : "#27846f";
      context.font = "bold 17px Segoe UI, Arial";
      context.textAlign = "center";
      context.fillText(String(store.total), 650, y + 31);
      context.fillStyle = "#40566b";
      context.font = "14px Segoe UI, Arial";
      context.fillText(String(store.delivery), 800, y + 31);
      context.fillText(String(store.pickup), 925, y + 31);
      context.fillText(String(store.other), 1050, y + 31);
      context.textAlign = "left";
      context.font = "12px Segoe UI, Arial";
      context.fillStyle = "#60758a";
      context.fillText(store.statusSummary, 1120, y + 29, 330);
      y += rowHeight;
    }
    context.fillStyle = "#718096";
    context.font = "12px Segoe UI, Arial";
    context.textAlign = "left";
    context.fillText(`Gerado em ${brazilTime(new Date())}`, 38, canvas.height - 18);
  }

  function render() {
    if (!root || !state.canImport) return;
    const region = $("#supervisorRegional")?.value || "";
    const supervisor = $("#supervisorName")?.value.trim() || "";
    const stores = region ? backlogByStore(region) : [];
    const total = stores.reduce((sum, store) => sum + store.total, 0);
    const modality = state.orderType === "address" ? "entrega" : state.orderType === "pickup" ? "retirada" : "";
    const importedAt = state.base.importsByType?.[state.orderType]?.importedAt || state.base.importedAt;
    const importedDate = importedAt ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short" }).format(new Date(importedAt)) : "";
    const importedTime = importedAt ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(new Date(importedAt)) : "";
    $("#supervisorSummary").textContent = region
      ? `${stores.length} loja(s) na regional · ${total} pedido(s) em aberto na última base importada.`
      : "Selecione uma regional para visualizar o backlog.";
    $("#supervisorMessage").value = region && supervisor && importedAt
      ? `Backlog dos pedidos${modality ? ` de ${modality}` : ""} do dia ${importedDate} às ${importedTime}.`
      : "";
    $("#supervisorImageTitle").textContent = region ? `Backlog · ${region} · ${stores.length} lojas` : "Situação do backlog";
    if (region) drawImage(region, supervisor || "Supervisor(a)", stores);
    const phone = digitsOnly($("#supervisorPhone")?.value);
    $("#sendSupervisorMessage").disabled = !region || !supervisor || ![10, 11, 12, 13].includes(phone.length) || !stores.length || !state.base.importedAt;
  }

  async function send() {
    if (!state.canImport) return;
    const region = $("#supervisorRegional").value;
    const supervisorName = $("#supervisorName").value.trim();
    const digits = digitsOnly($("#supervisorPhone").value);
    if (!region || !supervisorName || ![10, 11, 12, 13].includes(digits.length) || !state.base.importedAt) return;
    const whatsapp = window.open("about:blank", "_blank");
    if (!whatsapp) {
      window.alert("Permita a abertura de pop-ups para preparar o WhatsApp.");
      return;
    }
    const button = $("#sendSupervisorMessage");
    button.disabled = true;
    try {
      const response = await fetch("/api/portal-supervisors", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", "x-sfera-supervisor-contact": "save" },
        body: JSON.stringify({ regional: region, supervisorName, phone: digits }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Não foi possível salvar o contato.");
      contacts[region] = { ...data.contact, updatedAt: new Date().toISOString() };
      const canvas = $("#supervisorCanvas");
      const image = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!image) throw new Error("Não foi possível gerar a imagem do backlog.");
      let copied = false;
      try {
        if (navigator.clipboard?.write && window.ClipboardItem) {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
          copied = true;
        }
      } catch { /* O download abaixo é o plano alternativo para navegadores sem cópia de imagem. */ }
      if (!copied) {
        const url = URL.createObjectURL(image);
        const link = document.createElement("a");
        link.href = url;
        link.download = `backlog-${region.toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g, "-")}.png`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      const phone = data.contact.phone;
      whatsapp.location.href = `https://wa.me/${phone}?text=${encodeURIComponent($("#supervisorMessage").value)}`;
      $("#supervisorContactStatus").textContent = "Contato salvo para os próximos envios.";
      if (root.SferaToast) root.SferaToast(copied ? "Imagem copiada. Cole no WhatsApp e envie." : "WhatsApp aberto e imagem baixada. Anexe o PNG.");
      else $("#supervisorSummary").textContent = copied
        ? "Imagem copiada. Cole-a no WhatsApp e envie a mensagem."
        : "Imagem baixada. Anexe o PNG no WhatsApp e envie a mensagem.";
    } catch (error) {
      whatsapp.close();
      $("#supervisorContactStatus").textContent = error.message || "Não foi possível preparar a mensagem.";
    } finally {
      render();
    }
  }

  window.SferaSupervisorMessagesMount = function (portalRoot) {
    root = portalRoot;
    $("#supervisorRegional").onchange = () => {
      fillContact($("#supervisorRegional").value);
      render();
    };
    $("#supervisorName").oninput = render;
    $("#supervisorPhone").oninput = render;
    $("#sendSupervisorMessage").onclick = send;
    window.SferaSupervisorMessagesAccess(false);
  };

  window.SferaSupervisorMessagesAccess = function (allowed) {
    if (!root) return;
    state.canImport = Boolean(allowed);
    const nav = $("[data-view=messages]");
    const section = $("#messagesView");
    if (nav) nav.hidden = !state.canImport;
    if (!state.canImport) {
      if (section) section.hidden = true;
      contacts = {};
      contactsLoaded = false;
    } else loadContacts();
  };

  window.SferaSupervisorMessagesUpdate = function (next) {
    state = { ...state, ...next };
    if (state.canImport) render();
  };
})();
