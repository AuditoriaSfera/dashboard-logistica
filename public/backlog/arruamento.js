window.SferaArruamentoMount = function (root) {
  const main = root.querySelector('.portal-root > main');
  if (!main || root.querySelector('#arruamentoView')) return;

  const section = document.createElement('section');
  section.id = 'arruamentoView';
  section.hidden = true;
  section.innerHTML = '<iframe title="Módulo de Arruamento Sfera" src="/backlog/arruamento-site/index.html?dashboard=1" loading="lazy" referrerpolicy="same-origin"></iframe>';
  const footer = main.querySelector('footer');
  if (footer) main.insertBefore(section, footer); else main.appendChild(section);

  const style = document.createElement('style');
  style.textContent = '#arruamentoView{width:100%;min-width:0}#arruamentoView iframe{display:block;width:100%;height:1050px;border:0;background:#f6f8fb}';
  root.appendChild(style);

  const dashboardMenu = root.querySelector('nav [data-view="dashboard"]');
  if (dashboardMenu && !root.querySelector('nav [data-view="arruamento"]')) {
    const button = document.createElement('button');
    button.dataset.view = 'arruamento';
    button.innerHTML = '<span>⌖</span>Arruamento';
    dashboardMenu.after(button);
  }

  window.addEventListener('message', (event) => {
    const frame = section.querySelector('iframe');
    if (!frame || event.source !== frame.contentWindow || event.origin !== window.location.origin || event.data?.type !== 'sfera-arruamento:altura') return;
    const height = event.data.height;
    if (typeof height === 'number' && Number.isFinite(height)) frame.style.height = `${Math.max(800, Math.min(20000, Math.ceil(height)))}px`;
  });
  window.SferaArruamentoRender = () => { section.hidden = false; };
  window.SferaArruamentoAccess = () => {};
};
