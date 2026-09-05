/* Capas compartilhadas: os dados e o acesso às galerias continuam em dados.js. */
(function () {
    const categoria = document.currentScript.dataset.categoria;
    const container = document.getElementById('grid-sessoes');
    const escapar = valor => String(valor || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    function capaSegura(valor) {
        if (!valor) return '';
        try {
            const url = new URL(valor, document.baseURI);
            return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
        } catch (_) { return ''; }
    }
    async function carregar() {
        container.setAttribute('aria-busy', 'true');
        try {
            const todas = await buscarSessoes();
            const sessoes = todas.filter(s => s.categoria.toLowerCase() === categoria && !s.protegida);
            if (!sessoes.length) {
                container.innerHTML = '<p class="sessoes-status" role="status">Novas sessões em breve.</p>';
                return;
            }
            container.innerHTML = sessoes.map((s, i) => {
                const capa = capaSegura(s.capa);
                const metadados = [s.data, s.local].filter(Boolean).map(v => '<span>' + escapar(v) + '</span>').join('');
                return `<a class="sessao" href="galeria.html?sessao=${encodeURIComponent(s.slug)}">
                    <div class="capa-wrap">
                        ${capa ? `<img src="${escapar(capa)}" alt="" loading="${i < 2 ? 'eager' : 'lazy'}" decoding="async">` : '<span class="capa-indisponivel">Ver fotografias</span>'}
                        ${s.cliente ? `<span class="sessao-cliente">${escapar(s.cliente)}</span>` : ''}
                        <span class="sessao-seta" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18 18 6M6 6h12v12"/></svg></span>
                    </div>
                    <div class="sessao-info">
                        ${metadados ? `<div class="sessao-meta">${metadados}</div>` : ''}
                        <h3>${escapar(s.titulo || s.cliente || 'Sessão de fotos')}</h3>
                        <span class="sessao-abrir">Explorar galeria</span>
                    </div>
                </a>`;
            }).join('');
            container.querySelectorAll('img').forEach(img => {
                img.addEventListener('error', function () {
                    const fallback = document.createElement('span');
                    fallback.className = 'capa-indisponivel';
                    fallback.textContent = 'Ver fotografias';
                    this.replaceWith(fallback);
                }, { once: true });
            });
        } catch (_) {
            container.innerHTML = '<p class="sessoes-status" role="status">Não foi possível carregar as sessões. Tente atualizar a página em instantes.</p>';
        } finally {
            container.setAttribute('aria-busy', 'false');
        }
    }
    carregar();
})();
