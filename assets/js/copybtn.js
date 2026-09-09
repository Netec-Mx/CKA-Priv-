// Botón Copiar en bloques de código
(function () {
  const copyIcon  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  const checkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20 6 9 17l-5-5"/></svg>';

  // Ajusta padding-right del <pre> según el ancho real del botón
  function padForButton(pre, btn) {
    if (!pre || !btn) return;
    const btnWidth = Math.ceil(btn.getBoundingClientRect().width);
    const extra = 16; // margen separador
    pre.style.paddingRight = `calc(1rem + ${btnWidth + extra}px)`;
  }

  // Envolver cada <pre><code> con .code-wrap + botón
  document.querySelectorAll('pre > code').forEach(code => {
    const pre = code.parentElement;

    // Omitir si ya está envuelto o marcado como nocopy
    if ((pre.parentElement && pre.parentElement.classList.contains('code-wrap')) ||
        pre.classList.contains('nocopy')) return;

    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.innerHTML = copyIcon + '<span>Copiar</span>';
    wrap.appendChild(btn);

    // Padding inicial (espera al layout)
    requestAnimationFrame(() => padForButton(pre, btn));

    // Recalcular en resize y cuando cambie el contenido del botón
    window.addEventListener('resize', () => padForButton(pre, btn));

    // Si el texto del botón cambia (Copiar/Copiado), actualiza el padding
    const mo = new MutationObserver(() => padForButton(pre, btn));
    mo.observe(btn, { childList: true, subtree: true });

    // Copiar texto del bloque
    const copyText = async (text) => {
      try {
        const value = text.replace(/\s+$/, ''); // recorta salto final
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(value);
        } else {
          const ta = document.createElement('textarea');
          ta.value = value;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        btn.classList.add('copied');
        btn.innerHTML = checkIcon + '<span>Copiado</span>';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = copyIcon + '<span>Copiar</span>';
        }, 1600);
      } catch (e) {
        btn.innerHTML = copyIcon + '<span>Falló</span>';
      }
    };

    btn.addEventListener('click', () => copyText(code.innerText || code.textContent || ''));
  });
})();
